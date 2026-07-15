import { readFileSync } from 'node:fs';
import { validateRegulatoryTransactionExport } from './validator.js';

const file = process.argv[2];
if (!file) {
  console.error('Usage: legacy:validate <batch-file>');
  process.exit(2);
}
const report = validateRegulatoryTransactionExport(readFileSync(file));
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!report.accepted) process.exitCode = 1;
