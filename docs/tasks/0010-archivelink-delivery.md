# 0010 — S/4 ArchiveLink delivery (`linkForArchive` + `/doc/:token`)

**Status:** in-progress (code shipped; blocked on S/4 / Basis inputs for a live run)
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
- [ ] Live run against `C1` from a hybrid session.

## Checklist

- [x] ADR 0009, task, config examples (`mta.yaml`, `secrets.mtaext.example`, `.env.example`)
- [x] `srv/lib/archives.js`, `archivelink.js`, `doctoken.js`, `delivery.js`
- [x] `LinkService.linkForArchive`, source-aware `linkFor`, `/doc/:token`
- [x] `test/archivelink.test.js`
- [ ] Basis: OAC0 settings of `C1` (server, signatures required?)
- [ ] BTP: create destination `OpenText_ArchiveCenter` (OnPremise, Cloud Connector mapping)
- [ ] S/4: OAuth client for BTP (SM59 + OA2C); put its `azp` in `ARCHIVELINK_REPOSITORIES`
- [ ] Follow-up if needed: signed Content Server URLs (`secKey`)

## References

- [ADR 0009](../adr/0009-archivelink-source-typed-documents.md) ·
  [CONSUMING.md → S/4 ArchiveLink](../CONSUMING.md#s4-archivelink-documents)
