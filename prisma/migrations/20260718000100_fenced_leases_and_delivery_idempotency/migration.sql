ALTER TABLE legacy_connectors.legacy_batch_receipts
  ADD COLUMN "leaseToken" text,
  ADD COLUMN "deliveryIdempotencyKeyDigest" text,
  ADD COLUMN "deliveryRequestHash" text,
  ADD COLUMN "deliveryCorrelationId" text,
  ADD COLUMN "deliveryRequestedBy" text;

ALTER TABLE legacy_connectors.legacy_batch_receipts
  ADD CONSTRAINT legacy_batch_receipts_delivery_digest_check
    CHECK ("deliveryIdempotencyKeyDigest" IS NULL OR "deliveryIdempotencyKeyDigest" ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT legacy_batch_receipts_delivery_hash_check
    CHECK ("deliveryRequestHash" IS NULL OR "deliveryRequestHash" ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT legacy_batch_receipts_delivery_evidence_check
    CHECK (
      ("deliveryIdempotencyKeyDigest" IS NULL AND "deliveryRequestHash" IS NULL AND "deliveryCorrelationId" IS NULL AND "deliveryRequestedBy" IS NULL)
      OR
      (state = 'DELIVERED' AND "deliveryIdempotencyKeyDigest" IS NOT NULL AND "deliveryRequestHash" IS NOT NULL
       AND "deliveryCorrelationId" IS NOT NULL AND "deliveryRequestedBy" IS NOT NULL)
    );

CREATE UNIQUE INDEX legacy_batch_receipts_tenant_delivery_key
  ON legacy_connectors.legacy_batch_receipts("tenantId", "deliveryIdempotencyKeyDigest")
  WHERE "deliveryIdempotencyKeyDigest" IS NOT NULL;

REVOKE UPDATE ON legacy_connectors.legacy_batch_receipts FROM legacy_connectors_app;
GRANT UPDATE (
  state, "sourceCount", "recordCount", "totalAmountMinor", "contentSha256",
  "rejectionReport", attempts, "leaseUntil", "leaseToken", "deliveredAt",
  "authorityReference", "deliveryIdempotencyKeyDigest", "deliveryRequestHash",
  "deliveryCorrelationId", "deliveryRequestedBy", "failureReason", "updatedAt"
) ON legacy_connectors.legacy_batch_receipts TO legacy_connectors_app;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'legacy_connectors_maintenance') THEN
    CREATE ROLE legacy_connectors_maintenance NOLOGIN;
  END IF;
  ALTER ROLE legacy_connectors_maintenance NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
END
$$;

GRANT USAGE ON SCHEMA legacy_connectors TO legacy_connectors_maintenance;
GRANT SELECT ON legacy_connectors.legacy_batch_receipts TO legacy_connectors_maintenance;
CREATE POLICY maintenance_metrics ON legacy_connectors.legacy_batch_receipts TO legacy_connectors_maintenance
  USING (true);
ALTER FUNCTION legacy_connectors.legacy_batch_status_totals() OWNER TO legacy_connectors_maintenance;
REVOKE ALL ON FUNCTION legacy_connectors.legacy_batch_status_totals() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION legacy_connectors.legacy_batch_status_totals() TO legacy_connectors_app;
