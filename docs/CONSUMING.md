# Consuming document-delivery

How another system gets a short-lived, public download link for a document. There are two kinds
of consumer, and each has its own part of this guide:

| Your system | Where the document lives | You hold | You call | Read |
|---|---|---|---|---|
| **A CAP app on BTP** that stores files with [`@gpc/attachments-opentext`](https://github.com/grupopuntacana/attachments-opentext) | OpenText Content Server (OTCS) | the node ID the plugin returned | `register`, then `linkFor` | [How it works](#how-it-works) and steps 1–7 |
| **A BTP app that only delivers** another app's documents | OTCS | a `docId` the uploading app gave you | `linkFor` | steps 1–5 and 7 |
| **S/4** (or any system holding an ArchiveLink reference) | OpenText Archive Center (OTAC), archived by S/4 | `ARCHIV_ID` + `ARC_DOC_ID` from the link table | `linkForArchive` | [S/4 ArchiveLink documents](#s4-archivelink-documents) |

All three get the same thing back: a link that works without login, expires, and can be revoked.
The caller is always identified by the `azp` claim of its IAS token, never by anything in the
request.

The CAP-app part covers both sides: what the consuming app sets up, and the one change
document-delivery's maintainers make for it. Storage itself isn't covered here. Set it up first
by following the plugin's
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

The actions of `LinkService` (`srv/link-service.cds`, OData v4 at `/odata/v4/link`):

| Action | Who may call | Use it when |
|---|---|---|
| `register(bucket, nodeId) → { docId }` | a **writer** of `bucket` | You just stored a file and want a durable handle to keep and pass around. Mints no link. |
| `linkFor(docId, ttlDays?) → { deliveryUrl, expiresAt }` | a **reader or writer** of the document's bucket | You need a link now. Call it every time; never store the link. |
| `linkForNode(bucket, nodeId, ttlDays?) → { deliveryUrl, expiresAt }` | a **writer** of `bucket` | `register` + `linkFor` in one call, when you don't need to keep the `docId`. |
| `linkForArchive(contRep, archDocId, …) → { docId, deliveryUrl, expiresAt }` | a **reader** of the content repository | The document was archived by S/4 through ArchiveLink. See [S/4 ArchiveLink documents](#s4-archivelink-documents). |

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

Questions about the `docId` and links (reuse, lifetime, lists): see [Common questions](#common-questions).

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

## Common questions

### What does my app store, and what does a link look like over time?

One photo, with the values from a real run on DEV:

```
upload         plugin stores the file         → row.url   = 22745                    (node ID, private)
register       register("onboard-partner-docs", 22745)
                                              → row.docId = "b5RVYZwqzXpA8BEhxQW23g"
first link     linkFor("b5RVYZ…")             → …/invoice/eyJl…AAA   expires Tue
a week later   linkFor("b5RVYZ…")             → …/invoice/eyJl…BBB   expires Wed
another app    linkFor("b5RVYZ…")             → …/invoice/eyJl…CCC   expires Thu
```

| Who | Keeps | Never sees |
|---|---|---|
| OpenText | the bytes, as node `22745` | — |
| Your app's database | `ID`, `url 22745`, `docId b5RVYZ…` | — |
| Your app's API and the browser | `ID`, `docId`, a link at the moment it's shown | `22745` |
| document-delivery | `b5RVYZ… → node 22745, bucket onboard-partner-docs` | — |
| Another app (a reader of your bucket) | `docId b5RVYZ…` | `22745` |

The **`docId`** is what you store and pass around. The node ID stays in your own row, where the
plugin needs it to read the file, and goes nowhere else.

### Can I use the same `docId` many times? For how long?

Yes, for as long as you like. Every `linkFor(docId)` returns a **new** link. Each link expires after
its TTL (24 hours by default); the `docId` does not expire. Store the `docId` once and ask for a link
whenever one is needed. Don't store links.

### When does a `docId` stop working?

`linkFor` answers `404` when:

- the document was **revoked** by document-delivery's maintainers; or
- your app **lost its grant**: its `azp` is no longer in the bucket's `allowedWriters` or
  `allowedReaders`.

### Is a `docId` a link? Can someone use one they found?

Neither. A `docId` can't be opened in a browser; only document-delivery turns it into a link. And an
app that gets hold of a `docId` without a grant on that bucket receives `404`. That is why a `docId`
is safe to store and to expose in your API, and the node ID is not.

### Why can't I get a link straight from a node ID?

Node IDs are sequential integers. A service that minted links for "node N" would let any caller walk
every document in OpenText ([ADR 0006](adr/0006-delivery-link-authorization.md)). So a node ID is
only accepted on the write side (`register` / `linkForNode`), from a writer of the bucket, and only
for a node sitting directly in that bucket's folder. `linkForNode(bucket, nodeId)` is the one-call
version, if you don't need to keep the `docId`.

### Why is it two calls for my app and one for S/4?

It's what each side keeps, not a technical limit. Your app swaps its private node ID for a `docId`
**once**, at upload (`register`); from then on every link is **one** call (`linkFor`). S/4 keeps its
ArchiveLink reference in its own link table, so it asks with that reference every time
(`linkForArchive`, one call that claims and mints together). S/4 is trusted with a whole content
repository; your app only with its own bucket, which is why your path keeps the folder check.

### My screen lists many documents. Should I mint a link per row?

No. Return the documents' metadata (name, type, `docId`) in the list, and mint one link when a user
opens a document:

| 20 items × 5 photos, user opens 2 | Link per row | Link on open |
|---|---|---|
| Calls to document-delivery per list view | 100 | 0 |
| Calls for the 2 opened photos | 0 (already paid) | 2 |
| Live links in responses, caches and logs | 100 | none |

Minting is cheap for document-delivery (a database lookup and a signature, no OpenText call); the
cost is the round trips your app makes on every list load. For viewing inside your own app, the
plugin's authenticated `…/content` endpoint is enough; delivery links are for sharing outside it.
Previews (thumbnails) in lists change the picture, since every image loads anyway: they should wait
for upload-time thumbnails and a batch mint. The family guidance is in the `commons` hub,
`docs/design/document-links-in-lists.md`.

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

> **Draft.** The service side is built and tested. The S/4 side below is a proposal for the S/4
> team: the ABAP has not been run on the S/4 system yet, and a live end-to-end run is waiting on
> the items in [task 0010](tasks/0010-archivelink-delivery.md).

Documents S/4 archives through ArchiveLink (for example IS-U bills: object type `PRINTDOC`,
document type `ISU_BILL`, content repository `C1`) can get a public link **without being
uploaded to BTP**. S/4 already holds the reference in its link table and passes it to
`linkForArchive`. Background: [ADR 0009](adr/0009-archivelink-source-typed-documents.md).

```
S/4                                                  document-delivery
  1. bill is printed and archived → link table row
     (C1, 0AFFC37A…C9FC, PRINTDOC 050000000006)
  2. linkForArchive("C1", "0AFFC37A…C9FC", …)  ───►  checks: caller is a reader of repository C1
                                               ◄───  { docId, deliveryUrl, expiresAt }
  3. put deliveryUrl in the bill email / SMS

Customer
  4. opens deliveryUrl (no login)              ───►  fetches the PDF from the archive, serves it
```

### The call

```
POST https://<document-delivery-srv>/odata/v4/link/linkForArchive
Authorization: Bearer <IAS token of the S/4 client>
Content-Type: application/json

{ "contRep": "C1",
  "archDocId": "0AFFC37AE2C51FD1AE84A8F99394C9FC",
  "sapObject": "PRINTDOC", "objectId": "050000000006", "docType": "ISU_BILL",
  "ttlDays": 30 }
```

```
200 { "docId": "Zk3…", "deliveryUrl": "https://<document-delivery-srv>/doc/<token>",
      "expiresAt": "2026-10-30T13:00:00Z" }
```

| Field | Link-table column | Required | Notes |
|---|---|---|---|
| `contRep` | `ARCHIV_ID` | yes | 2 characters, e.g. `C1`. |
| `archDocId` | `ARC_DOC_ID` | yes | Up to 40 characters. **Send this exact value, not the business key**: a reprint creates a new archived document for the same `OBJECT_ID`, and each one gets its own link. |
| `sapObject` | `SAP_OBJECT` | no | Audit only. |
| `objectId` | `OBJECT_ID` | no | Audit, and the download file name (`ISU_BILL-050000000006.pdf`). |
| `docType` | `AR_OBJECT` | no | Audit and file name. |
| `ttlDays` | | no | How long the link works. Default 1 day; maximum 90. For a bill email, 30 is a reasonable value. |

Rules for the S/4 side:

- **Don't store `deliveryUrl`.** It expires. Ask for a new one each time you send a message.
  Calling again for the same document is cheap and returns the same `docId` with a fresh link.
- **The three optional fields grant nothing.** Access is decided only by who is calling and
  which repository is named.
- **A link can be revoked** by document-delivery's maintainers (for example, a bill sent to the
  wrong customer). It stops working immediately, and new requests for that document return 404.
- **File types:** PDFs, images and plain text open in the browser. Anything else downloads.

### ABAP sketch

Two HTTP destinations in SM59 (type G), so no URL or secret lives in code:

| Destination | Target | Logon |
|---|---|---|
| `DOCDELIVERY_IAS` | `https://<tenant>.accounts.ondemand.com`, path prefix `/oauth2/token` | Basic: user = S/4's IAS client ID, password = its client secret |
| `DOCDELIVERY_SRV` | `https://<document-delivery-srv>`, path prefix `/odata/v4/link/linkForArchive` | none (the code adds the bearer token) |

```abap
" 1. Find the archived document(s) for a print document.
DATA lt_conn TYPE STANDARD TABLE OF toav0.
CALL FUNCTION 'ARCHIV_GET_CONNECTIONS'
  EXPORTING
    objecttype    = 'PRINTDOC'
    object_id     = CONV saeobjid( lv_print_doc )      " e.g. 050000000006
  TABLES
    connections   = lt_conn
  EXCEPTIONS
    nothing_found = 1
    OTHERS        = 2.
IF sy-subrc <> 0.
  RETURN.                                              " not archived (yet)
ENDIF.
" A reprint adds a row: take the newest ISU_BILL.
DELETE lt_conn WHERE ar_object <> 'ISU_BILL'.
SORT lt_conn BY ar_date DESCENDING.
DATA(ls_conn) = lt_conn[ 1 ].

" 2. Get an IAS token (client credentials).
cl_http_client=>create_by_destination(
  EXPORTING destination = 'DOCDELIVERY_IAS'
  IMPORTING client      = DATA(lo_ias) ).
lo_ias->request->set_method( 'POST' ).
lo_ias->request->set_content_type( 'application/x-www-form-urlencoded' ).
lo_ias->request->set_form_field( name = 'grant_type' value = 'client_credentials' ).
" Needed only if calls fail with "401 token issued for different audience":
" lo_ias->request->set_form_field( name  = 'resource'
"   value = 'urn:sap:identity:application:provider:clientid:<document-delivery IAS client id>' ).
lo_ias->send( ).
lo_ias->receive( ).
DATA: BEGIN OF ls_token, access_token TYPE string, END OF ls_token.
/ui2/cl_json=>deserialize( EXPORTING json = lo_ias->response->get_cdata( )
                           CHANGING  data = ls_token ).
lo_ias->close( ).

" 3. Ask document-delivery for the link.
DATA(lv_body) = |\{"contRep":"{ ls_conn-archiv_id }","archDocId":"{ ls_conn-arc_doc_id }",|
             && |"sapObject":"PRINTDOC","objectId":"{ lv_print_doc }",|
             && |"docType":"{ ls_conn-ar_object }","ttlDays":30\}|.
cl_http_client=>create_by_destination(
  EXPORTING destination = 'DOCDELIVERY_SRV'
  IMPORTING client      = DATA(lo_srv) ).
lo_srv->request->set_method( 'POST' ).
lo_srv->request->set_content_type( 'application/json' ).
lo_srv->request->set_header_field( name  = 'Authorization'
                                   value = |Bearer { ls_token-access_token }| ).
lo_srv->request->set_cdata( lv_body ).
lo_srv->send( ).
lo_srv->receive( ).
lo_srv->response->get_status( IMPORTING code = DATA(lv_status) ).

DATA: BEGIN OF ls_link, docid TYPE string, deliveryurl TYPE string, expiresat TYPE string,
      END OF ls_link.
IF lv_status = 200.
  /ui2/cl_json=>deserialize( EXPORTING json = lo_srv->response->get_cdata( )
                             CHANGING  data = ls_link ).
  " ls_link-deliveryurl goes into the message to the customer.
ENDIF.
lo_srv->close( ).
```

Notes on the sketch:

- The token is valid for a while (`expires_in` in the token response). For a bill run, fetch it
  once and reuse it for the batch, not once per bill.
- Treat any status other than 200 as "no link" and send the message without it or retry later.
  Don't show the response body to the customer.
- S/4's standard OAuth client (transaction `OA2C_CONFIG`) can replace step 2. The manual request
  is shown because it makes the optional `resource` parameter easy to add.
- S/4 Private Cloud needs outbound HTTPS to both hosts allowed.

### What each side sets up

| # | Step | Done by |
|---|---|---|
| 1 | An IAS application for S/4 with a dependency on document-delivery (same as [step 1](#1-your-apps-ias-application)), and a client secret for it | S/4 team with the IAS admin |
| 2 | The two SM59 destinations above; outbound access to both hosts | Basis |
| 3 | Tell the maintainers the client ID. It is the `azp` that gets the grant. | S/4 team |
| 4 | Add that `azp` to the repository in `ARCHIVELINK_REPOSITORIES` in `secrets.mtaext`, e.g. `{"C1":{"allowedReaders":["<s4-azp>"]}}`, and redeploy | document-delivery maintainers |
| 5 | Nothing to do: `mta.yaml` sets `DELIVERY_BASE_URL` to the service's own route, so `deliveryUrl` comes back as a full `https://<document-delivery-srv>/doc/<token>` address | — |
| 6 | The fetch path to the archive: the [OTAC runbook](setup/archivelink-otac.md) (`OpenText_OTAC` destination, Cloud Connector mapping, signing certificate registered read-only on `C1`) | document-delivery maintainers, Basis, OpenText admin |

Use a separate IAS client and grant per S/4 system (DEV, QAS, PRD).

### Can a BTP app use this too?

Yes. `linkForArchive` doesn't care that the caller is S/4. A BTP app that reads the ArchiveLink
reference from S/4 (for example a portal that lists a customer's bills through an S/4 OData
service) follows steps 1–5 of the CAP guide, asks to be added to the repository's
`allowedReaders` instead of a bucket, and calls `linkForArchive` through its `DOCUMENT_SERVICE`
destination. It can also keep the returned `docId` and call `linkFor(docId)` later, like any
other document.

### Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `401` from `linkForArchive` | No token, an expired token, or a token issued for a different audience (add the `resource` parameter, see the sketch). |
| `403 caller token carries no azp claim` | The token isn't a client-credentials token of an IAS application. |
| `400` from `linkForArchive` | `contRep` isn't 2 characters `[A-Z0-9]`, `archDocId` isn't 1–40 characters `[A-Za-z0-9]`, or an optional field is longer than its link-table column. |
| `404 not found` from `linkForArchive` | The caller's `azp` isn't in the repository's `allowedReaders`, the repository isn't configured, or the document was revoked. All three return the same 404 on purpose; document-delivery's log says which. |
| `deliveryUrl` starts with `/doc/` | `DELIVERY_BASE_URL` is missing on the deployed app. It comes from `mta.yaml`; redeploy. |
| The link returns `403 invalid token: expired` | It outlived its `ttlDays`. Request a new one. |
| The link returns `404` | The document was revoked. |
| The link returns `502` | document-delivery couldn't read from the archive. In its log, `401 ICS:3001` means the signing certificate isn't registered or enabled on the repository; `401 ICS:3003` means no signing certificate is configured; `404` means that `ARC_DOC_ID` doesn't exist in the repository. |
| `500 archive registry is misconfigured` | `ARCHIVELINK_REPOSITORIES` in document-delivery is malformed. Maintainers' side. |
