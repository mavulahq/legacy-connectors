#!/usr/bin/env node
import pg from 'pg';

const databaseUrl = required('LEGACY_CONNECTORS_MIGRATION_DATABASE_URL');
const password = required('LEGACY_CONNECTORS_DATABASE_ROLE_PASSWORD');
if (password.length < 16 || password.startsWith('REPLACE_WITH_')) {
  throw new Error('LEGACY_CONNECTORS_DATABASE_ROLE_PASSWORD must be a non-placeholder secret of at least 16 characters');
}
const pool = new pg.Pool({ connectionString: withoutSchema(databaseUrl) });
try {
  await pool.query(`ALTER ROLE legacy_connectors_app WITH LOGIN PASSWORD '${password.replaceAll("'", "''")}'`);
  const { rows } = await pool.query(`SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolinherit, rolbypassrls FROM pg_roles WHERE rolname = 'legacy_connectors_app'`);
  const role = rows[0];
  if (!role?.rolcanlogin || role.rolsuper || role.rolcreatedb || role.rolcreaterole || role.rolinherit || role.rolbypassrls) {
    throw new Error('legacy_connectors_app role attributes do not satisfy the runtime policy');
  }
} finally {
  await pool.end();
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
function withoutSchema(value) {
  const url = new URL(value);
  url.searchParams.delete('schema');
  return url.toString();
}
