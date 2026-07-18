export interface BatchValidationError {
  record: number;
  field: string;
  code: string;
  reference?: string;
}

export interface BatchValidationReport {
  contract_id: string;
  accepted: boolean;
  export_id?: string;
  record_count: number;
  total_amount_minor: string;
  content_sha256?: string;
  errors: BatchValidationError[];
}

export type LegacyBatchDirection = 'EXPORT' | 'IMPORT';
export type LegacyBatchState =
  | 'QUEUED'
  | 'PROCESSING'
  | 'GENERATED'
  | 'VALIDATED'
  | 'REJECTED'
  | 'FAILED'
  | 'DELIVERED';

export interface RegulatoryTransactionRecord {
  record_id: string;
  transaction_id: string;
  transaction_type: string;
  instruction_method: string;
  source_party_id: string;
  source_account_id: string;
  destination_party_id: string;
  destination_account_id: string;
  counterparty_id: string;
  amount_minor: string;
  currency: string;
  occurred_at: string;
  recorded_at: string;
  correlation_id: string;
  retention_until: string;
  legal_basis_code: string;
  adjustment_type?: string;
  original_transaction_id?: string;
  reversal_transaction_id?: string;
  replacement_transaction_id?: string;
}

export interface CreateRegulatoryExportInput {
  tenant_id: string;
  institution_id: string;
  idempotency_key: string;
  correlation_id: string;
  requested_by: string;
  period_from: string;
  period_to: string;
  generated_at?: string;
  legal_basis_code: string;
  retention_until: string;
}

export interface StageLegacyImportInput {
  tenant_id: string;
  institution_id: string;
  idempotency_key: string;
  correlation_id: string;
  requested_by: string;
  filename: string;
  content: Buffer;
}

export interface LegacyBatchArtifact {
  id: string;
  tenant_id: string;
  receipt_id: string;
  filename: string;
  media_type: 'text/plain';
  byte_length: number;
  content_sha256: string;
  content: Buffer;
  created_at: Date;
}

export interface LegacyBatchReceipt {
  id: string;
  tenant_id: string;
  institution_id: string;
  direction: LegacyBatchDirection;
  contract_id: 'legacy.regulatory_transaction_export@1';
  idempotency_key_digest: string;
  request_hash: string;
  correlation_id: string;
  requested_by: string;
  state: LegacyBatchState;
  request: Record<string, unknown>;
  source_count: number;
  record_count: number;
  total_amount_minor: string;
  content_sha256?: string;
  rejection_report: BatchValidationError[];
  attempts: number;
  max_attempts: number;
  lease_until?: Date;
  lease_token?: string;
  delivered_at?: Date;
  authority_reference?: string;
  delivery_idempotency_key_digest?: string;
  delivery_request_hash?: string;
  failure_reason?: string;
  created_at: Date;
  updated_at: Date;
}

export interface RecordExportDeliveryInput {
  tenant_id: string;
  receipt_id: string;
  institution_id: string;
  idempotency_key: string;
  correlation_id: string;
  requested_by: string;
  authority_reference: string;
  delivered_at?: string;
}

export interface LegacyBatchMetrics {
  queued: number;
  processing: number;
  generated: number;
  validated: number;
  rejected: number;
  failed: number;
  delivered: number;
  rejection_records: number;
}

export class LegacyBatchConflictError extends Error {
  readonly code = 'IDEMPOTENCY_KEY_REUSED';
}

export class LegacyBatchStateError extends Error {
  readonly code = 'INVALID_BATCH_STATE';
}

export class LegacyBatchSourceRejectedError extends Error {
  readonly code = 'LEGACY_SOURCE_REJECTED';
  constructor(readonly rejections: BatchValidationError[], readonly sourceCount: number) {
    super('Regulatory source records were rejected');
  }
}
