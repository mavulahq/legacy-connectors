CREATE SCHEMA IF NOT EXISTS legacy_connectors;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'legacy_connectors_app') THEN
    CREATE ROLE legacy_connectors_app NOLOGIN;
  END IF;
  ALTER ROLE legacy_connectors_app NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
END
$$;

DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO legacy_connectors_app', current_database());
END
$$;
GRANT USAGE ON SCHEMA legacy_connectors TO legacy_connectors_app;

CREATE TABLE legacy_connectors.legacy_batch_receipts (
  id text PRIMARY KEY,
  "tenantId" text NOT NULL,
  "institutionId" text NOT NULL,
  direction text NOT NULL CHECK (direction IN ('IMPORT', 'EXPORT')),
  "contractId" text NOT NULL CHECK ("contractId" = 'legacy.regulatory_transaction_export@1'),
  "idempotencyKeyDigest" text NOT NULL CHECK ("idempotencyKeyDigest" ~ '^[a-f0-9]{64}$'),
  "requestHash" text NOT NULL CHECK ("requestHash" ~ '^[a-f0-9]{64}$'),
  "correlationId" text NOT NULL,
  "requestedBy" text NOT NULL,
  state text NOT NULL CHECK (state IN ('QUEUED','PROCESSING','GENERATED','VALIDATED','REJECTED','FAILED','DELIVERED')),
  request jsonb NOT NULL,
  "sourceCount" integer NOT NULL DEFAULT 0,
  "recordCount" integer NOT NULL DEFAULT 0,
  "totalAmountMinor" text NOT NULL DEFAULT '0' CHECK ("totalAmountMinor" ~ '^[0-9]+$'),
  "contentSha256" text CHECK ("contentSha256" IS NULL OR "contentSha256" ~ '^[a-f0-9]{64}$'),
  "rejectionReport" jsonb NOT NULL DEFAULT '[]'::jsonb,
  attempts integer NOT NULL DEFAULT 0,
  "maxAttempts" integer NOT NULL DEFAULT 3 CHECK ("maxAttempts" BETWEEN 1 AND 10),
  "leaseUntil" timestamp(3),
  "deliveredAt" timestamp(3),
  "authorityReference" text,
  "failureReason" text,
  "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("tenantId", direction, "idempotencyKeyDigest")
);
CREATE INDEX legacy_batch_receipts_tenant_state_created_idx
  ON legacy_connectors.legacy_batch_receipts("tenantId", state, "createdAt");
CREATE INDEX legacy_batch_receipts_state_lease_idx
  ON legacy_connectors.legacy_batch_receipts(state, "leaseUntil");

CREATE TABLE legacy_connectors.legacy_batch_artifacts (
  id text PRIMARY KEY,
  "tenantId" text NOT NULL,
  "receiptId" text NOT NULL UNIQUE REFERENCES legacy_connectors.legacy_batch_receipts(id) ON DELETE CASCADE,
  filename text NOT NULL,
  "mediaType" text NOT NULL,
  "byteLength" integer NOT NULL CHECK ("byteLength" BETWEEN 1 AND 10485760),
  "contentSha256" text NOT NULL CHECK ("contentSha256" ~ '^[a-f0-9]{64}$'),
  content bytea NOT NULL,
  "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX legacy_batch_artifacts_tenant_created_idx
  ON legacy_connectors.legacy_batch_artifacts("tenantId", "createdAt");

CREATE TABLE legacy_connectors.legacy_batch_attempts (
  id text PRIMARY KEY,
  "tenantId" text NOT NULL,
  "receiptId" text NOT NULL REFERENCES legacy_connectors.legacy_batch_receipts(id) ON DELETE CASCADE,
  attempt integer NOT NULL,
  result text NOT NULL CHECK (result IN ('SUCCEEDED','REJECTED','FAILED')),
  "errorCode" text,
  "recordedAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("receiptId", attempt)
);
CREATE INDEX legacy_batch_attempts_tenant_receipt_idx
  ON legacy_connectors.legacy_batch_attempts("tenantId", "receiptId");

CREATE OR REPLACE FUNCTION legacy_connectors.current_tenant_id()
RETURNS text LANGUAGE sql STABLE
AS $$ SELECT NULLIF(current_setting('app.current_tenant_id', true), '') $$;

REVOKE ALL ON FUNCTION legacy_connectors.current_tenant_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION legacy_connectors.current_tenant_id() TO legacy_connectors_app;

ALTER TABLE legacy_connectors.legacy_batch_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy_connectors.legacy_batch_receipts FORCE ROW LEVEL SECURITY;
ALTER TABLE legacy_connectors.legacy_batch_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy_connectors.legacy_batch_artifacts FORCE ROW LEVEL SECURITY;
ALTER TABLE legacy_connectors.legacy_batch_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy_connectors.legacy_batch_attempts FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON legacy_connectors.legacy_batch_receipts TO legacy_connectors_app
  USING ("tenantId" = legacy_connectors.current_tenant_id())
  WITH CHECK ("tenantId" = legacy_connectors.current_tenant_id());
CREATE POLICY tenant_isolation ON legacy_connectors.legacy_batch_artifacts TO legacy_connectors_app
  USING ("tenantId" = legacy_connectors.current_tenant_id())
  WITH CHECK ("tenantId" = legacy_connectors.current_tenant_id());
CREATE POLICY tenant_isolation ON legacy_connectors.legacy_batch_attempts TO legacy_connectors_app
  USING ("tenantId" = legacy_connectors.current_tenant_id())
  WITH CHECK ("tenantId" = legacy_connectors.current_tenant_id());

GRANT SELECT, INSERT, UPDATE ON legacy_connectors.legacy_batch_receipts TO legacy_connectors_app;
GRANT SELECT, INSERT ON legacy_connectors.legacy_batch_artifacts TO legacy_connectors_app;
GRANT SELECT, INSERT ON legacy_connectors.legacy_batch_attempts TO legacy_connectors_app;
REVOKE DELETE ON ALL TABLES IN SCHEMA legacy_connectors FROM legacy_connectors_app;

CREATE OR REPLACE FUNCTION legacy_connectors.legacy_batch_status_totals()
RETURNS TABLE (state text, count bigint, rejection_records bigint)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, legacy_connectors
AS $$
  SELECT state, count(*), COALESCE(sum(jsonb_array_length("rejectionReport")), 0)
  FROM legacy_connectors.legacy_batch_receipts
  GROUP BY state
$$;
REVOKE ALL ON FUNCTION legacy_connectors.legacy_batch_status_totals() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION legacy_connectors.legacy_batch_status_totals() TO legacy_connectors_app;
