# 0003 — Ingest API: shared document upload

**Status:** todo
**Depends on:** [0001](0001-wire-credential-store.md) (done). Independent of 0002.
**Architecture:** first endpoint of the **ingest** capability group in
[ADR 0005](../adr/0005-shared-delivery-ingest-service.md). Frame it as a *shared* API
other BTP apps will call — not a one-off demo route.

## Context

Upload is proven in the Python demo (`../python/opentext-cdn-prototype/demo/server.py`
`POST /admin/upload` + `opentext_client.upload_document` + Django-style UUID dedup) but
has **no CAP/BTP equivalent**. We've only exercised **reads** through the Cloud Connector
so far; upload is the first **write** through the tunnel.

Per ADR 0005 this is the seed of the reusable ingest API: a caller passes a document (and
later a **doc-type**); the service stores it in OpenText (doc-type → folder mapping) and
returns the `nodeId` (optionally a sharing token). The demo drag-and-drop UI becomes the
first client of this same API.

## Acceptance criteria

- [ ] A multipart upload reaches OpenText **through the Cloud Connector** and creates a
      type-144 node; returns the new `nodeId`.
- [ ] Name-collision handling matches the demo: keep the original filename, append an
      8-char UUID suffix on conflict (Django-style).
- [ ] Endpoint is **authenticated** (service-to-service / portal user) — unlike the
      anonymous deliver route. The token in `/invoice/:token` is the credential there;
      ingest must not be anonymous.
- [ ] After upload, the portal listing shows the new document (refresh path works).
- [ ] Keep-alive / per-host socket discipline from the 403 fix is honored on the write
      (see `srv/lib/opentext.js` agents) — validated, not assumed.

## Checklist

### OpenText write op — `srv/lib/opentext.js`
- [ ] Port `upload_document(parentFolderId, fileBuffer, name, contentType)`:
      `POST {OTCS}/otcs/cs.exe/api/v2/nodes` as **multipart** — a `body` form field
      (`{parent_id, type:144, name}` as a JSON string) + the file part. Use
      `@sap-cloud-sdk/http-client` with a multipart payload (FormData/`form-data`).
      Return the new node id (defensive extract, mirror Python `_extract_node_id`).
- [ ] (If needed by dedup) port `list_folder` is already present; add `create_folder` /
      `find_or_create_folder` only if doc-type→folder routing needs it now (else defer).
- [ ] ⚠️ Validate the multipart POST tunnels correctly — content-type boundary + the
      per-host OTCS agent. This is the main unknown.

### Ingest endpoint — CAP service (not the anonymous route)
- [ ] Add an authenticated `IngestService` action (e.g. `uploadDocument`) **or** an
      authenticated `POST /admin/upload` route. Prefer a CAP service action so IAS
      service-to-service auth and (future) doc-type authorization apply per ADR 0005.
- [ ] Dedup: read the target folder, keep original name, append `crypto.randomUUID()`
      first 8 hex on conflict.
- [ ] Return `{ nodeId, name }` (and optionally a freshly minted sharing token).

### Demo UI (optional, after the API works)
- [ ] Add a drag-and-drop upload box to the Vue portal that calls the ingest endpoint,
      then refreshes the listing (mirror the demo's `.upload-box`).

## Out of scope (defer to ADR 0005 follow-ups)
- Full doc-type → folder/prefix mapping (`VM_DocTypeToS3Prefix` equivalent).
- The ingest authorization model (which calling app may write which doc-type).

## References
- Python: `demo/server.py` (`/admin/upload`, dedup), `src/opentext_client.py`
  (`upload_document`, `create_folder`, `_extract_node_id`).
- CAP: `srv/lib/opentext.js` (auth + per-host agents), `srv/portal-service.js` (listing).
- [ADR 0005](../adr/0005-shared-delivery-ingest-service.md).
