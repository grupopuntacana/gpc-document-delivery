/**
 * PortalService — document listing for the customer portal.
 *
 * `documents()` discovers documents live from OpenText (the same call SAP would make
 * from the production app) and returns one row per document with a freshly minted,
 * short-lived sharing token. The Vue SPA renders these grouped by category, each with
 * an "Open PDF" link to the anonymous /invoice/{token} route (served in srv/server.js).
 *
 * Authenticated: this is the logged-in customer's portal. The /invoice/{token} route is
 * separately anonymous (the token is the credential).
 */
type DocRow {
  nodeId     : Integer;
  displayName : String;
  category    : String;  // invoice | energy | other
  subtitle    : String;
  sizeBytes   : Integer;
  token       : String;  // base64url(payload).base64url(hmac) — feeds /invoice/{token}
}

@path: 'portal'
service PortalService {
  @requires: 'authenticated-user'
  function documents() returns array of DocRow;

  // Current logged-in user, for the SPA header. Resolved from the IAS token (req.user);
  // under mocked hybrid auth it returns the mock user (e.g. 'alice').
  @requires: 'authenticated-user'
  function whoami() returns {
    id    : String;
    name  : String;
    email : String;
  };
}
