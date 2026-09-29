# Consuming document-delivery from a CAP app

This guide is for a CAP app that stores files in OpenText with
[`@gpc/attachments-opentext`](https://github.com/grupopuntacana/attachments-opentext) and now
needs to **share** them: a short-lived download link for a user or customer, or another app
delivering a file this app uploaded. It covers both sides: what the consuming app sets up, and
the one change document-delivery's maintainers make for it.

Storage itself isn't covered here. Set it up first by following the plugin's
[INSTALL.md](https://github.com/grupopuntacana/attachments-opentext/blob/master/INSTALL.md).

## How it works

The plugin writes bytes straight to OpenText and stores the resulting **node ID** in the
attachment row's `url`. That node ID is private to your app (a sequential integer that would let
callers guess other documents), so it never leaves your app. document-delivery turns it into
something you can hand out:

```
Your app (writer of bucket "my-app-docs")          document-delivery
  1. attachments.put(...)   → url = node 8899
  2. register("my-app-docs", 8899)           ───►  checks: caller is a writer of the bucket,
                                                    node 8899 sits in the bucket's folder
                                             ◄───  { docId: "d-abc" }   (opaque)
  3. store docId on your own row
  ...later, on demand...
  4. linkFor("d-abc")                        ───►  checks: caller is a reader (or writer)
                                             ◄───  { deliveryUrl, expiresAt }   (short-lived)

Another app (reader of "my-app-docs")
  5. linkFor("d-abc")   (docId received from your app)  ───►  same read check, fresh link
```

The three actions of `LinkService` (`srv/link-service.cds`, OData v4 at `/odata/v4/link`):

| Action | Who may call | Use it when |
|---|---|---|
| `register(bucket, nodeId) → { docId }` | a **writer** of `bucket` | You just stored a file and want a durable handle to keep and pass around. Mints no link. |
| `linkFor(docId, ttlDays?) → { deliveryUrl, expiresAt }` | a **reader or writer** of the document's bucket | You need a link now. Call it every time; never store the link. |
| `linkForNode(bucket, nodeId, ttlDays?) → { deliveryUrl, expiresAt }` | a **writer** of `bucket` | `register` + `linkFor` in one call, when you don't need to keep the `docId`. |

`ttlDays` is optional. Leave it out to get document-delivery's short default
(`LINKFOR_TOKEN_TTL_HOURS`, 24 hours).

Access is granted **per bucket**, like S3's `PutObject` / `GetObject`: `allowedWriters` may
claim nodes and mint links, `allowedReaders` may only mint links. The caller is identified by the
`azp` claim of its IAS token, never by anything in the request. See
[ADR 0008](adr/0008-bucket-scoped-cross-app-reads.md) for the reasoning.

## Checklist

| # | Step | Done by |
|---|---|---|
| 1 | [Give your app its own IAS application](#1-your-apps-ias-application) | consuming app |
| 2 | [Create the `DOCUMENT_SERVICE` destination](#2-the-document_service-destination) | consuming app |
| 3 | [Find your `azp`](#3-find-your-azp) | consuming app |
| 4 | [Request a bucket](#4-request-a-bucket) | consuming app asks, **document-delivery maintainers** apply |
| 5 | [Wire the remote service](#5-wire-the-remote-service) | consuming app |
| 6 | [Call `register` and `linkFor`](#6-call-register-and-linkfor) | consuming app |
| 7 | [Verify](#7-verify) | consuming app |

An app that only **reads** another app's documents does steps 1–5 and 7, asks to be added to
that bucket's `allowedReaders` in step 4, and only ever calls `linkFor`.

## 1. Your app's IAS application

document-delivery trusts the `azp` of the calling token, so your app must call as **its own**
IAS application. Never borrow another app's client or add a secret to a shared one: every caller
would share one `azp`, and the bucket grants would stop meaning anything.

In your `mta.yaml`, declare the IAS instance with a dependency on document-delivery's API:

```yaml
resources:
  - name: <app>-ias
    type: org.cloudfoundry.managed-service
    parameters:
      service: identity
      service-name: <app>-ias
      service-plan: application
      config:
        display-name: <app>
        oauth2-configuration:
          token-policy:
            access-token-format: "jwt"
        consumed-apis:
          - name: document-delivery-ias-api   # must match document-delivery's provided-api
        xsuaa-cross-consumption: true
```

**Declaring `consumed-apis` isn't enough on its own.** The broker stores the parameter without
creating the dependency in IAS. After deploying, open the **IAS admin console** →
*Applications* → *\<app\>* → *Dependencies* → *Add*, provider **document-delivery**, API
**`document-delivery-ias-api`**. Without it, calls fail with `401 token issued for different
audience`, or the token endpoint answers *"Service provider has no consumed apis defined"*.

## 2. The `DOCUMENT_SERVICE` destination

Create a destination named `DOCUMENT_SERVICE` on **your app's destination service instance**
(BTP cockpit → *Instances and Subscriptions* → `<app>-destination` → *Destinations*). An
instance-level destination wins over a subaccount-level one of the same name, so a
`DOCUMENT_SERVICE` destination that already exists in the subaccount for another app doesn't get
in the way.

| Property | Value |
|---|---|
| Name | `DOCUMENT_SERVICE` |
| Type | HTTP |
| URL | document-delivery's `srv` route, e.g. `https://<document-delivery-srv route>` (no path) |
| Proxy type | Internet |
| Authentication | `OAuth2ClientCredentials` |
| Client ID / Secret | from a service key on **your** IAS instance: `cf create-service-key <app>-ias dd-client -c '{"credential-type":"SECRET"}'` then `cf service-key <app>-ias dd-client` |
| Token Service URL | `https://<tenant>.accounts.ondemand.com/oauth2/token` |

If you'd rather not handle a secret, use an X.509 key (`"credential-type":"X509_GENERATED"`) and
the destination's client-certificate variant instead.

If calls still fail with `401 … different audience` once the IAS dependency exists, add the
additional property `tokenService.body.resource` =
`urn:sap:identity:application:provider:clientid:<document-delivery's IAS client id>` so the token
is issued for document-delivery. Read that client ID from `cf env document-delivery-srv`
(`VCAP_SERVICES.identity[].credentials.clientid`).

## 3. Find your `azp`

The `azp` document-delivery sees is the **client ID the `DOCUMENT_SERVICE` destination
authenticates with**, the one from step 2. Two ways to confirm it:

- Call any `LinkService` action. A denied call logs the caller's `azp` in document-delivery
  (`… denied for azp "<value>" …`); ask the maintainers for that line, or read it with
  `cf logs document-delivery-srv --recent` if you have access to the space.
- Fetch a token with the destination's credentials and decode the JWT payload: the `azp` claim.

With a service key from step 2 it's your IAS application's client ID (every key on one IAS
application shares that client ID, which is why each app needs its own application).

## 4. Request a bucket

This is the only step document-delivery's maintainers must do. Send them:

```
bucket name:       <app>-docs              (your choice; lowercase, hyphenated)
folderNode:        <your OPENTEXT_INGEST_FOLDER_ID>
allowedWriters:    ["<your azp from step 3>"]
allowedReaders:    ["<azp of any other app that must deliver your files>"]   (optional)
```

`folderNode` **must equal** the `OPENTEXT_INGEST_FOLDER_ID` your app gives the plugin. If they
differ, uploads succeed but every `register` is rejected, because the node isn't in the bucket's
folder.

To be added as a **reader** of an existing bucket, send only its name and your `azp`.

### For document-delivery maintainers

Add or edit the entry in `OPENTEXT_BUCKETS` in `secrets.mtaext`, never with `cf set-env` (a value
set that way is lost on the next deploy), then redeploy:

```bash
mbt build
cf deploy mta_archives/document-delivery_<version>.mtar -e secrets.mtaext
```

The format and rules are in the README's
[Bucket registry](../README.md#bucket-registry-opentext_buckets) section.

## 5. Wire the remote service

**Proxy model.** Copy document-delivery's contract into your app as
`srv/external/DOCUMENT_SERVICE.cds`. Keep it in step with `srv/link-service.cds` in this repo when
you upgrade.

```cds
// Proxy of gpc-document-delivery's LinkService (/odata/v4/link). Keep in step with
// srv/link-service.cds in that repo.
service DOCUMENT_SERVICE {
  action register(bucket : String, nodeId : Int64) returns {
    docId : String;
  };
  action linkFor(docId : String, ttlDays : Integer) returns {
    deliveryUrl : String;
    expiresAt   : Timestamp;
  };
  action linkForNode(bucket : String, nodeId : Int64, ttlDays : Integer) returns {
    deliveryUrl : String;
    expiresAt   : Timestamp;
  };
}
```

**`package.json`.** Point `DOCUMENT_SERVICE` at the destination, and use a local stand-in in
development so nothing remote is needed:

```jsonc
"cds": {
  "requires": {
    "DOCUMENT_SERVICE": {
      "kind": "odata-v4",
      "model": "srv/external/DOCUMENT_SERVICE",
      "credentials": { "destination": "DOCUMENT_SERVICE", "path": "/odata/v4/link" },
      "[development]": { "impl": "srv/external/DOCUMENT_SERVICE.js" },
      "[hybrid]": { "impl": "@sap/cds/srv/remote-service.js" }
    },
    "destinations": true
  }
}
```

**Development stand-in** (`srv/external/DOCUMENT_SERVICE.js`). A plain `cds.Service`, because in
development the plugin's database backend returns a UUID as `url`, which the `Int64` contract
would reject:

```js
const cds = require('@sap/cds');

module.exports = class DocumentDeliveryStandIn extends cds.Service {
  init() {
    this.on('register', (req) => ({ docId: `dev-${String(req.data.nodeId).slice(0, 8)}` }));
    this.on('linkFor', (req) => ({
      deliveryUrl: `http://localhost:4004/dev-link/${req.data.docId}`,
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    }));
    return super.init();
  }
};
```

**`mta.yaml`.** Put the bucket name next to the folder ID, in the descriptor:

```yaml
modules:
  - name: <app>-srv
    properties:
      OPENTEXT_INGEST_FOLDER_ID: "<folder node ID>"
      DOCUMENT_SERVICE_BUCKET: "<app>-docs"
    requires:
      - name: <app>-ias
      - name: <app>-destination
      - name: <app>-connectivity
```

## 6. Call `register` and `linkFor`

Add a `docId` column to your attachments entity, and hide `url` from your API:

```cds
entity Documents : Attachments {
  docId : String(40);   // document-delivery's opaque handle; safe to expose
}
annotate MyService.Documents with { url @cds.api.ignore; }
```

Claim the node right after storing it. If the claim fails, delete what you stored, so a failed
upload leaves nothing behind:

```js
const attachments = await cds.connect.to('attachments');
const dd = await cds.connect.to('DOCUMENT_SERVICE');
const bucket = process.env.DOCUMENT_SERVICE_BUCKET;

await attachments.put(Documents, { ID, filename, mimeType, url: attachments.createUrlForAttachment(), content });
const { url } = await SELECT.one.from(Documents).columns('url').where({ ID });

try {
  // url is a numeric string; the contract types nodeId as Int64.
  const nodeId = /^\d+$/.test(url) ? Number(url) : url;
  const { docId } = await dd.send('register', { bucket, nodeId });
  await UPDATE(Documents).set({ docId }).where({ ID });
} catch (e) {
  await DELETE.from(Documents).where({ ID });
  await attachments.emit('DeleteAttachment', { url, target: Documents.name });
  throw e;
}
```

Mint a link whenever one is needed, and don't store it: it's a short-lived credential.

```js
const { deliveryUrl, expiresAt } = await dd.send('linkFor', { docId });
```

Don't pass document-delivery's error details on to your own callers. Log them and return a
generic message: a response can include node IDs.

## 7. Verify

- **Development** (`cds watch`): the stand-in answers, so uploads and links work with nothing
  remote.
- **Hybrid**: bind your destination and connectivity services (`cds bind`), then run
  `cds watch --profile hybrid`. Don't put a `DOCUMENT_SERVICE` entry in a local `destinations`
  environment variable (e.g. in `.env`): the Cloud SDK reads that variable before the destination
  service, can't fetch an OAuth token from it, and fails with *"no auth tokens could be fetched"*.
- **Deployed**: upload a file, check that the row has a `docId`, then open the `deliveryUrl`
  from `linkFor`.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `401 token issued for different audience` | The IAS dependency is missing (step 1, admin console), or the token lacks document-delivery's audience (step 2, `tokenService.body.resource`). |
| Token endpoint: *"Service provider has no consumed apis defined"* | `consumed-apis` was declared but the dependency was never created in the IAS admin console (step 1). |
| `403 caller token carries no azp claim` | The destination isn't using client credentials of an IAS application (step 2). |
| `404 not found` from `register` / `linkForNode` | One of: your `azp` isn't in the bucket's `allowedWriters`; the bucket name is wrong; the node isn't in the bucket's `folderNode` (it must equal your `OPENTEXT_INGEST_FOLDER_ID`); the node was revoked. All return the same 404 on purpose; document-delivery's log says which. |
| `404 not found` from `linkFor` | Unknown `docId`, your `azp` isn't a reader or writer of its bucket, or the document was revoked. |
| Grant worked, then stopped after a redeploy of document-delivery | The bucket was set with `cf set-env`, not in `secrets.mtaext` (step 4). |
| *"no auth tokens could be fetched"* in hybrid | A local `destinations` variable defines `DOCUMENT_SERVICE` (step 7). Remove it. |
| `500 bucket registry is misconfigured` | `OPENTEXT_BUCKETS` in document-delivery is malformed. Maintainers' side. |

## S/4 ArchiveLink documents

This section is for **S/4**, not a CAP app. Documents S/4 archives through ArchiveLink (for
example IS-U bills: `PRINTDOC` / `ISU_BILL` in content repository `C1`) can get a public link
without being uploaded to BTP. S/4 already holds the locator in its link table (TOA01
`ARCHIV_ID` + `ARC_DOC_ID`) and passes it to `linkForArchive`. See
[ADR 0009](adr/0009-archivelink-source-typed-documents.md).

```
POST /odata/v4/link/linkForArchive
Authorization: Bearer <IAS client-credentials token of the S/4 client>
{ "contRep": "C1", "archDocId": "0AFFC37AE2C51FD1AE84A8F99394C9FC",
  "sapObject": "PRINTDOC", "objectId": "050000000006", "docType": "ISU_BILL", "ttlDays": 7 }

→ { "docId": "…", "deliveryUrl": "https://<srv>/doc/<token>", "expiresAt": "…" }
```

- **Send the exact `ARC_DOC_ID`, not the business key.** A reprint creates a new archived
  document for the same `OBJECT_ID`; each `ARC_DOC_ID` gets its own row and link.
- `sapObject` / `objectId` / `docType` are optional. They go into the audit row and the download
  name (`ISU_BILL-050000000006.pdf`), and they grant nothing.
- Calling again for the same document returns the same `docId` and a fresh link.
  `linkFor(docId)` works too.
- The link is a `/doc/<token>` URL. It stops working immediately if the document is revoked.

**Setup:**

1. **S/4 → BTP auth.** Create an IAS application for S/4 with a dependency on document-delivery
   (like [step 1](#1-your-apps-ias-application)). In S/4, configure an OAuth 2.0 client (OA2C)
   and an SM59 HTTP destination to the document-delivery srv host that uses it.
2. **Grant.** Maintainers add S/4's `azp` to the repository in `ARCHIVELINK_REPOSITORIES` in
   `secrets.mtaext`, e.g. `{"C1":{"allowedReaders":["<s4-azp>"]}}`.
3. **Fetch path.** Maintainers create the BTP destination `OpenText_ArchiveCenter` (OnPremise,
   through the Cloud Connector) pointing at the archive server that serves `C1` (the host in S/4
   transaction OAC0). document-delivery calls `…/archive?get&contRep=C1&docId=…&compId=data` on it.

| Symptom | Cause and fix |
|---|---|
| `400` from `linkForArchive` | `contRep` isn't 2 chars `[A-Z0-9]`, `archDocId` isn't 1–40 chars `[A-Za-z0-9]`, or a metadata field is longer than its TOA01 width. |
| `404 not found` from `linkForArchive` | S/4's `azp` isn't in the repository's `allowedReaders`, the repository isn't configured, or the document was revoked. |
| `/doc/<token>` returns `502` | The archive server couldn't be reached or refused the request. A `401`/`403` in the log usually means repository `C1` requires signed URLs (not supported yet); a `404` means the `ARC_DOC_ID` doesn't exist there. |
| `500 archive registry is misconfigured` | `ARCHIVELINK_REPOSITORIES` in document-delivery is malformed. Maintainers' side. |
