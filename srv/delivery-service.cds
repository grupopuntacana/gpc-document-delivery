/**
 * SelfTest service — Milestone 1 BTP spike.
 *
 * Two diagnostic actions that prove the BTP plumbing the rest of the port depends on:
 *   checkSecret   -> Credential Store retrieval works (returns lengths/fingerprints only)
 *   pingOpenText  -> Destination Service + OTDS auth works (returns node title + round-trip ms)
 *   version       -> deployed build version (APP_VERSION env, else package.json)
 *
 * Neither action returns secret material. Locked to authenticated users; in production
 * IAS provides identity, locally the mocked auth strategy applies.
 */
@path: 'selftest'
service SelfTestService {

  @requires: 'authenticated-user'
  action checkSecret() returns {
    ok            : Boolean;
    source        : String;  // 'credstore' | 'env'
    secretLen     : Integer;
    keyFingerprint: String;  // sha256 prefix of the CloudFront private key, never the key
  };

  @requires: 'authenticated-user'
  action pingOpenText() returns {
    ok       : Boolean;
    status   : Integer;
    nodeTitle: String;
    ms        : Integer;
  };

  @requires: 'authenticated-user'
  action version() returns {
    version: String;  // deployed build version; mirrors the SPA's __APP_VERSION__
  };
}
