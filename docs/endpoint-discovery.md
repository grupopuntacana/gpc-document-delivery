# OpenText REST endpoint discovery

| Endpoint | Status | Classification | Response snippet |
|----------|-------:|----------------|------------------|
| `/otcs/cs.exe/api/v2/auth` | 400 | mappings-registry | {"error":"The REST API Url could not be found in the mappings registry","request_id":"8285ce95-3c33-455b-b878-3a078d80a3 |
| `/otcs/cs.exe/api/v2/serverinfo` | 400 | mappings-registry | {"error":"The REST API Url could not be found in the mappings registry","request_id":"6dbe1fc7-c883-494f-b870-893c455578 |
| `/otcs/cs.exe/api/v2/members/current` | 400 | http-400 | {"error":"Invalid datatype specified for argument \u0022id\u0022.","request_id":"6aadac10-697d-4d96-b06f-48573782cb95"} |
| `/otcs/cs.exe/api/v2/nodes/1` | 404 | not-found | {"error":"The item you requested could not be accessed. Either it does not exist, or you do not have permission to acces |
| `/otcs/cs.exe/api/v2/nodes/2000` | 200 | ok | {"links":{"data":{"self":{"body":"","content_type":"","href":"\/api\/v2\/nodes\/2000","method":"GET","name":""}}},"resul |
| `/otcs/cs.exe/api/v2/nodes/2000/nodes` | 200 | ok | {"collection":{"paging":{"limit":25,"page":1,"page_total":1,"range_max":6,"range_min":1,"total_count":6},"sorting":{"sor |
| `/otcs/cs.exe/api/v2/forms/nodes/properties` | 400 | mappings-registry | {"error":"The REST API Url could not be found in the mappings registry","request_id":"abf7eac6-41d4-49b7-87b5-9eead02f77 |
| `/otcs/cs.exe/api/v2/businessworkspaces` | 200 | ok | {"links":{"data":{"self":{"body":"","content_type":"","href":"\/api\/v2\/businessworkspaces","method":"GET","name":""}}} |
| `/otcs/cs.exe/api/v2/businessworkspacetypes` | 500 | http-500 | {"error":"Cannot determine the workspace type for this combination: External system ID \u0027?\u0027 and business object |
| `/otcs/cs.exe/api/v1/auth` | 500 | http-500 | {"error":"Cannot get session data.","request_id":"16d992fd-7209-48da-83a3-c68404393511"} |
| `/otcs/cs.exe/api/v1/serverinfo` | 200 | ok | {"mobile":{"blockedActions":[],"client_timeout":20,"cs_viewer_support":false,"offline_use":true},"server":{"advanced_ver |
| `/otcs/cs.exe/api/v1/members/current` | 400 | http-400 | {"error":"Invalid datatype specified for argument \u0022id\u0022.","request_id":"38440fd0-2eea-4c1d-bbca-373a4c158d36"} |
| `/otcs/cs.exe/api/v1/nodes/2000` | 200 | ok | {"addable_types":[{"icon":"\/img\/webdoc\/folder.gif","type":0,"type_name":"Folder"},{"icon":"\/img\/tinyali.gif","type" |
| `/otcs/cs.exe/api/v1/nodes/2000/nodes` | 200 | ok | {"data":[{"volume_id":-2000,"id":35868,"parent_id":2000,"user_id":1000,"name":"BP (Clientes y Proveedores)","type":0,"de |
| `/otcs/cs.exe/api/v1/forms/nodes/properties` | 400 | http-400 | {"error":"The REST API URL is not valid. If you are trying to access an item, it may not exist or you do not have permis |

---

## ArchiveLink repository `C1` (OTAC)

Probed 2026-09-30 with `scripts/probe-archivelink.js` against the server OAC0 names for `C1`
(`OTEMO.grupopuntacana.com:8082`, script `archive`, protocol 0045, no HTTPS). SAP Content Server
HTTP protocol, `GET /archive?<command>&pVersion=…&contRep=C1…`.

| Command | Status | Finding |
|---|---:|---|
| `serverInfo` | 200 | OpenText Archive Center **25.4.0** (build 25.4.0.86), `C1` running, server speaks up to `pVersion` 0047, `serverSecurityMode="SEC_R3L2"` |
| `getCert` (`pVersion=0046`; 0045 → `500 ICS:5014`) | 200 | Three certificates registered: `CN=DS4` (DSA 1024, `rcud`), `CN=SP_OTION` (RSA 1024, `rcudp`), `CN=otemo` (RSA 1024, `rcud`). RSA is accepted. |
| `get` / `info`, unsigned | 401 | `ICS:3003: The URL is not signed or signature is invalid, parameter secKey` — **signed URLs are mandatory** |
| `get`, signed with an unregistered RSA certificate | 401 | `ICS:3001: The referenced certificate having been issued by 'CN=…' with serial:0x… is unknown` — the server parsed our PKCS#7 `secKey` and identified the signer; only the registration is missing |

Conclusion: the fetcher needs `secKey` signing (`srv/lib/seckey.js`) and our certificate
registered on `C1`. Runbook: [setup/archivelink-otac.md](setup/archivelink-otac.md).

---

> **Origin:** Imported from the OpenText CDN Python prototype (`opentext-cdn-prototype`). This is the consolidated, self-contained copy — the prototype repo is archival. Benchmark/latency figures are from the prototype's May 2026 measurement run and have not been re-measured against the CAP implementation. See [docs/README.md → Origins & related work](README.md#origins-and-related-work) for the prototype's role.
