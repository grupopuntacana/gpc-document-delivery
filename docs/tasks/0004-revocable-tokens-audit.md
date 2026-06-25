# 0004 — Revocable (DB-backed) tokens + fetch audit

**Status:** todo
**Depends on:** none (delivery path is live).
**Architecture:** closes the ADR 0001 gap on the **delivery** spine — ranks above upload
(0003) in delivery importance. See [ADR 0005](../adr/0005-shared-delivery-ingest-service.md)
open items.

## Context

ADR 0001 (prototype) decided the sharing token may be **stateless HMAC** *or*
**DB-backed**, and explicitly says: *"For invoices we will start with the database-backed
form because per-document revocation is a real business need (refunds, mistakenly issued
invoices, customer disputes)."* It lists **revocation and audit as first-class**.

CAP currently ships only the **stateless HMAC** variant (`srv/lib/token.js`) — tokens
cannot be revoked individually before expiry, and there is no record of who fetched what.
This is the main missing *delivery* feature relative to the accepted design.

## Acceptance criteria

- [ ] A token can be **revoked** so the next `/invoice/:token` access fails (403), before
      its natural expiry.
- [ ] Every successful (and denied) fetch is **audited**: token/node id, timestamp, source
      IP/user-agent, outcome.
- [ ] The customer-facing URL contract (`/invoice/:token`) is **unchanged** — ADR 0001
      says swapping variants is a `resolveToken()` body change, not an API change.
- [ ] Stateless HMAC remains available behind a config switch (e.g.
      `TOKEN_MODE=hmac|db`) so we don't lose the no-dependency option.

## Checklist

### Data model
- [ ] Add a `SharedLink` entity (CDS): `token` (or id), `nodeId`, `customerId?`,
      `expiresAt`, `revokedAt?`, `createdAt`. Persist on a CAP datasource (HANA in prod;
      sqlite for local/test — confirm DB choice; the app has none today).
- [ ] Add a `FetchAudit` entity: `nodeId`, `token`, `at`, `ip`, `userAgent`, `outcome`.

### Resolve / mint
- [ ] `resolveToken` (db mode): look up row → reject if missing / expired / `revokedAt`.
- [ ] `mintToken` (db mode): insert a row with a random 128-bit handle (no HMAC needed).
- [ ] `revokeToken(nodeId|token)`: set `revokedAt` (authenticated admin action).
- [ ] Keep HMAC mode intact; select via `TOKEN_MODE`.

### Audit
- [ ] Write a `FetchAudit` row in the `/invoice/:token` handler on every access (success
      and denial). Keep it off the latency-critical path if it becomes measurable
      (fire-and-forget / async insert).

### Admin surface (optional first cut)
- [ ] Authenticated action to list/revoke a customer's shared links.

## Notes
- This introduces the app's **first database dependency** — decide HANA vs sqlite-for-dev
  and add the `cds.requires.db` + mta resource accordingly (see ADR 0005; this also makes
  the "shared service owns state" story real).
- Cross-side interop: if HMAC mode stays, its secret must remain byte-identical to the
  Python side (CLAUDE.md contract).

## References
- Prototype ADR 0001 §"Decision" + §"Why this pattern" (revocation/audit rows).
- CAP: `srv/lib/token.js` (current HMAC), `srv/server.js` (`/invoice/:token`).
- [ADR 0005](../adr/0005-shared-delivery-ingest-service.md) open items.
