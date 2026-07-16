import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  LegacyBatchConflictError,
  LegacyBatchManager,
  LegacyBatchSourceRejectedError,
  LegacyBatchStateError,
  MemoryLegacyBatchStore,
  generateRegulatoryTransactionExport,
} from '../dist/index.js';

const fixture = readFileSync('contracts/regulatory-transaction-export/v1/examples/regulatory-transaction-export.v1.dat');
const now = new Date('2026-08-01T08:00:00.000Z');

const record = {
  record_id: 'regtxn_demo_001', transaction_id: 'txn_payment_demo_001', transaction_type: 'LOAN_PAYMENT',
  instruction_method: 'BATCH', source_party_id: 'customer_demo_001', source_account_id: 'account_demo_001',
  destination_party_id: 'institution_demo_001', destination_account_id: 'loan_demo_001',
  counterparty_id: 'institution_demo_001', amount_minor: '12000000', currency: 'MZN',
  occurred_at: '2026-07-15T12:00:00.000Z', recorded_at: '2026-07-15T12:00:01.000Z',
  correlation_id: 'corr_regtxn_demo_001', retention_until: '2036-07-15',
  legal_basis_code: 'MZ-AML-14-2023-ART-43',
};

const exportInput = {
  tenant_id: 'tenant_demo_001', institution_id: 'institution_demo_001', idempotency_key: 'idem-export-1',
  correlation_id: 'corr-export-1', requested_by: 'operator-1', period_from: '2026-07-01', period_to: '2026-07-31',
  generated_at: now.toISOString(), legal_basis_code: 'MZ-AML-14-2023-ART-43', retention_until: '2036-07-31',
};

test('generates the canonical fixed-width export deterministically', () => {
  const generated = generateRegulatoryTransactionExport({
    export_id: 'export_demo_001', tenant_id: exportInput.tenant_id, institution_id: exportInput.institution_id,
    period_from: exportInput.period_from, period_to: exportInput.period_to, generated_at: now.toISOString(), records: [record],
  });
  assert.deepEqual(generated.content, fixture);
  assert.equal(generated.report.accepted, true);
});

test('creates and replays export receipts without retaining the raw idempotency key', async () => {
  const manager = new LegacyBatchManager(new MemoryLegacyBatchStore(), () => now);
  const created = await manager.requestExport(exportInput);
  const replayed = await manager.requestExport(exportInput);
  assert.equal(replayed.id, created.id);
  assert.notEqual(created.idempotency_key_digest, exportInput.idempotency_key);
  assert.equal(created.state, 'QUEUED');
});

test('rejects divergent reuse of an idempotency key', async () => {
  const manager = new LegacyBatchManager(new MemoryLegacyBatchStore(), () => now);
  await manager.requestExport(exportInput);
  await assert.rejects(() => manager.requestExport({
    ...exportInput, period_to: '2026-08-31', retention_until: '2036-08-31',
  }), LegacyBatchConflictError);
});

test('rejects regulatory retention shorter than ten years', async () => {
  const manager = new LegacyBatchManager(new MemoryLegacyBatchStore(), () => now);
  await assert.rejects(() => manager.requestExport({ ...exportInput, retention_until: '2036-07-30' }), /RETENTION_PERIOD_TOO_SHORT/);
});

test('records deterministic source rejections without retrying the batch', async () => {
  const manager = new LegacyBatchManager(new MemoryLegacyBatchStore(), () => now);
  const receipt = await manager.requestExport({ ...exportInput, idempotency_key: 'idem-source-rejection' });
  const rejected = await manager.processExport(receipt.tenant_id, receipt.id, async () => {
    throw new LegacyBatchSourceRejectedError([
      { record: 1, field: 'destination_account_id', code: 'REQUIRED_SOURCE_FIELD_MISSING', reference: 'txn_001' },
    ], 1);
  });
  assert.equal(rejected.state, 'REJECTED');
  assert.equal(rejected.attempts, 1);
  assert.deepEqual(rejected.rejection_report, [
    { record: 1, field: 'destination_account_id', code: 'REQUIRED_SOURCE_FIELD_MISSING', reference: 'txn_001' },
  ]);
});

test('generates, stores and marks an export delivered idempotently', async () => {
  const manager = new LegacyBatchManager(new MemoryLegacyBatchStore(), () => now);
  const receipt = await manager.requestExport(exportInput);
  const generated = await manager.processExport(receipt.tenant_id, receipt.id, [record]);
  assert.equal(generated.state, 'GENERATED');
  assert.equal(generated.record_count, 1);
  const artifact = await manager.getArtifact(receipt.tenant_id, receipt.id);
  assert.match(artifact.content_sha256, /^[a-f0-9]{64}$/);
  assert.match(generated.content_sha256, /^[a-f0-9]{64}$/);
  const delivered = await manager.markDelivered(receipt.tenant_id, receipt.id, 'BM-2026-0001');
  assert.equal(delivered.state, 'DELIVERED');
  assert.equal((await manager.markDelivered(receipt.tenant_id, receipt.id, 'BM-2026-0001')).id, receipt.id);
  await assert.rejects(() => manager.markDelivered(receipt.tenant_id, receipt.id, 'BM-2026-0002'), LegacyBatchConflictError);
});

test('validates imports without producing financial effects', async () => {
  const manager = new LegacyBatchManager(new MemoryLegacyBatchStore(), () => now);
  const staged = await manager.stageImport({
    tenant_id: exportInput.tenant_id, institution_id: exportInput.institution_id, idempotency_key: 'idem-import-1',
    correlation_id: 'corr-import-1', requested_by: 'operator-1', filename: 'incoming.dat', content: fixture,
  });
  const validated = await manager.processImport(staged.tenant_id, staged.id);
  assert.equal(validated.state, 'VALIDATED');
  assert.equal(validated.record_count, 1);
});

test('persists deterministic import rejections', async () => {
  const manager = new LegacyBatchManager(new MemoryLegacyBatchStore(), () => now);
  const staged = await manager.stageImport({
    tenant_id: exportInput.tenant_id, institution_id: exportInput.institution_id, idempotency_key: 'idem-import-invalid',
    correlation_id: 'corr-import-invalid', requested_by: 'operator-1', filename: 'invalid.dat', content: Buffer.from('invalid\n'),
  });
  const rejected = await manager.processImport(staged.tenant_id, staged.id);
  assert.equal(rejected.state, 'REJECTED');
  assert.ok(rejected.rejection_report.length > 0);
  assert.equal((await manager.metrics(staged.tenant_id)).rejected, 1);
});

test('leases a batch once and prevents invalid processors', async () => {
  const manager = new LegacyBatchManager(new MemoryLegacyBatchStore(), () => now);
  const receipt = await manager.requestExport(exportInput);
  const [left, right] = await Promise.all([
    manager.processExport(receipt.tenant_id, receipt.id, [record]),
    manager.processExport(receipt.tenant_id, receipt.id, [record]),
  ]);
  assert.ok([left.state, right.state].includes('GENERATED'));
  const staged = await manager.stageImport({
    tenant_id: exportInput.tenant_id, institution_id: exportInput.institution_id, idempotency_key: 'idem-wrong-direction',
    correlation_id: 'corr-wrong-direction', requested_by: 'operator-1', filename: 'incoming.dat', content: fixture,
  });
  await assert.rejects(() => manager.processExport(staged.tenant_id, staged.id, [record]), LegacyBatchStateError);
});
