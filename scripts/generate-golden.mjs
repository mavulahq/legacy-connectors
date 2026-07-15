import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';

const width = 2048;
const header = record([
  ['H', 1], ['MAVULA-REGULATORY-TRANSACTION', 32], ['001', 3], ['export_demo_001', 64],
  ['tenant_demo_001', 64], ['institution_demo_001', 64], ['20260701', 8], ['20260731', 8],
  ['20260801T080000000Z', 20],
]);
const detail = record([
  ['D', 1], ['regtxn_demo_001', 64], ['txn_payment_demo_001', 64], ['LOAN_PAYMENT', 32], ['BATCH', 8],
  ['customer_demo_001', 64], ['account_demo_001', 64], ['institution_demo_001', 64], ['loan_demo_001', 64],
  ['institution_demo_001', 64], ['000000000012000000', 18], ['MZN', 3], ['20260715T120000000Z', 20],
  ['20260715T120001000Z', 20], ['corr_regtxn_demo_001', 64], ['20360715', 8], ['MZ-AML-14-2023-ART-43', 64],
  ['', 10], ['', 64], ['', 64], ['', 64],
]);
const digest = createHash('sha256').update(`${header}\n${detail}`, 'ascii').digest('hex');
const trailer = record([
  ['T', 1], ['0000000001', 10], ['00000000000012000000', 20], [digest, 64], ['export_demo_001', 64],
]);
mkdirSync('contracts/regulatory-transaction-export/v1/examples', { recursive: true });
writeFileSync('contracts/regulatory-transaction-export/v1/examples/regulatory-transaction-export.v1.dat', `${header}\n${detail}\n${trailer}\n`, 'ascii');

function record(fields) {
  const value = fields.map(([field, length]) => {
    if (field.length > length) throw new Error(`${field} exceeds ${length} bytes`);
    return field.padEnd(length, ' ');
  }).join('');
  return value.padEnd(width, ' ');
}
