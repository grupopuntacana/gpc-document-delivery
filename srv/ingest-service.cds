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
 * for the service-to-service seed; the demo drag-and-drop UI is the first client. doc-type
 * → folder routing and the per-caller ingest authorization model are deferred (ADR 0005).
 */
@path: 'ingest'
service IngestService {

  @requires: 'authenticated-user'
  action uploadDocument(
    fileName      : String,      // original filename, e.g. 'invoice.pdf'
    contentType   : String,      // MIME type; defaults to application/pdf when omitted
    contentBase64 : LargeString  // the file bytes, base64-encoded
  ) returns {
    nodeId : Integer;            // new OpenText node id
    name   : String;            // stored name (original, or UUID-suffixed on collision)
    token  : String;            // sharing token for /invoice/{token}
  };
}
