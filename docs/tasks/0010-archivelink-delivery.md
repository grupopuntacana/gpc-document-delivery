# 0010 — S/4 ArchiveLink delivery (`linkForArchive` + `/doc/:token`)

**Status:** in-progress (code shipped; blocked on the Cloud Connector mapping and the certificate registration on `C1`)
**Architecture:** [ADR 0009](../adr/0009-archivelink-source-typed-documents.md)
**Issue:** [#16](https://github.com/grupopuntacana/gpc-document-delivery/issues/16)

## Context

S/4 archives customer documents (e.g. IS-U bills, `PRINTDOC` / `ISU_BILL` in repository `C1`)
through ArchiveLink and holds the TOA01 locator `(ARCHIV_ID, ARC_DOC_ID)`. It needs a public,
short-lived link for them without uploading the bytes again. The BTP paths (`IngestService`,
`@gpc/attachments-opentext` → `register` → `linkFor`) must stay exactly as they are.

## Acceptance criteria

- [x] `Documents` is source-typed (`otcs` | `archivelink`); existing rows default to `otcs`.
- [x] `linkForArchive(contRep, archDocId, …)`: 403 without `azp`, 400 for a malformed locator or
      over-long metadata, 404 when the caller is not a repository reader, 500 for a broken
      registry. The row is upserted lazily, one per `(contRep, archDocId)`, and a revoked row stays
      revoked.
- [x] v2 token (key-separated from v1) and `GET /doc/:token`, which resolves the row per request
      and serves any source; revocation kills outstanding links.
- [x] `linkFor(docId)` is source-aware: `otcs` rows keep `/invoice`, `archivelink` rows get `/doc`.
- [x] Content Server HTTP fetcher over a destination; CDN key `archivelink/<contRep>/<archDocId>`.
- [x] `/invoice/:token` and the v1 token are byte-identical (existing interop tests pass).
- [x] Requests are signed (`secKey`) when a signing certificate is configured.
- [ ] Live run against `C1` from a hybrid session (needs the registered certificate).

## Checklist

- [x] ADR 0009, task, config examples (`mta.yaml`, `secrets.mtaext.example`, `.env.example`)
- [x] `srv/lib/archives.js`, `archivelink.js`, `doctoken.js`, `delivery.js`
- [x] `LinkService.linkForArchive`, source-aware `linkFor`, `/doc/:token`
- [x] `test/archivelink.test.js`
- [x] Basis: OAC0 settings of `C1` — HTTP content server `OTEMO.grupopuntacana.com:8082`,
      script `archive`, protocol 0045, no HTTPS
- [x] Discovery ([endpoint-discovery](../endpoint-discovery.md#archivelink-repository-c1-otac)):
      Archive Center 25.4, signed URLs mandatory, RSA certificates accepted
- [x] Signed Content Server URLs (`srv/lib/seckey.js`), `scripts/probe-archivelink.js`; the
      server parses our `secKey` (answers "certificate unknown" for an unregistered one)
- [x] BTP: destination `OpenText_OTAC` = `http://otac-dev:8082` (OnPremise, NoAuthentication)
- [ ] Basis: Cloud Connector mapping `otac-dev:8082` → `OTEMO.grupopuntacana.com:8082`
      (HTTP; open for discovery now, restrict to `/archive` + sub-paths afterwards)
- [ ] Generate the signing key pair; OpenText admin registers + enables the certificate on
      `C1`, **read-only** ([runbook](../setup/archivelink-otac.md))
- [ ] Key into the Credential Store (`ArchiveLinkSigningKey`), certificate into `secrets.mtaext`
- [ ] S/4: OAuth client for BTP (SM59 + OA2C); put its `azp` in `ARCHIVELINK_REPOSITORIES`

## References

- [ADR 0009](../adr/0009-archivelink-source-typed-documents.md) ·
  [CONSUMING.md → S/4 ArchiveLink](../CONSUMING.md#s4-archivelink-documents)
