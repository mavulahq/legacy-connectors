CREATE OR REPLACE FUNCTION legacy_connectors.legacy_batch_status_totals()
RETURNS TABLE (state text, count bigint, rejection_records bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, legacy_connectors
AS $$
DECLARE
  tenant_id text := legacy_connectors.current_tenant_id();
BEGIN
  IF tenant_id IS NULL THEN
    RAISE EXCEPTION 'app.current_tenant_id is required'
      USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  SELECT receipts.state, count(*), COALESCE(sum(jsonb_array_length(receipts."rejectionReport")), 0)
  FROM legacy_connectors.legacy_batch_receipts AS receipts
  WHERE receipts."tenantId" = tenant_id
  GROUP BY receipts.state;
END;
$$;

ALTER FUNCTION legacy_connectors.legacy_batch_status_totals() OWNER TO legacy_connectors_maintenance;
REVOKE ALL ON FUNCTION legacy_connectors.legacy_batch_status_totals() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION legacy_connectors.legacy_batch_status_totals() TO legacy_connectors_app;
