REVOKE UPDATE ON legacy_connectors.legacy_batch_receipts FROM legacy_connectors_app;
GRANT UPDATE (
  state, "sourceCount", "recordCount", "totalAmountMinor", "contentSha256",
  "rejectionReport", attempts, "leaseUntil", "deliveredAt",
  "authorityReference", "failureReason", "updatedAt"
) ON legacy_connectors.legacy_batch_receipts TO legacy_connectors_app;
