# MAVULA Legacy Connectors

Versioned legacy financial interoperability contracts and validation tooling.

This boundary owns COBOL copybooks, fixed-width layouts and deterministic batch
validation. It never accesses Identity Access or Ledger Core stores directly.

## Regulatory transaction export v1

The first contract provides a 2048-byte US-ASCII header/detail/trailer layout,
COBOL copybook, SHA-256 reconciliation, synthetic golden file and deterministic
rejection report. It is validation-only and does not generate or submit batches.

```bash
pnpm test
pnpm legacy:validate contracts/regulatory-transaction-export/v1/examples/regulatory-transaction-export.v1.dat
```

## License

AGPL-3.0-only. MAVULA names and marks remain reserved.
