import { createHash, randomUUID } from 'node:crypto';
import { Pool, type PoolClient, type PoolConfig, type QueryResultRow } from 'pg';
import { generateRegulatoryTransactionExport, MAX_LEGACY_ARTIFACT_BYTES } from './generator.js';
import type {
  BatchValidationError,
  CreateRegulatoryExportInput,
  LegacyBatchArtifact,
  LegacyBatchMetrics,
  LegacyBatchReceipt,
  LegacyBatchState,
  RegulatoryTransactionRecord,
  StageLegacyImportInput,
} from './types.js';
import { LegacyBatchConflictError, LegacyBatchSourceRejectedError, LegacyBatchStateError } from './types.js';
import { validateRegulatoryTransactionExport } from './validator.js';

const CONTRACT_ID = 'legacy.regulatory_transaction_export@1' as const;
const LEASE_MILLISECONDS = 5 * 60 * 1_000;

export interface LegacyBatchStore {
  create(receipt: LegacyBatchReceipt, artifact?: LegacyBatchArtifact): Promise<{ receipt: LegacyBatchReceipt; created: boolean }>;
  get(tenantId: string, receiptId: string): Promise<LegacyBatchReceipt | undefined>;
  list(tenantId: string, limit?: number): Promise<LegacyBatchReceipt[]>;
  artifact(tenantId: string, receiptId: string): Promise<LegacyBatchArtifact | undefined>;
  claim(tenantId: string, receiptId: string, leaseUntil: Date): Promise<LegacyBatchReceipt | undefined>;
  complete(
    tenantId: string,
    receiptId: string,
    state: 'GENERATED' | 'VALIDATED' | 'REJECTED',
    result: { sourceCount: number; recordCount: number; totalAmountMinor: string; contentSha256?: string; rejections: BatchValidationError[] },
    artifact?: LegacyBatchArtifact,
  ): Promise<LegacyBatchReceipt>;
  fail(tenantId: string, receiptId: string, reason: string): Promise<LegacyBatchReceipt>;
  deliver(tenantId: string, receiptId: string, authorityReference: string, deliveredAt: Date): Promise<LegacyBatchReceipt>;
  metrics(tenantId: string): Promise<LegacyBatchMetrics>;
  globalMetrics(): Promise<LegacyBatchMetrics>;
  close?(): Promise<void>;
}

export class MemoryLegacyBatchStore implements LegacyBatchStore {
  private readonly receipts = new Map<string, LegacyBatchReceipt>();
  private readonly artifacts = new Map<string, LegacyBatchArtifact>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  async create(receipt: LegacyBatchReceipt, artifact?: LegacyBatchArtifact): Promise<{ receipt: LegacyBatchReceipt; created: boolean }> {
    const existing = [...this.receipts.values()].find((candidate) => candidate.tenant_id === receipt.tenant_id
      && candidate.direction === receipt.direction && candidate.idempotency_key_digest === receipt.idempotency_key_digest);
    if (existing) return { receipt: cloneReceipt(existing), created: false };
    this.receipts.set(receipt.id, cloneReceipt(receipt));
    if (artifact) this.artifacts.set(receipt.id, cloneArtifact(artifact));
    return { receipt: cloneReceipt(receipt), created: true };
  }

  async get(tenantId: string, receiptId: string): Promise<LegacyBatchReceipt | undefined> {
    const receipt = this.receipts.get(receiptId);
    return receipt?.tenant_id === tenantId ? cloneReceipt(receipt) : undefined;
  }

  async list(tenantId: string, limit = 100): Promise<LegacyBatchReceipt[]> {
    return [...this.receipts.values()].filter((receipt) => receipt.tenant_id === tenantId)
      .sort((left, right) => right.created_at.valueOf() - left.created_at.valueOf() || left.id.localeCompare(right.id))
      .slice(0, Math.min(limit, 500)).map(cloneReceipt);
  }

  async artifact(tenantId: string, receiptId: string): Promise<LegacyBatchArtifact | undefined> {
    const artifact = this.artifacts.get(receiptId);
    return artifact?.tenant_id === tenantId ? cloneArtifact(artifact) : undefined;
  }

  async claim(tenantId: string, receiptId: string, leaseUntil: Date): Promise<LegacyBatchReceipt | undefined> {
    const receipt = this.receipts.get(receiptId);
    const now = this.now();
    if (!receipt || receipt.tenant_id !== tenantId || receipt.attempts >= receipt.max_attempts) return undefined;
    if (receipt.state !== 'QUEUED' && !(receipt.state === 'PROCESSING' && receipt.lease_until && receipt.lease_until <= now)) return undefined;
    receipt.state = 'PROCESSING';
    receipt.attempts += 1;
    receipt.lease_until = leaseUntil;
    receipt.updated_at = now;
    return cloneReceipt(receipt);
  }

  async complete(
    tenantId: string, receiptId: string, state: 'GENERATED' | 'VALIDATED' | 'REJECTED',
    result: { sourceCount: number; recordCount: number; totalAmountMinor: string; contentSha256?: string; rejections: BatchValidationError[] },
    artifact?: LegacyBatchArtifact,
  ): Promise<LegacyBatchReceipt> {
    const receipt = required(this.receipts.get(receiptId), tenantId);
    if (receipt.state !== 'PROCESSING') throw new LegacyBatchStateError('Batch is not being processed');
    Object.assign(receipt, {
      state, source_count: result.sourceCount, record_count: result.recordCount,
      total_amount_minor: result.totalAmountMinor, content_sha256: result.contentSha256,
      rejection_report: structuredClone(result.rejections), lease_until: undefined, failure_reason: undefined, updated_at: new Date(),
    });
    if (artifact) this.artifacts.set(receiptId, cloneArtifact(artifact));
    return cloneReceipt(receipt);
  }

  async fail(tenantId: string, receiptId: string, reason: string): Promise<LegacyBatchReceipt> {
    const receipt = required(this.receipts.get(receiptId), tenantId);
    if (receipt.state !== 'PROCESSING') throw new LegacyBatchStateError('Batch is not being processed');
    receipt.state = receipt.attempts >= receipt.max_attempts ? 'FAILED' : 'QUEUED';
    receipt.failure_reason = reason.slice(0, 512);
    receipt.lease_until = undefined;
    receipt.updated_at = new Date();
    return cloneReceipt(receipt);
  }

  async deliver(tenantId: string, receiptId: string, authorityReference: string, deliveredAt: Date): Promise<LegacyBatchReceipt> {
    const receipt = required(this.receipts.get(receiptId), tenantId);
    if (receipt.state !== 'GENERATED' && receipt.state !== 'DELIVERED') throw new LegacyBatchStateError('Only generated batches can be delivered');
    if (receipt.state === 'DELIVERED' && receipt.authority_reference !== authorityReference) {
      throw new LegacyBatchConflictError('Delivery reference differs from the recorded value');
    }
    receipt.state = 'DELIVERED';
    receipt.authority_reference = authorityReference;
    receipt.delivered_at ??= deliveredAt;
    receipt.updated_at = new Date();
    return cloneReceipt(receipt);
  }

  async metrics(tenantId: string): Promise<LegacyBatchMetrics> {
    return metricsFrom((await this.list(tenantId, 500)).values());
  }

  async globalMetrics(): Promise<LegacyBatchMetrics> { return metricsFrom(this.receipts.values()); }
}

export class PostgresLegacyBatchStore implements LegacyBatchStore {
  private readonly pool: Pool;

  constructor(config: string | PoolConfig) {
    this.pool = new Pool(typeof config === 'string' ? { connectionString: withoutSchema(config) } : config);
  }

  async create(receipt: LegacyBatchReceipt, artifact?: LegacyBatchArtifact): Promise<{ receipt: LegacyBatchReceipt; created: boolean }> {
    return this.transaction(receipt.tenant_id, async (client) => {
      const inserted = await client.query(`INSERT INTO legacy_connectors.legacy_batch_receipts
        (id,"tenantId","institutionId",direction,"contractId","idempotencyKeyDigest","requestHash","correlationId","requestedBy",state,request,"sourceCount","recordCount","totalAmountMinor","rejectionReport",attempts,"maxAttempts","createdAt","updatedAt")
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,$15::jsonb,$16,$17,$18,$19)
        ON CONFLICT ("tenantId",direction,"idempotencyKeyDigest") DO NOTHING RETURNING *`, receiptValues(receipt));
      if (inserted.rowCount === 1) {
        if (artifact) await insertArtifact(client, artifact);
        return { receipt: mapReceipt(inserted.rows[0]), created: true };
      }
      const existing = await client.query('SELECT * FROM legacy_connectors.legacy_batch_receipts WHERE "tenantId"=$1 AND direction=$2 AND "idempotencyKeyDigest"=$3', [receipt.tenant_id, receipt.direction, receipt.idempotency_key_digest]);
      return { receipt: mapReceipt(existing.rows[0]), created: false };
    });
  }

  async get(tenantId: string, receiptId: string): Promise<LegacyBatchReceipt | undefined> {
    return this.transaction(tenantId, async (client) => {
      const result = await client.query('SELECT * FROM legacy_connectors.legacy_batch_receipts WHERE id=$1', [receiptId]);
      return result.rowCount ? mapReceipt(result.rows[0]) : undefined;
    });
  }

  async list(tenantId: string, limit = 100): Promise<LegacyBatchReceipt[]> {
    return this.transaction(tenantId, async (client) => {
      const result = await client.query('SELECT * FROM legacy_connectors.legacy_batch_receipts ORDER BY "createdAt" DESC,id ASC LIMIT $1', [Math.min(limit, 500)]);
      return result.rows.map(mapReceipt);
    });
  }

  async artifact(tenantId: string, receiptId: string): Promise<LegacyBatchArtifact | undefined> {
    return this.transaction(tenantId, async (client) => {
      const result = await client.query('SELECT * FROM legacy_connectors.legacy_batch_artifacts WHERE "receiptId"=$1', [receiptId]);
      return result.rowCount ? mapArtifact(result.rows[0]) : undefined;
    });
  }

  async claim(tenantId: string, receiptId: string, leaseUntil: Date): Promise<LegacyBatchReceipt | undefined> {
    return this.transaction(tenantId, async (client) => {
      const result = await client.query(`UPDATE legacy_connectors.legacy_batch_receipts SET state='PROCESSING',attempts=attempts+1,"leaseUntil"=$2,"updatedAt"=CURRENT_TIMESTAMP
        WHERE id=$1 AND attempts < "maxAttempts" AND (state='QUEUED' OR (state='PROCESSING' AND "leaseUntil" <= CURRENT_TIMESTAMP)) RETURNING *`, [receiptId, leaseUntil]);
      return result.rowCount ? mapReceipt(result.rows[0]) : undefined;
    });
  }

  async complete(
    tenantId: string, receiptId: string, state: 'GENERATED' | 'VALIDATED' | 'REJECTED',
    result: { sourceCount: number; recordCount: number; totalAmountMinor: string; contentSha256?: string; rejections: BatchValidationError[] },
    artifact?: LegacyBatchArtifact,
  ): Promise<LegacyBatchReceipt> {
    return this.transaction(tenantId, async (client) => {
      if (artifact) await insertArtifact(client, artifact);
      const updated = await client.query(`UPDATE legacy_connectors.legacy_batch_receipts SET state=$2,"sourceCount"=$3,"recordCount"=$4,"totalAmountMinor"=$5,"contentSha256"=$6,"rejectionReport"=$7::jsonb,"leaseUntil"=NULL,"failureReason"=NULL,"updatedAt"=CURRENT_TIMESTAMP
        WHERE id=$1 AND state='PROCESSING' RETURNING *`, [receiptId, state, result.sourceCount, result.recordCount, result.totalAmountMinor, result.contentSha256 ?? null, JSON.stringify(result.rejections)]);
      if (!updated.rowCount) throw new LegacyBatchStateError('Batch is not being processed');
      await insertAttempt(client, mapReceipt(updated.rows[0]), state === 'REJECTED' ? 'REJECTED' : 'SUCCEEDED');
      return mapReceipt(updated.rows[0]);
    });
  }

  async fail(tenantId: string, receiptId: string, reason: string): Promise<LegacyBatchReceipt> {
    return this.transaction(tenantId, async (client) => {
      const updated = await client.query(`UPDATE legacy_connectors.legacy_batch_receipts SET state=CASE WHEN attempts >= "maxAttempts" THEN 'FAILED' ELSE 'QUEUED' END,"failureReason"=$2,"leaseUntil"=NULL,"updatedAt"=CURRENT_TIMESTAMP
        WHERE id=$1 AND state='PROCESSING' RETURNING *`, [receiptId, reason.slice(0, 512)]);
      if (!updated.rowCount) throw new LegacyBatchStateError('Batch is not being processed');
      await insertAttempt(client, mapReceipt(updated.rows[0]), 'FAILED', reason.slice(0, 128));
      return mapReceipt(updated.rows[0]);
    });
  }

  async deliver(tenantId: string, receiptId: string, authorityReference: string, deliveredAt: Date): Promise<LegacyBatchReceipt> {
    return this.transaction(tenantId, async (client) => {
      const current = await client.query('SELECT * FROM legacy_connectors.legacy_batch_receipts WHERE id=$1 FOR UPDATE', [receiptId]);
      if (!current.rowCount) throw new Error('LEGACY_BATCH_NOT_FOUND');
      const receipt = mapReceipt(current.rows[0]);
      if (receipt.state !== 'GENERATED' && receipt.state !== 'DELIVERED') throw new LegacyBatchStateError('Only generated batches can be delivered');
      if (receipt.state === 'DELIVERED' && receipt.authority_reference !== authorityReference) throw new LegacyBatchConflictError('Delivery reference differs from the recorded value');
      const updated = await client.query(`UPDATE legacy_connectors.legacy_batch_receipts SET state='DELIVERED',"authorityReference"=$2,"deliveredAt"=COALESCE("deliveredAt",$3),"updatedAt"=CURRENT_TIMESTAMP WHERE id=$1 RETURNING *`, [receiptId, authorityReference, deliveredAt]);
      return mapReceipt(updated.rows[0]);
    });
  }

  async metrics(tenantId: string): Promise<LegacyBatchMetrics> {
    return metricsFrom((await this.list(tenantId, 500)).values());
  }

  async globalMetrics(): Promise<LegacyBatchMetrics> {
    const result = await this.pool.query('SELECT * FROM legacy_connectors.legacy_batch_status_totals()');
    const metrics = emptyMetrics();
    for (const row of result.rows) {
      metrics[String(row.state).toLowerCase() as Lowercase<LegacyBatchState>] = Number(row.count);
      metrics.rejection_records += Number(row.rejection_records);
    }
    return metrics;
  }

  async close(): Promise<void> { await this.pool.end(); }

  private async transaction<T>(tenantId: string, operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.current_tenant_id',$1,true)", [tenantId]);
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

export class LegacyBatchManager {
  constructor(private readonly store: LegacyBatchStore, private readonly now: () => Date = () => new Date()) {}

  async requestExport(input: CreateRegulatoryExportInput): Promise<LegacyBatchReceipt> {
    boundedAscii(input.tenant_id, 'tenant_id', 64); boundedAscii(input.institution_id, 'institution_id', 64);
    boundedAscii(input.correlation_id, 'correlation_id', 128); requiredText(input.requested_by, 'requested_by');
    boundedAscii(input.legal_basis_code, 'legal_basis_code', 64);
    const request = {
      period_from: isoDate(input.period_from), period_to: isoDate(input.period_to),
      generated_at: (input.generated_at ? new Date(input.generated_at) : this.now()).toISOString(),
      legal_basis_code: input.legal_basis_code, retention_until: isoDate(input.retention_until),
    };
    if (request.period_from > request.period_to) throw new Error('LEGACY_PERIOD_INVALID');
    if (new Date(`${request.retention_until}T00:00:00.000Z`) < minimumRetention(request.period_to)) {
      throw new Error('LEGACY_RETENTION_PERIOD_TOO_SHORT');
    }
    return this.create(input, 'EXPORT', request, stableHash({ ...request, generated_at: undefined }), undefined);
  }

  async stageImport(input: StageLegacyImportInput): Promise<LegacyBatchReceipt> {
    boundedAscii(input.tenant_id, 'tenant_id', 64); boundedAscii(input.institution_id, 'institution_id', 64);
    boundedAscii(input.correlation_id, 'correlation_id', 128); requiredText(input.requested_by, 'requested_by');
    if (!input.filename || input.filename.length > 255) throw new Error('LEGACY_FILENAME_INVALID');
    if (!input.content.byteLength || input.content.byteLength > MAX_LEGACY_ARTIFACT_BYTES) throw new Error('LEGACY_ARTIFACT_SIZE_LIMIT_EXCEEDED');
    const contentSha256 = digest(input.content);
    const request = { filename: input.filename, byte_length: input.content.byteLength, content_sha256: contentSha256 };
    const receiptId = randomUUID();
    return this.create(input, 'IMPORT', request, stableHash(request), artifact(receiptId, input.tenant_id, input.filename, input.content));
  }

  async processExport(
    tenantId: string,
    receiptId: string,
    source: RegulatoryTransactionRecord[] | (() => Promise<RegulatoryTransactionRecord[]>),
  ): Promise<LegacyBatchReceipt> {
    const claimed = await this.store.claim(tenantId, receiptId, new Date(this.now().valueOf() + LEASE_MILLISECONDS));
    if (!claimed) return this.require(tenantId, receiptId);
    if (claimed.direction !== 'EXPORT') return this.failDirection(claimed);
    try {
      const records = typeof source === 'function' ? await source() : source;
      const request = claimed.request as Record<string, string>;
      const generated = generateRegulatoryTransactionExport({
        export_id: claimed.id, tenant_id: claimed.tenant_id, institution_id: claimed.institution_id,
        period_from: request.period_from, period_to: request.period_to, generated_at: request.generated_at, records,
      });
      return await this.completeOrExisting(tenantId, receiptId, () => this.store.complete(tenantId, receiptId, 'GENERATED', {
        sourceCount: records.length, recordCount: generated.report.record_count,
        totalAmountMinor: generated.report.total_amount_minor, contentSha256: generated.report.content_sha256,
        rejections: [],
      }, artifact(receiptId, tenantId, `regulatory-transactions-${receiptId}.dat`, generated.content)));
    } catch (error) {
      if (error instanceof LegacyBatchSourceRejectedError) {
        const sourceCount = error.sourceCount;
        const rejections = error.rejections;
        return this.completeOrExisting(tenantId, receiptId, () => this.store.complete(tenantId, receiptId, 'REJECTED', {
          sourceCount, recordCount: 0, totalAmountMinor: '0', rejections,
        }));
      }
      await this.failOwned(tenantId, receiptId, errorCode(error));
      throw error;
    }
  }

  async processImport(tenantId: string, receiptId: string): Promise<LegacyBatchReceipt> {
    const claimed = await this.store.claim(tenantId, receiptId, new Date(this.now().valueOf() + LEASE_MILLISECONDS));
    if (!claimed) return this.require(tenantId, receiptId);
    if (claimed.direction !== 'IMPORT') return this.failDirection(claimed);
    try {
      const storedArtifact = await this.store.artifact(tenantId, receiptId);
      if (!storedArtifact) throw new Error('LEGACY_ARTIFACT_NOT_FOUND');
      const report = validateRegulatoryTransactionExport(storedArtifact.content);
      return await this.completeOrExisting(tenantId, receiptId, () => this.store.complete(tenantId, receiptId, report.accepted ? 'VALIDATED' : 'REJECTED', {
        sourceCount: report.record_count, recordCount: report.record_count,
        totalAmountMinor: report.total_amount_minor, contentSha256: report.content_sha256,
        rejections: report.errors,
      }));
    } catch (error) {
      await this.failOwned(tenantId, receiptId, errorCode(error));
      throw error;
    }
  }

  async markDelivered(tenantId: string, receiptId: string, authorityReference: string, deliveredAt = this.now()): Promise<LegacyBatchReceipt> {
    boundedAscii(authorityReference, 'authority_reference', 255);
    if (Number.isNaN(deliveredAt.valueOf())) throw new Error('LEGACY_DELIVERY_TIMESTAMP_INVALID');
    return this.store.deliver(tenantId, receiptId, authorityReference, deliveredAt);
  }

  get(tenantId: string, receiptId: string): Promise<LegacyBatchReceipt | undefined> { return this.store.get(tenantId, receiptId); }
  list(tenantId: string, limit?: number): Promise<LegacyBatchReceipt[]> { return this.store.list(tenantId, limit); }
  getArtifact(tenantId: string, receiptId: string): Promise<LegacyBatchArtifact | undefined> { return this.store.artifact(tenantId, receiptId); }
  metrics(tenantId: string): Promise<LegacyBatchMetrics> { return this.store.metrics(tenantId); }
  globalMetrics(): Promise<LegacyBatchMetrics> { return this.store.globalMetrics(); }

  private async create(
    input: { tenant_id: string; institution_id: string; idempotency_key: string; correlation_id: string; requested_by: string },
    direction: 'EXPORT' | 'IMPORT', request: Record<string, unknown>, requestHash: string, stagedArtifact?: LegacyBatchArtifact,
  ): Promise<LegacyBatchReceipt> {
    boundedAscii(input.idempotency_key, 'idempotency_key', 255);
    const now = this.now();
    const id = stagedArtifact?.receipt_id ?? randomUUID();
    const receipt: LegacyBatchReceipt = {
      id, tenant_id: input.tenant_id, institution_id: input.institution_id, direction, contract_id: CONTRACT_ID,
      idempotency_key_digest: digest(input.idempotency_key), request_hash: requestHash,
      correlation_id: input.correlation_id, requested_by: input.requested_by, state: 'QUEUED', request,
      source_count: 0, record_count: 0, total_amount_minor: '0', rejection_report: [], attempts: 0,
      max_attempts: 3, created_at: now, updated_at: now,
    };
    const result = await this.store.create(receipt, stagedArtifact);
    if (!result.created && result.receipt.request_hash !== requestHash) {
      throw new LegacyBatchConflictError('Idempotency key was already used with a different request');
    }
    return result.receipt;
  }

  private async require(tenantId: string, receiptId: string): Promise<LegacyBatchReceipt> {
    const receipt = await this.store.get(tenantId, receiptId);
    if (!receipt) throw new Error('LEGACY_BATCH_NOT_FOUND');
    return receipt;
  }

  private async completeOrExisting(
    tenantId: string,
    receiptId: string,
    complete: () => Promise<LegacyBatchReceipt>,
  ): Promise<LegacyBatchReceipt> {
    try {
      return await complete();
    } catch (error) {
      if (!(error instanceof LegacyBatchStateError)) throw error;
      const current = await this.require(tenantId, receiptId);
      if (current.state === 'GENERATED' || current.state === 'VALIDATED' || current.state === 'REJECTED' || current.state === 'DELIVERED') {
        return current;
      }
      throw error;
    }
  }

  private async failOwned(tenantId: string, receiptId: string, reason: string): Promise<void> {
    try {
      await this.store.fail(tenantId, receiptId, reason);
    } catch (error) {
      if (!(error instanceof LegacyBatchStateError)) throw error;
    }
  }

  private async failDirection(receipt: LegacyBatchReceipt): Promise<never> {
    await this.store.fail(receipt.tenant_id, receipt.id, 'LEGACY_BATCH_DIRECTION_INVALID');
    throw new LegacyBatchStateError('Batch direction is invalid for this processor');
  }
}

function artifact(receiptId: string, tenantId: string, filename: string, content: Buffer): LegacyBatchArtifact {
  return {
    id: randomUUID(), tenant_id: tenantId, receipt_id: receiptId, filename, media_type: 'text/plain',
    byte_length: content.byteLength, content_sha256: digest(content), content: Buffer.from(content), created_at: new Date(),
  };
}

function receiptValues(receipt: LegacyBatchReceipt): unknown[] {
  return [receipt.id, receipt.tenant_id, receipt.institution_id, receipt.direction, receipt.contract_id,
    receipt.idempotency_key_digest, receipt.request_hash, receipt.correlation_id, receipt.requested_by, receipt.state,
    JSON.stringify(receipt.request), receipt.source_count, receipt.record_count, receipt.total_amount_minor,
    JSON.stringify(receipt.rejection_report), receipt.attempts, receipt.max_attempts, receipt.created_at, receipt.updated_at];
}

async function insertArtifact(client: PoolClient, value: LegacyBatchArtifact): Promise<void> {
  await client.query(`INSERT INTO legacy_connectors.legacy_batch_artifacts
    (id,"tenantId","receiptId",filename,"mediaType","byteLength","contentSha256",content,"createdAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    ON CONFLICT ("receiptId") DO NOTHING`, [value.id, value.tenant_id, value.receipt_id, value.filename, value.media_type,
    value.byte_length, value.content_sha256, value.content, value.created_at]);
}

async function insertAttempt(client: PoolClient, receipt: LegacyBatchReceipt, result: string, errorCodeValue?: string): Promise<void> {
  await client.query(`INSERT INTO legacy_connectors.legacy_batch_attempts (id,"tenantId","receiptId",attempt,result,"errorCode") VALUES ($1,$2,$3,$4,$5,$6)
    ON CONFLICT ("receiptId",attempt) DO NOTHING`, [randomUUID(), receipt.tenant_id, receipt.id, receipt.attempts, result, errorCodeValue ?? null]);
}

function mapReceipt(row: QueryResultRow): LegacyBatchReceipt {
  return {
    id: row.id, tenant_id: row.tenantId, institution_id: row.institutionId, direction: row.direction,
    contract_id: row.contractId, idempotency_key_digest: row.idempotencyKeyDigest, request_hash: row.requestHash,
    correlation_id: row.correlationId, requested_by: row.requestedBy, state: row.state, request: row.request,
    source_count: row.sourceCount, record_count: row.recordCount, total_amount_minor: row.totalAmountMinor,
    content_sha256: row.contentSha256 ?? undefined, rejection_report: row.rejectionReport, attempts: row.attempts,
    max_attempts: row.maxAttempts, lease_until: row.leaseUntil ?? undefined, delivered_at: row.deliveredAt ?? undefined,
    authority_reference: row.authorityReference ?? undefined, failure_reason: row.failureReason ?? undefined,
    created_at: row.createdAt, updated_at: row.updatedAt,
  };
}

function mapArtifact(row: QueryResultRow): LegacyBatchArtifact {
  return { id: row.id, tenant_id: row.tenantId, receipt_id: row.receiptId, filename: row.filename,
    media_type: row.mediaType, byte_length: row.byteLength, content_sha256: row.contentSha256,
    content: Buffer.from(row.content), created_at: row.createdAt };
}

function required(receipt: LegacyBatchReceipt | undefined, tenantId: string): LegacyBatchReceipt {
  if (!receipt || receipt.tenant_id !== tenantId) throw new Error('LEGACY_BATCH_NOT_FOUND');
  return receipt;
}

function cloneReceipt(receipt: LegacyBatchReceipt): LegacyBatchReceipt {
  return structuredClone(receipt);
}

function cloneArtifact(value: LegacyBatchArtifact): LegacyBatchArtifact {
  return { ...structuredClone(value), content: Buffer.from(value.content) };
}

function metricsFrom(receipts: IterableIterator<LegacyBatchReceipt>): LegacyBatchMetrics {
  const metrics = emptyMetrics();
  for (const receipt of receipts) {
    metrics[receipt.state.toLowerCase() as Lowercase<LegacyBatchState>] += 1;
    metrics.rejection_records += receipt.rejection_report.length;
  }
  return metrics;
}

function emptyMetrics(): LegacyBatchMetrics {
  return { queued: 0, processing: 0, generated: 0, validated: 0, rejected: 0, failed: 0, delivered: 0, rejection_records: 0 };
}

function stableHash(value: unknown): string { return digest(JSON.stringify(sortValue(value))); }
function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([, nested]) => nested !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, nested]) => [key, sortValue(nested)]));
  return value;
}
function digest(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex'); }
function requiredText(value: string, field: string): void { if (!value?.trim()) throw new Error(`LEGACY_REQUIRED:${field}`); }
function boundedAscii(value: string, field: string, maxLength: number): void {
  requiredText(value, field);
  if (value.length > maxLength) throw new Error(`LEGACY_FIELD_TOO_LONG:${field}`);
  if (!/^[\x20-\x7e]+$/.test(value)) throw new Error(`LEGACY_NON_ASCII_FIELD:${field}`);
}
function isoDate(value: string): string { if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('LEGACY_DATE_INVALID'); return value; }
function minimumRetention(periodTo: string): Date {
  const date = new Date(`${periodTo}T00:00:00.000Z`);
  date.setUTCFullYear(date.getUTCFullYear() + 10);
  return date;
}
function errorCode(error: unknown): string { return error instanceof Error ? error.message : 'LEGACY_BATCH_PROCESSING_FAILED'; }
function withoutSchema(connectionString: string): string { const url = new URL(connectionString); url.searchParams.delete('schema'); return url.toString(); }
