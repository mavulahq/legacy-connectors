import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BatchValidationReport, RegulatoryTransactionRecord } from './types.js';
import { validateRegulatoryTransactionExport } from './validator.js';

interface Field { name: string; offset: number; length: number; type: string; value?: string }
interface Layout { record_length: number; records: Record<string, { fields: Field[] }> }

const layout = JSON.parse(readFileSync(join(__dirname, '../contracts/regulatory-transaction-export/v1/layout.json'), 'utf8')) as Layout;
export const MAX_LEGACY_BATCH_RECORDS = 5_000;
export const MAX_LEGACY_ARTIFACT_BYTES = 10 * 1024 * 1024;

export interface GenerateRegulatoryExportInput {
  export_id: string;
  tenant_id: string;
  institution_id: string;
  period_from: string;
  period_to: string;
  generated_at: string;
  records: RegulatoryTransactionRecord[];
}

export interface GeneratedRegulatoryExport {
  content: Buffer;
  report: BatchValidationReport;
}

export function generateRegulatoryTransactionExport(input: GenerateRegulatoryExportInput): GeneratedRegulatoryExport {
  if (input.records.length > MAX_LEGACY_BATCH_RECORDS) throw new Error('LEGACY_BATCH_RECORD_LIMIT_EXCEEDED');
  const records = [...input.records].sort((left, right) => left.record_id.localeCompare(right.record_id));
  const header = formatRecord('H', {
    layout_id: 'MAVULA-REGULATORY-TRANSACTION', layout_version: '001', export_id: input.export_id,
    tenant_id: input.tenant_id, institution_id: input.institution_id, period_from: date(input.period_from),
    period_to: date(input.period_to), generated_at: timestamp(input.generated_at),
  });
  const details = records.map((record) => formatRecord('D', {
    ...record,
    amount: record.amount_minor,
    occurred_at: timestamp(record.occurred_at),
    recorded_at: timestamp(record.recorded_at),
    retention_until: date(record.retention_until),
  }));
  const total = records.reduce((sum, record) => sum + unsigned(record.amount_minor, 'amount_minor'), 0n);
  const hashScope = [header, ...details].join('\n');
  const digest = createHash('sha256').update(hashScope, 'ascii').digest('hex');
  const trailer = formatRecord('T', {
    record_count: String(records.length), total_amount: total.toString(), content_sha256: digest, export_id: input.export_id,
  });
  const content = Buffer.from(`${hashScope}\n${trailer}\n`, 'ascii');
  if (content.byteLength > MAX_LEGACY_ARTIFACT_BYTES) throw new Error('LEGACY_ARTIFACT_SIZE_LIMIT_EXCEEDED');
  const report = validateRegulatoryTransactionExport(content);
  if (!report.accepted) throw new Error(`GENERATED_EXPORT_INVALID:${report.errors.map((error) => error.code).join(',')}`);
  return { content, report };
}

function formatRecord(recordType: string, values: Record<string, unknown>): string {
  const definition = layout.records[recordType];
  const output = Array(layout.record_length).fill(' ');
  for (const field of definition.fields) {
    let value = field.type === 'literal' ? field.value! : String(values[field.name] ?? '');
    if (field.type === 'spaces') value = '';
    assertAscii(value, field.name);
    if (value.length > field.length) throw new Error(`LEGACY_FIELD_TOO_LONG:${field.name}`);
    if (field.type === 'unsigned' || field.type === 'money_minor') {
      unsigned(value, field.name);
      value = value.padStart(field.length, '0');
    } else {
      value = value.padEnd(field.length, ' ');
    }
    for (let index = 0; index < field.length; index += 1) output[field.offset - 1 + index] = value[index];
  }
  return output.join('');
}

function timestamp(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) throw new Error('LEGACY_TIMESTAMP_INVALID');
  return parsed.toISOString().replace(/[-:]/g, '').replace('.', '');
}

function date(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('LEGACY_DATE_INVALID');
  return value.replaceAll('-', '');
}

function unsigned(value: string, field: string): bigint {
  if (!/^\d+$/.test(value)) throw new Error(`LEGACY_UNSIGNED_INVALID:${field}`);
  return BigInt(value);
}

function assertAscii(value: string, field: string): void {
  if ([...value].some((character) => character.charCodeAt(0) < 0x20 || character.charCodeAt(0) > 0x7e)) {
    throw new Error(`LEGACY_NON_ASCII_FIELD:${field}`);
  }
}
