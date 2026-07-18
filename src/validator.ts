import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BatchValidationError, BatchValidationReport } from './types.js';

interface Field { name: string; offset: number; length: number; type: string; value?: string }
interface Layout { contract_id: string; record_length: number; records: Record<string, { fields: Field[] }> }

const layout = JSON.parse(readFileSync(join(__dirname, '../contracts/regulatory-transaction-export/v1/layout.json'), 'utf8')) as Layout;

export function validateRegulatoryTransactionExport(content: Buffer | string): BatchValidationReport {
  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
  const errors: BatchValidationError[] = [];
  if ([...buffer].some((byte) => byte !== 0x0a && (byte < 0x20 || byte > 0x7e))) {
    errors.push({ record: 0, field: 'file', code: 'NON_ASCII_CONTENT' });
  }
  const text = buffer.toString('ascii');
  const lines = text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n');
  if (lines.length < 2) errors.push({ record: 0, field: 'file', code: 'HEADER_AND_TRAILER_REQUIRED' });
  if (lines[0]?.[0] !== 'H') errors.push({ record: 1, field: 'record_type', code: 'HEADER_REQUIRED' });
  if (lines.at(-1)?.[0] !== 'T') errors.push({ record: lines.length, field: 'record_type', code: 'TRAILER_REQUIRED' });

  const parsed = lines.map((line, index) => parseRecord(line, index + 1, errors));
  const header = parsed[0] || {};
  const trailer = parsed.at(-1) || {};
  const details = parsed.slice(1, -1);
  const detailLines = lines.slice(1, -1);
  const seen = new Set<string>();
  for (let index = 0; index < details.length; index += 1) {
    const detail = details[index];
    if (lines[index + 1]?.[0] !== 'D') errors.push({ record: index + 2, field: 'record_type', code: 'DETAIL_REQUIRED' });
    if (detail.record_id && seen.has(detail.record_id)) errors.push({ record: index + 2, field: 'record_id', code: 'DUPLICATE_RECORD_ID' });
    if (detail.record_id) seen.add(detail.record_id);
  }

  const total = details.reduce((sum, detail) => sum + numeric(detail.amount), 0n);
  const hashScope = [lines[0], ...detailLines].join('\n');
  const digest = createHash('sha256').update(hashScope, 'ascii').digest('hex');
  if (header.layout_id !== 'MAVULA-REGULATORY-TRANSACTION') errors.push({ record: 1, field: 'layout_id', code: 'LAYOUT_ID_INVALID' });
  if (header.layout_version !== '001') errors.push({ record: 1, field: 'layout_version', code: 'LAYOUT_VERSION_UNSUPPORTED' });
  if (trailer.export_id !== header.export_id) errors.push({ record: lines.length, field: 'export_id', code: 'EXPORT_ID_MISMATCH' });
  if (numeric(trailer.record_count) !== BigInt(details.length)) errors.push({ record: lines.length, field: 'record_count', code: 'RECORD_COUNT_MISMATCH' });
  if (numeric(trailer.total_amount) !== total) errors.push({ record: lines.length, field: 'total_amount', code: 'TOTAL_AMOUNT_MISMATCH' });
  if (trailer.content_sha256 !== digest) errors.push({ record: lines.length, field: 'content_sha256', code: 'CHECKSUM_MISMATCH' });

  errors.sort((left, right) => left.record - right.record || bytewiseCompare(left.field, right.field) || bytewiseCompare(left.code, right.code));
  return {
    contract_id: layout.contract_id,
    accepted: errors.length === 0,
    export_id: header.export_id,
    record_count: details.length,
    total_amount_minor: total.toString(),
    content_sha256: digest,
    errors,
  };
}

function parseRecord(line: string, record: number, errors: BatchValidationError[]): Record<string, string> {
  if (line.length !== layout.record_length) {
    errors.push({ record, field: 'record', code: 'INVALID_RECORD_LENGTH' });
  }
  const recordType = line[0];
  const definition = layout.records[recordType];
  if (!definition) {
    errors.push({ record, field: 'record_type', code: 'UNKNOWN_RECORD_TYPE' });
    return {};
  }
  const output: Record<string, string> = {};
  for (const field of definition.fields) {
    const raw = line.slice(field.offset - 1, field.offset - 1 + field.length);
    const value = raw.trimEnd();
    output[field.name] = value;
    validateField(field, raw, value, record, errors);
  }
  return output;
}

function validateField(field: Field, raw: string, value: string, record: number, errors: BatchValidationError[]): void {
  const fail = (code: string) => errors.push({ record, field: field.name, code });
  if (field.type === 'literal' && value !== field.value) fail('LITERAL_MISMATCH');
  else if (field.type === 'spaces' && !/^ *$/.test(raw)) fail('RESERVED_NOT_BLANK');
  else if (field.type === 'unsigned' && !/^\d+$/.test(raw)) fail('UNSIGNED_INVALID');
  else if (field.type === 'money_minor' && !/^\d+$/.test(raw)) fail('MONEY_INVALID');
  else if (field.type === 'currency' && !/^[A-Z]{3}$/.test(raw)) fail('CURRENCY_INVALID');
  else if (field.type === 'date_yyyymmdd' && !validCompactDate(raw)) fail('DATE_INVALID');
  else if (field.type === 'timestamp' && !validCompactTimestamp(value)) fail('TIMESTAMP_INVALID');
  else if (field.type === 'sha256' && !/^[a-f0-9]{64}$/.test(raw)) fail('SHA256_INVALID');
  else if (field.type === 'text' && value.length === 0) fail('TEXT_REQUIRED');
}

function numeric(value: string | undefined): bigint {
  return /^\d+$/.test(value || '') ? BigInt(value!) : 0n;
}

function bytewiseCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validCompactDate(value: string): boolean {
  if (!/^\d{8}$/.test(value)) return false;
  const iso = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
  const parsed = new Date(`${iso}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === iso;
}

function validCompactTimestamp(value: string): boolean {
  if (!/^\d{8}T\d{9}Z$/.test(value) || !validCompactDate(value.slice(0, 8))) return false;
  const time = value.slice(9, 18);
  const iso = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}.${time.slice(6, 9)}Z`;
  const parsed = new Date(iso);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === iso;
}
