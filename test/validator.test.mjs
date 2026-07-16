import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateRegulatoryTransactionExport } from '../dist/index.js';

const fixture = readFileSync('contracts/regulatory-transaction-export/v1/examples/regulatory-transaction-export.v1.dat');

test('accepts the canonical regulatory export golden file', () => {
  assert.deepEqual(validateRegulatoryTransactionExport(fixture), {
    contract_id: 'legacy.regulatory_transaction_export@1',
    accepted: true,
    export_id: 'export_demo_001',
    record_count: 1,
    total_amount_minor: '12000000',
    content_sha256: 'abdeb8ae44eb84cb35de311869aafd31740713ce8822f403fbc47b49f2e616da',
    errors: [],
  });
});

test('reports deterministic checksum, count and duplicate failures', () => {
  const source = fixture.toString('ascii');
  const lines = source.slice(0, -1).split('\n');
  const invalid = `${lines[0]}\n${lines[1]}\n${lines[1]}\n${lines[2]}\n`;
  const report = validateRegulatoryTransactionExport(invalid);
  assert.equal(report.accepted, false);
  assert.deepEqual(report.errors.map((error) => error.code), [
    'DUPLICATE_RECORD_ID', 'CHECKSUM_MISMATCH', 'RECORD_COUNT_MISMATCH', 'TOTAL_AMOUNT_MISMATCH',
  ]);
});

test('rejects invalid width and non-ASCII bytes', () => {
  const report = validateRegulatoryTransactionExport(Buffer.concat([fixture.subarray(0, 100), Buffer.from([0xc3, 0xa9])]));
  assert.equal(report.accepted, false);
  assert.ok(report.errors.some((error) => error.code === 'NON_ASCII_CONTENT'));
  assert.ok(report.errors.some((error) => error.code === 'INVALID_RECORD_LENGTH'));
});
