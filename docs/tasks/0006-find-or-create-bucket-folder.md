# 0006 — Find-or-create a bucket's OpenText folder (self-provisioning)

**Status:** todo
**Depends on:** [0005](0005-bucket-model-folder-routing.md).
**Priority:** optional / deferrable — 0005 + 0007 already ship multi-app upload against
**pre-provisioned** folder nodes. This slice removes the manual provisioning step; skip it if
folders are created out-of-band.
**Architecture:** completes commons epic `document-service.md` T1 by implementing the
`create_folder` / `find_or_create_folder` op deferred in [0003](0003-ingest-api-shared-upload.md).

## Context

0005 routes an upload to a bucket's folder node that an operator provisioned by hand. 0003
explicitly deferred the OpenText folder-create op ("`create_folder` / `find_or_create_folder`
deferred — no doc-type→folder routing yet"). This slice adds it so a bucket can be configured by
**parent + folder name** and self-provision its folder on first use — no OpenText click-ops per
new bucket.

Reuse the existing OTCS write plumbing: the same `withTicket` / `otcsRequest` / `NO_CSRF` /
per-host keep-alive agent path that `uploadDocument` already rides. A folder is a type-0 node
(vs the type-144 document), same `POST .../api/v2/nodes` shape, so this is a small variant of the
proven upload call — not new transport.

## Acceptance criteria

- [ ] `findOrCreateFolder(parentNode, name)` returns the node id, **creating** a type-0 folder
      when none of `parentNode`'s children match `name`, and **returning the existing** id when
      one does (no duplicate folder on the second call).
- [ ] A bucket configured with `{ parentNode, folderName }` (no explicit `folderNode`) resolves
      to a real folder id on first upload; a second upload to the same bucket reuses it —
      assert exactly one create-node POST across two uploads.
- [ ] Create failure surfaces as a `502` via `describeError`, like the upload path.

## Checklist

### OpenText op — `srv/lib/opentext.js`
- [ ] `createFolder(parentNode, name)`: `POST {OTCS}.../api/v2/nodes` multipart, `body` =
      `{ parent_id, type: 0, name }`; return `extractNodeId(res.data)`. Mirror `uploadDocument`'s
      framing (Buffer, `form.getHeaders()`, `NO_CSRF`, `withTicket`).
- [ ] `findOrCreateFolder(parentNode, name)`: reuse `listFolderChildNames(parentNode)` to detect
      an existing child by name; create only on miss. Export both.

### Registry — `srv/lib/buckets.js`
- [ ] Allow a bucket entry to specify `{ parentNode, folderName }`; resolve it through
      `findOrCreateFolder` (memoize the resolved id per bucket to avoid a list on every upload).

### Tests — `test/ingest.test.js` / an opentext unit test
- [ ] Existing folder → no create POST, returns existing id. Missing → one create POST, type 0.
- [ ] Two uploads to a name-configured bucket → exactly one folder-create.

## Definition of Done (commons `cross-cutting.md` §1)
- **DoD-4:** the registry still speaks only `bucket → folder`; folder *names* are config, never
  derived from a context or a request body field.

## Out of scope
- Deleting/renaming folders, nested folder trees, doc-type sub-foldering — not needed to upload.
- Authorization (0007), cache prefixing (epic T3).

## References
- `srv/lib/opentext.js` (`uploadDocument`, `listFolderChildNames`, `withTicket`, `extractNodeId`,
  `NODE_TYPE_DOCUMENT`), Python `src/opentext_client.py` (`create_folder`, `_extract_node_id`).
- [0003](0003-ingest-api-shared-upload.md) deferral note; commons `document-service.md` T1.
