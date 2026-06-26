# Architecture Diagrams — System Design Walkthrough

Three views for explaining the prototype to the team, interview-style.

> **Tip:** copy any of the ```mermaid blocks below into [excalidraw.com](https://excalidraw.com) via **Menu → Generate → Mermaid to Excalidraw** to get the whiteboard look.

---

## 1. Component view — who talks to whom

```mermaid
flowchart LR
    User([Customer Browser])

    subgraph Edge["Edge / Public"]
        Stable["billing.gpc.com/invoice/{token}<br/><i>stable URL contract</i>"]
        CF["CloudFront<br/><i>signed URL, 5-min TTL</i>"]
    end

    subgraph App["Application layer (CAP / Node.js)"]
        TR["token.js<br/><i>HMAC verify, stateless</i>"]
        Pub["cdn.js + cloudfront.js<br/><i>cache-aside</i>"]
        OT["opentext.js<br/><i>OTDS ticket auth</i>"]
    end

    subgraph Storage["Storage"]
        S3[("S3 Cache<br/><i>cache-only=true<br/>lifecycle TTL</i>")]
        OTCS[("OpenText OTCS<br/><i>source of truth</i>")]
        OTDS[("OTDS<br/><i>federated auth</i>")]
    end

    User --> Stable
    Stable --> TR
    TR -->|302 redirect| User
    TR --> Pub
    Pub -->|HEAD / GET| S3
    Pub -->|on miss| OT
    OT -->|auth| OTDS
    OT -->|download PDF| OTCS
    Pub -->|PUT on miss| S3
    User -->|signed URL fetch| CF
    CF --> S3

    classDef cache fill:#fef3c7,stroke:#92400e
    classDef truth fill:#dbeafe,stroke:#1e40af
    classDef app fill:#e0e7ff,stroke:#3730a3
    class S3 cache
    class OTCS,OTDS truth
    class TR,Pub,OT app
```

---

## 2. Cache HIT — the hot path (the pitch)

This is the 99% case after warm-up. Three hops, no OpenText touch.

```mermaid
sequenceDiagram
    autonumber
    participant U as Customer
    participant TR as token.js
    participant Pub as cdn.js
    participant S3 as S3 Cache
    participant CF as CloudFront

    U->>TR: GET /invoice/{token}
    TR->>TR: HMAC verify + decode<br/>(node_id, expiry)
    TR->>Pub: publish(node_id)
    Pub->>S3: HEAD node_id
    S3-->>Pub: 200 (exists)
    Pub->>Pub: sign CloudFront URL<br/>(RSA-2048, 5-min TTL)
    Pub-->>TR: signed URL
    TR-->>U: 302 -> CloudFront URL
    U->>CF: GET signed URL
    CF->>S3: fetch (OAC)
    CF-->>U: PDF bytes
```

---

## 3. Cache MISS — the cold path

First fetch per document. Pays the OpenText cost once, then it's cached.

```mermaid
sequenceDiagram
    autonumber
    participant U as Customer
    participant TR as token.js
    participant Pub as cdn.js
    participant S3 as S3 Cache
    participant OT as opentext.js
    participant OTDS as OTDS
    participant OTCS as OpenText OTCS
    participant CF as CloudFront

    U->>TR: GET /invoice/{token}
    TR->>Pub: publish(node_id)
    Pub->>S3: HEAD node_id
    S3-->>Pub: 404
    Pub->>OT: download(node_id)
    OT->>OTDS: POST credentials
    OTDS-->>OT: OTDS ticket
    OT->>OTCS: GET /nodes/{id}/content<br/>header: OTDSTicket
    OTCS-->>OT: PDF bytes
    OT-->>Pub: bytes
    Pub->>S3: PUT (cache-only=true, source-of-truth=opentext)
    Pub->>Pub: sign CloudFront URL
    Pub-->>TR: signed URL
    TR-->>U: 302 -> CloudFront URL
    U->>CF: GET signed URL
    CF-->>U: PDF bytes
```

> CloudFront URL signing lives in `srv/lib/cloudfront.js`; the S3 cache-aside read/write-through lives in `srv/lib/cdn.js`. The Python prototype's single `cdn_publisher.py` is split into those two modules on the CAP side.

---

## Talking points (interview-style)

**Why this shape:**
- **S3 is a cache, not a store.** `cache-only=true` tag + lifecycle policy + `source-of-truth=opentext` metadata. OpenText remains authoritative. Compliance-friendly.
- **Stable customer URL ≠ asset URL.** The `/invoice/{token}` contract never changes; signed CloudFront URLs are minted fresh per request and expire in 5 minutes.
- **Stateless tokens (HMAC).** No session store, no DB lookup on the redirect path — horizontal scale is trivial.
- **Auth gotcha worth a slide.** In CE 25.4 with OTDS federation, the `OTCSTicket` response header is **not** a valid standalone credential. We send `OTDSTicket` on every OTCS call. Discovered the hard way (see `docs/endpoint-discovery.md`).

**What we measured:** `benchmarks/run-*.json` (prototype script) — cold path includes the OpenText hop; warm path is ~CloudFront latency only.

**What we deliberately did NOT build:** async, a web framework in `srv/`, a session store, signed-URL caching. All would obscure the architecture decision under review.

---

> **Origin:** Imported from the OpenText CDN Python prototype (`opentext-cdn-prototype`). This is the consolidated, self-contained copy — the prototype repo is archival. Benchmark/latency figures are from the prototype's May 2026 measurement run and have not been re-measured against the CAP implementation. See [docs/README.md → Origins & related work](README.md#origins-and-related-work) for the prototype's role.
