# Tasks

Lightweight, GitHub-issue-style task files for `gpc-document-delivery` while the
repo has no remote. One file per task, numbered, newest work at the top of the
table. When a Git remote exists, these can be lifted into real issues verbatim.

## Convention

- File name: `NNNN-short-slug.md` (zero-padded, sequential).
- Each file has: **title**, **Status**, **Context**, **Acceptance criteria**,
  a **Checklist** of steps, and **References**.
- Status values: `todo` | `in-progress` | `blocked` | `done`.
- Tick the checklist boxes as you go; flip **Status** to `done` when the
  acceptance criteria are met.

## Index

| # | Task | Status |
|---|------|--------|
| [0007](0007-per-app-ingest-authorization.md) | Per-app ingest authorization (which app may write which bucket) | done |
| [0006](0006-find-or-create-bucket-folder.md) | Find-or-create a bucket's OpenText folder (self-provisioning) | done |
| [0005](0005-bucket-model-folder-routing.md) | Bucket model + folder routing (the proving vertical) | done |
| [0004](0004-revocable-tokens-audit.md) | Revocable (DB-backed) tokens + fetch audit (ADR 0001 gap) | todo |
| [0003](0003-ingest-api-shared-upload.md) | Ingest API: shared document upload | done |
| [0002](0002-cloudfront-s3-delivery.md) | Option B: CloudFront signed URLs + S3 write-through cache | in-progress |
| [0001](0001-wire-credential-store.md) | Wire the SAP Credential Store (replace env-fallback secret) | todo |

See also [`../adr/`](../adr/) — architecture decisions (ADR 0005 frames the shared
delivery + ingest service these tasks build toward).
