import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { LegacyBatchManager, PostgresLegacyBatchStore } from '../dist/index.js';

const enabled = process.env.LEGACY_CONNECTORS_RLS_TEST === 'true';
const runtimeUrl = process.env.LEGACY_CONNECTORS_DATABASE_URL;

test('PostgreSQL receipts enforce tenant RLS and append-only artifacts', { skip: !enabled }, async () => {
  assert.ok(runtimeUrl, 'LEGACY_CONNECTORS_DATABASE_URL is required');
  const store = new PostgresLegacyBatchStore(runtimeUrl);
  const manager = new LegacyBatchManager(store, () => new Date('2026-08-01T08:00:00.000Z'));
  const tenantA = `tenant_a_${randomUUID()}`;
  const tenantB = `tenant_b_${randomUUID()}`;
  const receipt = await manager.stageImport({
    tenant_id: tenantA,
    institution_id: 'institution_a',
    idempotency_key: randomUUID(),
    correlation_id: randomUUID(),
    requested_by: 'compliance_a',
    filename: 'invalid.dat',
    content: Buffer.from('invalid\n'),
  });
  const processed = await manager.processImport(tenantA, receipt.id);
  assert.equal(processed.state, 'REJECTED');
  assert.equal(await manager.get(tenantB, receipt.id), undefined);
  assert.equal((await manager.getArtifact(tenantA, receipt.id)).content.toString('ascii'), 'invalid\n');
  assert.ok((await manager.globalMetrics()).rejected >= 1);

  const pool = new pg.Pool({ connectionString: withoutSchema(runtimeUrl) });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.current_tenant_id',$1,true)", [tenantA]);
    await assert.rejects(
      () => client.query('UPDATE legacy_connectors.legacy_batch_receipts SET "requestHash"=$2 WHERE id=$1', [receipt.id, '0'.repeat(64)]),
      (error) => error.code === '42501',
    );
    await client.query('ROLLBACK');
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.current_tenant_id',$1,true)", [tenantA]);
    await assert.rejects(
      () => client.query('DELETE FROM legacy_connectors.legacy_batch_receipts WHERE id=$1', [receipt.id]),
      (error) => error.code === '42501',
    );
    await client.query('ROLLBACK');
  } finally {
    client.release();
    await pool.end();
    await store.close();
  }
});

function withoutSchema(value) {
  const url = new URL(value);
  url.searchParams.delete('schema');
  return url.toString();
}
