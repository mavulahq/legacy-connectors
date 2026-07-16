#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const failures = [];
const required = [
  '.agents/AGENTS.md', '.agents/skills/mavula-review/SKILL.md',
  '.agents/skills/mavula-review/agents/openai.yaml', '.github/CODEOWNERS',
  '.github/PULL_REQUEST_TEMPLATE.md', '.github/workflows/guardian.yml',
  '.github/workflows/required-ci.yml', 'LICENSE', 'README.md', 'package.json',
  'contracts/regulatory-transaction-export/v1/layout.json',
  'contracts/regulatory-transaction-export/v1/regulatory-transaction-export.v1.cpy',
  'prisma/schema.prisma',
  'src/batch-runtime.ts',
  'src/generator.ts',
];
for (const file of required) if (!existsSync(file)) failures.push(`${file} is required`);
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
if (pkg.name !== '@mavula/legacy-connectors') failures.push('package name must be @mavula/legacy-connectors');
if (pkg.license !== 'AGPL-3.0-only') failures.push('legacy-connectors must remain AGPL-3.0-only');
const tracked = spawnSync('git', ['ls-files'], { encoding: 'utf8' });
for (const file of tracked.stdout.split('\n').filter(Boolean)) {
  if (/(^|\/)\.env($|\.(?!example$))/.test(file)) failures.push(`${file} must not be tracked`);
  if (/\.(png|jpg|jpeg|webp|gif|ico|pdf|dat)$/i.test(file) || file === 'scripts/guardian.mjs') continue;
  const content = readFileSync(file, 'utf8');
  if (/getfluxo-io|@getfluxo|packages\/(fengine|fwk|fpay|finfra)/.test(content)) failures.push(`${file} contains legacy identifiers`);
  if (/\.(ts|js|mjs|sql|prisma)$/.test(file) && !file.startsWith('.agents/')) {
    if (/@mavula\/(ledger-core|identity-access)|@prisma\/client/.test(content)) {
      failures.push(`${file} imports another owner runtime`);
    }
    if (/\b(financial_transactions|journal_entries|accounts|loans|operators|credentials|memberships)\b/i.test(content)) {
      failures.push(`${file} accesses data owned by another bounded context`);
    }
  }
}
if (failures.length) {
  console.error('MAVULA legacy-connectors guardian failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log('MAVULA legacy-connectors guardian passed.');
