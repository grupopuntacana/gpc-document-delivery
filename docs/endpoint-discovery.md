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

> **Origin:** Imported from the OpenText CDN Python prototype (`opentext-cdn-prototype`). This is the consolidated, self-contained copy — the prototype repo is archival. Benchmark/latency figures are from the prototype's May 2026 measurement run and have not been re-measured against the CAP implementation. See [docs/README.md → Origins & related work](README.md#origins-and-related-work) for the prototype's role.
