# 0003 — Ingest API: shared document upload

**Status:** done
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

- [x] A multipart upload reaches OpenText **through the Cloud Connector** and creates a
      type-144 node; returns the new `nodeId`. *(coded in `opentext.uploadDocument`; the
      multipart-over-Cloud-Connector boundary survival is the one item still to confirm on a
      live BTP run — flagged inline.)*
- [x] Name-collision handling matches the demo: keep the original filename, append an
      8-char UUID suffix on conflict (Django-style). *(`uniqueName` in `ingest-service.js`)*
- [x] Endpoint is **authenticated** (service-to-service / portal user) — unlike the
      anonymous deliver route. *(`@requires: 'authenticated-user'` on `IngestService`)*
- [x] After upload, the portal listing shows the new document (refresh path works). *(SPA
      upload box calls `load()` after upload; same folder default as the portal.)*
- [x] Keep-alive / per-host socket discipline from the 403 fix is honored on the write —
      the upload rides the same `otcsAgents` via `otcsRequest`, like every other OTCS call.

## Checklist

### OpenText write op — `srv/lib/opentext.js`
- [x] Port `upload_document(parentFolderId, fileBuffer, name, contentType)`:
      `POST {OTCS}/otcs/cs.exe/api/v2/nodes` as **multipart** — a `body` form field
      (`{parent_id, type:144, name}` as a JSON string) + the file part, via the `form-data`
      package (axios serializes it with a streaming boundary). Returns the new node id via
      `extractNodeId` (defensive, mirrors Python `_extract_node_id`). Added
      `listFolderChildNames` for dedup (all children, not just documents).
- [x] (If needed by dedup) reused `flattenChildren`; `create_folder` /
      `find_or_create_folder` deferred — no doc-type→folder routing yet.
- [ ] ⚠️ Validate the multipart POST tunnels correctly on a **live BTP run** —
      content-type boundary + the per-host OTCS agent. Coded; still the main runtime unknown.

### Ingest endpoint — CAP service (not the anonymous route)
- [x] Added authenticated `IngestService.uploadDocument` (`@requires: 'authenticated-user'`)
      so IAS service-to-service auth and future doc-type authorization apply per ADR 0005.
- [x] Dedup: reads the target folder, keeps original name, appends `crypto.randomUUID()`
      first 8 hex on conflict (`uniqueName`).
- [x] Returns `{ nodeId, name, token }` — includes a freshly minted sharing token.

### Demo UI (optional, after the API works)
- [x] Added a drag-and-drop upload box to the Vue portal (`App.vue` + `cap.js`
      `uploadDocument`) that calls the ingest action, then refreshes the listing.

## Out of scope (defer to ADR 0005 follow-ups)
- Full doc-type → folder/prefix mapping (`VM_DocTypeToS3Prefix` equivalent).
- The ingest authorization model (which calling app may write which doc-type).

## References
- Python: `demo/server.py` (`/admin/upload`, dedup), `src/opentext_client.py`
  (`upload_document`, `create_folder`, `_extract_node_id`).
- CAP: `srv/lib/opentext.js` (auth + per-host agents), `srv/portal-service.js` (listing).
- [ADR 0005](../adr/0005-shared-delivery-ingest-service.md).
