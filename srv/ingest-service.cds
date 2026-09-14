/**
 * IngestService — the seed of the shared "ingest" capability group (ADR 0005).
 *
 * `uploadDocument` stores a document in OpenText (over the Cloud Connector tunnel) and
 * returns the new `nodeId`, the (possibly de-duplicated) stored name, and a freshly minted
 * sharing token so the caller can hand out an /invoice/{token} link immediately.
 *
 * Authenticated, unlike the anonymous /invoice/{token} deliver route: other BTP apps call
 * this via IAS service-to-service auth (or a portal user). The token is the credential on
 * deliver; ingest is a WRITE and must not be anonymous.
 *
 * The file rides in the JSON body as base64 (`contentBase64`) — simple and proxy-friendly
 * for the service-to-service seed; the demo drag-and-drop UI is the first client.
 *
 * Uploads are routed by **bucket**: the caller names a bucket and `srv/lib/buckets.js`
 * maps it to the OpenText folder the document lands in (task 0005). A bucket configured
 * with a parent node + folder name creates that folder on its first upload instead of
 * requiring one provisioned by hand (task 0006).
 *
 * Which app may write which bucket is the bucket's `allowedWriters` ACL (task 0007): the
 * caller's OAuth `azp` is derived from its token and checked against it, so one app cannot
 * write another's namespace. There is deliberately no `app`/`source` field here — authority
 * is derived, never declared, and an undeclared field is rejected outright.
 */
@path: 'ingest'
service IngestService {

  @requires: 'authenticated-user'
  action uploadDocument(
    bucket        : String,      // target bucket; an opaque namespace, resolved to an
                                 // OpenText folder by the registry (never a domain concept)
    fileName      : String,      // original filename, e.g. 'invoice.pdf'
    contentType   : String,      // MIME type; defaults to application/pdf when omitted
    contentBase64 : LargeString  // the file bytes, base64-encoded
  ) returns {
    nodeId : Int64;             // new OpenText node id (Int64: opaque id, never truncate)
    name   : String;            // stored name (original, or UUID-suffixed on collision)
    token  : String;            // sharing token for /invoice/{token}
  };
}
