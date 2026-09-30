# 0010 — S/4 ArchiveLink delivery (`linkForArchive` + `/doc/:token`)

**Status:** in-progress (signed reads from `C1` work in-office; blocked on the Cloud Connector mapping and the S/4 caller setup)
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
- [x] Generate the DEV signing key pair (`CN=BTP_DOCDELIVERY_DEV`, kept in git-ignored `certs/`)
- [x] OpenText admin registered + enabled the DEV certificate on `C1`
- [x] Direct (in-office) signed read returns the PDF (`scripts/probe-archivelink.js`, step 4).
      Finding: the signed message must carry `authId` URL-encoded, as sent
- [ ] Same probe through the Cloud Connector (`cds bind --exec`), once Basis adds the mapping
- [x] DEV key pair in the Credential Store (`ArchiveLinkSigningKey`, `ArchiveLinkSigningCert`)
- [ ] S/4: IAS client + SM59 destinations; put its `azp` in `ARCHIVELINK_REPOSITORIES`
      ([usage draft](../CONSUMING.md#s4-archivelink-documents))
- [x] `DELIVERY_BASE_URL` declared in `mta.yaml` as the service's own route (it was only set by
      hand with `cf set-env`)
- [x] Demo portal router: anonymous `/doc/*` route to the service (`xs-app.json`), like `/invoice/*`
- [ ] S/4 team reviews and runs the ABAP sketch

## References

- [ADR 0009](../adr/0009-archivelink-source-typed-documents.md) ·
  [CONSUMING.md → S/4 ArchiveLink](../CONSUMING.md#s4-archivelink-documents)
