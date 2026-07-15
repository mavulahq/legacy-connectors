---
name: mavula-review
description: Review MAVULA changes across finance-platform, ledger-core, workbench, settlements, operations, and related repositories. Use for pull request reviews, pre-merge checks, security review, database review, migration review, and implementation review in TypeScript, Go, Java, COBOL, Python, PostgreSQL, Redis, Kubernetes, and CI/CD.
---

# MAVULA Review

Use this skill to review MAVULA changes with a finance-grade standard: correctness, security, data safety, maintainability, and module ownership come first.

## Review Workflow

1. Read the diff, surrounding code, tests, contracts, migrations, and CI configuration touched by the change.
2. Identify the runtime boundary: application code, ledger/domain logic, settlement process, infrastructure, database, security, or tooling.
3. Check whether the change preserves module ownership:
   - `finance-platform` coordinates repository policy, submodules, contracts, and master guardian checks.
   - `ledger-core` owns ledger and financial invariants.
   - `workbench` owns orchestration and operator runtime.
   - `settlements` owns payment and settlement process state.
   - `operations` owns deployment, secrets wiring, monitoring, and infrastructure.
4. Verify tests and commands appropriate to the change. Prefer local scripts already defined in `package.json`, module guardians, targeted tests, and CI-equivalent checks.
5. Report only actionable findings. Avoid praise, broad summaries, speculative rewrites, or style-only comments unless they block maintainability or policy.

## Findings

Lead with findings, ordered by severity.

Use this shape:

```text
[P1] Short imperative title
path/to/file.ext:line
Impact: concrete failure mode.
Fix: concrete change required.
Verification: command or test that should cover it.
```

Severity guide:

- `P0`: exploitable security issue, data loss, financial invariant break, or production-wide outage.
- `P1`: build/CI break, incorrect money movement, tenant isolation failure, migration failure, or deploy blocker.
- `P2`: realistic runtime bug, retry/idempotency issue, race, performance risk, observability gap, or missing required test.
- `P3`: maintainability issue with concrete future cost.

If there are no findings, say so directly and list residual risk or unrun validation.

## Language

Use the language already used in the pull request, issue, or discussion. If the thread is Portuguese, write formal Portuguese. If the thread is English or mixed technical code review, use concise professional English.

Avoid marketing claims, decorative status symbols, phase narration, and long background explanations in review comments.

## Technical Focus

For TypeScript and Node.js:

- Check async error paths, unhandled promises, transaction boundaries, Prisma schema/client drift, ESM/CJS boundaries, workspace package builds, and typed public exports.
- Validate idempotency keys, webhook dedupe, outbox/inbox behavior, retries, and DLQ paths.

For Go:

- Check `context.Context` propagation, cancellation, goroutine lifetime, race risks, error wrapping, interface boundaries, SQL transaction handling, and deterministic tests.

For Java:

- Check transaction annotations and boundaries, exception mapping, thread safety, serialization compatibility, dependency injection scope, and database connection handling.

For COBOL:

- Check `PIC` precision and scale, signed and packed decimal fields, copybook compatibility, file layouts, batch restartability, commit points, and reconciliation totals.

For Python:

- Check type coverage, packaging metadata, resource cleanup, deterministic migrations, SQL parameterization, timezone handling, and test isolation.

## Data And Security

Treat database and security review as required for finance changes.

Check database changes for:

- Backward-compatible migrations, rollback path, generated clients, indexes, constraints, foreign keys, locks, long-running statements, and online deploy safety.
- Tenant isolation, row-level policy assumptions, idempotency, replay safety, outbox/inbox atomicity, webhook dedupe, and reconciliation paths.
- PostgreSQL query plans where cardinality, indexes, or locks can affect production behavior.
- Redis key namespacing, TTLs, retry counters, queue semantics, and poison-message behavior.

Check security changes for:

- Authentication, authorization, tenant boundaries, least privilege, secret handling, audit logs, dependency and supply-chain risk, CI token permissions, webhook signatures, injection, SSRF, crypto/TLS use, and PII leakage.
- No credentials, tokens, private keys, customer data, or `.env` files may be committed or shown in review output.

## Validation Expectations

Prefer the smallest validation set that proves the change. For this repository family, common checks include:

```bash
pnpm guardian:check
pnpm contracts:check
pnpm -r build
git diff --check
```

For module changes, run the module-specific guardian and targeted tests before broader builds when possible.

## Agent Behavior

Do not approve your own change. Do not bypass branch protection unless explicitly instructed by a repository owner for a concrete blocked merge.

When reviewing a pull request, keep the output review-shaped: findings first, then open questions, then validation notes. When implementing a fix, keep edits scoped to the issue, preserve unrelated local work, and update tests or guardian rules when the risk justifies it.
