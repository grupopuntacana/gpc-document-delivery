# ADR 0009 — S/4 ArchiveLink delivery: source-typed documents + `linkForArchive` + `/doc/:token`

- **Status:** Proposed
- **Date:** 2026-09-29
- **Deciders:** Felix De Gracia; to be ratified by the SAP architecture review.
- **Lineage:** Extends [ADR 0006](0006-delivery-link-authorization.md) (opaque `docId` claim-check)
  and [ADR 0008](0008-bucket-scoped-cross-app-reads.md) (read grants as data). Closes the landscape
  open item *"how S/4-archived nodes get claimed (no bucket / claim path yet)"*.
- **Tracking:** GitHub issue [#16](https://github.com/grupopuntacana/gpc-document-delivery/issues/16),
  task [0010](../tasks/0010-archivelink-delivery.md).

## Context

Up to ADR 0008 every document this service delivers is a **BTP-born OpenText node**: uploaded
through `IngestService` or `@gpc/attachments-opentext`, then claimed into a bucket with
`register` / `linkForNode`. But a large class of customer documents never touches BTP. S/4
archives them through **ArchiveLink** when output management prints them, for example IS-U bills.
S/4 records the link in its own tables (TOA01…03). Rows S/4 shared:

```
MANDT SAP_OBJECT OBJECT_ID     ARCHIV_ID ARC_DOC_ID                        AR_OBJECT AR_DATE    RESERVE
110   PRINTDOC   050000000006  C1        0AFFC37AE2C51FD1AE84A8F99394C9FC  ISU_BILL  24.09.2026 PDF
110   PRINTDOC   294           C1        0AFFC37AE2C51FD1AE9F1204475B8A04  ISU_BILL  25.09.2026 PDF
110   PRINTDOC   294           C1        0AFFC37AE2C51FD1AF837DFD85394A0E  ISU_BILL  29.09.2026 PDF
```

S/4 therefore already holds a durable locator, `(ARCHIV_ID, ARC_DOC_ID)`, and needs a public link
for it: bill emails, portal, SMS. Four facts shape the decision:

1. **ArchiveLink is not a replacement for `docId`.** It is a *locator* plus a business link, the
   S/4 counterpart of the OTCS `nodeId`. It carries no notion of *which caller may deliver*. The
   `docId` / grant / revocation model (ADR 0006/0008) is still what makes a link safe.
2. **`ARC_DOC_ID` is not a secret.** SAP GUIDs are built from time and host parts (the three rows
   share the prefix `0AFFC37AE2C51FD1A…`), and business keys (`OBJECT_ID`) are sequential. Accepting
   either as proof of access would repeat the IDOR ADR 0006 removed for `nodeId`.
3. **One business object can have several archived documents.** `PRINTDOC 294` was archived twice,
   probably a reprint. The only unambiguous key is `(ARCHIV_ID, ARC_DOC_ID)`.
4. **The v1 token cannot carry it.** `/invoice/:token` signs `{"n": <integer nodeId>}` and is a
   byte-for-byte interop contract with the Python prototype and the Integration Suite port
   ([constraints](../constraints.md)). A 32-char string does not fit, and that contract must not
   change.

## Decision

**1. Documents are source-typed.** The `Documents` row gains
`source ∈ {'otcs', 'archivelink'}`, with the default `'otcs'` for every existing row:

| source | locator | read scope | who claims it |
|---|---|---|---|
| `otcs` | `nodeId` | `bucket` (ADR 0008 ACLs) | BTP writer: `uploadDocument` / `register` / `linkForNode` |
| `archivelink` | `contRep` + `archDocId` | content repository (`allowedReaders`) | S/4: `linkForArchive` |

`sapObject` / `objectId` / `docType` (TOA01 `SAP_OBJECT` / `OBJECT_ID` / `AR_OBJECT`) are recorded
for audit and a friendly download name (`ISU_BILL-050000000006.pdf`). They are **never** an
authorization input, because they are declared by the caller and not verified against TOA01.
`docId`, `ownerAzp` and `revoked` mean exactly what they meant before.

**2. `LinkService.linkForArchive(contRep, archDocId, sapObject?, objectId?, docType?, ttlDays?)
→ { docId, deliveryUrl, expiresAt }`.** S/4 calls it as its own IAS/OAuth client. The steps:

- The caller must have an `azp` claim, otherwise 403.
- The locator must have the TOA01 shape (`contRep` `^[A-Z0-9]{2}$`, `archDocId`
  `^[A-Za-z0-9]{1,40}$`), otherwise 400. Shape says nothing about existence, so a 400 here is no
  oracle, and it keeps caller input out of the Content Server query string.
- The caller must be listed in `allowedReaders` for the repository, otherwise 404 (fail closed, no
  enumeration).
- The row is upserted lazily, keyed by `(contRep, archDocId)`: one row per archived document, so a
  reprint is a new row. A revoked row stays revoked.
- The call mints a v2 link and returns the `docId`, so a caller can re-mint later through the
  ordinary `linkFor(docId)`, which is now source-aware.

**3. Grants live in `ARCHIVELINK_REPOSITORIES`**, the repository twin of `OPENTEXT_BUCKETS`:
`{"C1": {"allowedReaders": ["<s4-azp>"], "destination"?, "compId"?}}`. The grant is read-only
because document-delivery never writes into an ArchiveLink repository. The repository is the trust
boundary, exactly like a bucket. Per-document-type grants would need a verified TOA01 lookup and
are deferred. Config goes in the deployable descriptor (`secrets.mtaext`), as ADR 0008 requires.

**4. A v2 token and route: `GET /doc/:token`.** The token is `{"d": docId, "e", "v": 2}`, signed
with a **key derived** from `SHARED_LINK_SECRET` (`HMAC(secret, "gpc-document-delivery/doc-token/v2")`).
There is one secret to rotate, but a v1 signature can never validate as v2 or the other way round.
The route resolves the row on every request, which gives two things:

- it serves **every** row source through one route (`srv/lib/delivery.js` dispatches by `source`);
- revocation reaches outstanding links **immediately**, which is the DB-backed token ADR 0001 and
  task 0004 asked for, for this route.

`/invoice/:token` is unchanged and `linkFor` keeps minting it for `otcs` rows, so BTP consumers and
the Python / Integration Suite interop see no difference.

**5. Bytes are fetched with the SAP Content Server HTTP protocol** (`srv/lib/archivelink.js`):
`GET {destination}/archive?get&pVersion=0045&contRep=…&docId=…&compId=data`, through a BTP
destination (default `OpenText_ArchiveCenter`, Cloud Connector). This is the protocol S/4 itself
speaks to the repository, so it works against any ArchiveLink-certified server. In CDN mode the
object is cached under `archivelink/<contRep>/<archDocId>`, which cannot collide with the v1
`documents/<nodeId>.pdf` keys.

## The flow

```
S/4 (holds TOA01: C1 / 0AFF…C9FC / PRINTDOC 050000000006 / ISU_BILL)
  1. POST /odata/v4/link/linkForArchive {contRep:"C1", archDocId:"0AFF…C9FC", …}   [S/4 azp]
  2. document-delivery: archives.mayRead(azp,"C1")? → upsert row (source=archivelink) → docId
  3. ← { docId, deliveryUrl: https://<srv>/doc/<v2 token>, expiresAt }
  4. S/4 puts the link in the bill email / SMS
Customer
  5. GET /doc/<token> → verify → row (not revoked) → Content Server GET → PDF (or 302 to CloudFront)
```

## Consequences

**Positive**
- **One service covers both worlds.** BTP-born documents (bucket model) and S/4-native documents
  (ArchiveLink) get the same short-lived links, audit row and revocation, and S/4 needs no upload.
- **Nothing changes for existing consumers.** `/invoice`, `register`, `linkFor` for `otcs` rows,
  `@gpc/attachments-opentext` and the v1 token contract are untouched. The added
  `Documents.source` column defaults to `otcs`.
- **Adding a source later is cheap**: one entry in `delivery.SOURCES`, one claim action, one grant
  registry. Nothing in the routes changes.
- `/doc` links honor revocation immediately.

**Negative**
- **`/doc` costs one DB read per request** (primary-key lookup), which `/invoice` does not. This is
  negligible next to the upstream fetch or the CDN redirect.
- **Signed Content Server URLs (`secKey`) are not implemented.** If the repository requires
  signatures, fetches fail with a 502 carrying the upstream 401/403, and signing needs a BTP
  certificate registered on the repository (follow-up).
- **Existence is not checked at mint time.** A wrong `archDocId` from an authorized caller mints a
  link that 502s on redeem. The caller is trusted (it holds the TOA01 row), and a Content Server
  `info` probe would add a round trip to every mint. Revisit if it causes problems in operation.
- **Concurrent first claims can race** into two rows for one document, the same known race as
  `register`. It is contained, not prevented: ArchiveLink revocation is enforced **per locator**
  (any revoked row for `(contRep, archDocId)` blocks both `linkForArchive` and `/doc`), so the
  duplicate cannot outlive a revocation. A DB unique constraint needs care with the NULLs on
  `otcs` rows (HANA), so it is deferred.

**Hardening (from the security review of this change)**
- **Inline allowlist + `nosniff` on both anonymous routes.** Only PDF, common images and plain
  text are served `inline`. Anything else (HTML, SVG, XML) is served as an `attachment`, and every
  response carries `X-Content-Type-Options: nosniff`. An ArchiveLink repository can hold files
  that ordinary S/4 users attached, and an inline `text/html` on this origin would be stored XSS
  via a public link. This changes `/invoice` for non-allowlisted types (e.g. `.docx` now downloads
  instead of being offered inline), which is what browsers did anyway. The v1 *token* is untouched.
- **Opaque 502s.** Upstream failure detail (destination, Cloud Connector host, response body) is
  logged, never returned to the anonymous caller.
- **TTL cap for `/doc` links**: `DOC_LINK_MAX_TTL_DAYS`, default 90. The v1 `/invoice` mint keeps
  its historical behavior.

**Neutral**
- `MANDT` (the S/4 client) is not part of the key. One BTP deployment talks to one S/4 system per
  landscape tier; if that ever changes, the repository grant is where to add it.

## Alternatives considered

- **Use the ArchiveLink id (or the business key) as the public handle.** Rejected. Neither is an
  authorization (fact 2), not every document is ArchiveLink-linked, and it would couple every
  consumer to SAP.
- **S/4 uploads the bytes through `IngestService`.** This works today, but it stores every bill
  twice and throws away the locator S/4 already holds. It stays available for documents that are
  *not* archived.
- **Extend the v1 token with a string locator.** Rejected: it breaks the Python / Integration Suite
  interop contract (fact 4).
- **Fetch through S/4 (`API_CV_ATTACHMENT_SRV` or an RFC wrapper) instead of the repository.** S/4
  would enforce repository security, but it puts load and a third backend on S/4 PCE. The
  destination-based fetcher can point at such an endpoint later without code changes to the
  service layer. Kept as the fallback if the repository cannot be reached directly.
- **Resolve through Extended ECM business workspaces** (`/api/v2/businessworkspaces` answers on
  this OTCS, see [endpoint-discovery](../endpoint-discovery.md)). Only works if C1 is backed by
  Content Server. Kept as an option once the OAC0 setup of `C1` is confirmed.

## Open items

- OAC0 settings of `C1`: which server, and whether signatures are required (decides whether signing
  is needed).
- Why `OBJECT_ID 294` is not zero-padded like `050000000006` (matters only if we ever look up by
  business key).
- S/4 PCE → BTP OAuth client-credentials setup (SM59 + OA2C), and S/4's `azp` for the grant.

## References

- Issue [#16](https://github.com/grupopuntacana/gpc-document-delivery/issues/16) ·
  task [0010](../tasks/0010-archivelink-delivery.md)
- `srv/link-service.{cds,js}` (`linkForArchive`, source-aware `linkFor`) · `srv/server.js` (`/doc`)
- `srv/lib/archives.js` · `srv/lib/archivelink.js` · `srv/lib/doctoken.js` · `srv/lib/delivery.js`
- `test/archivelink.test.js`
