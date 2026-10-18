# MediaFlow API

Node 22.9 or later. Install dependencies from the repository root, copy
`server/.env.example` to `server/.env`, then run `npm run dev -w server`.
Production: `npm run build -w server` followed by `npm run start -w server`.
Both start scripts load `server/.env` when it exists; hosting environment
variables take precedence. Never commit real secrets or `.env` files.

## Endpoints

All endpoints live under `/api`. JSON errors are always shaped as
`{"error":{"code":"INVALID_URL","message":"Human-readable explanation"}}`.
Stream failures after response headers have been sent close the connection;
clients must treat an interrupted transfer as a failed download.

### GET /health

Returns `{"status":"ok","service":"mediaflow","version":"1.0.0"}`.
The endpoint does not contact an upstream provider.

### GET /platforms

Returns a `direct` object with the configured host allowlist, supported formats
and maximum file size, plus `platforms`, an array of explicit platform adapter
metadata. Social page URLs currently return `PLATFORM_RESTRICTED`; none are
advertised as working extractors. The modules document official download/export
options and provide an extension point for a future authorized API integration.

### POST /resolve

Request:

```json
{"url":"https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4"}
```

Response example (the ID and metadata are generated from the source):

```json
{
  "id":"opaque-32-character-base64url-token",
  "title":"flower",
  "platform":"direct",
  "kind":"video",
  "formats":[{
    "id":"original",
    "label":"Original quality",
    "extension":"mp4",
    "mimeType":"video/mp4",
    "size":1128375
  }],
  "expiresAt":"2026-10-18T12:15:00.000Z"
}
```

`kind` is `photo` or `video`. `size` is included only when the source reports its
full size reliably. Width and height are provided for PNG/GIF when the header
contains them. No dimensions, bitrate, duration, quality variant or conversion is
invented. Original source bytes are preserved. Direct files provide a single
original format; this service does not upscale, transcode or produce MP3 files.

Resolution reads at most 64 KiB and closes the probe. It requests a byte range,
but also handles sources that ignore that header. Download and preview requests
contact the source again, so a source may become unavailable after resolution.

### GET /media/:id?format=original&disposition=attachment

The opaque ID identifies a previously resolved URL. `format` defaults to
`original`; other values are rejected. `disposition` defaults to `attachment`;
use `inline` for a preview. Video players may send one standard `Range: bytes=…`
header. Multipart ranges are rejected. The upstream may ignore range requests;
in that case a normal `200` full response is returned.

Successful responses contain a locked supported media MIME type, `nosniff`,
sanitized `Content-Disposition`, and source `Content-Length`/`Content-Range` when
available. CORS exposes these headers so the frontend can show real progress.
Unknown lengths show bytes transferred without a fabricated percentage.

Resolved IDs expire after 15 minutes by default. They are random 192-bit values
stored in a bounded process-local registry. A restart invalidates IDs. Deploy
one backend instance; use a shared bounded TTL store before horizontal scaling.
IDs are bearer capabilities: keep them out of analytics, logs and public posts.

### POST /batch

Request `{"urls":["https://images.unsplash.com/…","https://example.com/…"]}`.
Accepts 1–5 URLs. Duplicates are removed. Results are resolved sequentially and
returned independently:

```json
{
  "results":[
    {"url":"https://images.unsplash.com/…","media":{"id":"…","title":"…","platform":"direct","kind":"photo","formats":[],"expiresAt":"…"}},
    {"url":"https://example.com/…","error":{"code":"HOST_NOT_ALLOWED","message":"…"}}
  ]
}
```

Each successful result has the full `/resolve` schema. Download each successful
result through its `/media/:id` endpoint. The service does not create ZIP files.

## Source and transport policy

- HTTPS only, port 443, no URL credentials, no arbitrary client headers.
- Exact hostname allowlist. Wildcards and IP literal configuration are rejected.
- Initial URLs and every redirect are validated. At most three redirects.
- All DNS answers must be publicly routable. Private, loopback, link-local,
  metadata, reserved, mapped and transition addresses are rejected.
- Each outbound request pins one validated DNS result while retaining the
  original TLS hostname and certificate validation. DNS is not repeated during
  connection establishment. DNS resolution has a deadline too.
- No cookies, authorization headers or upstream credentials are forwarded.
- Bounded signature probing and strict MIME checks reject HTML, SVG, manifests,
  archive files and arbitrary proxy content. Full transfers are re-sniffed.
- Known oversized files reject before streaming; unknown-length streams are
  counted and forcibly closed if they exceed the cap.
- Request timeouts, exact-origin CORS, JSON body limits, rate limits and global
  connection limits bound abuse. Rate limiting is process-local.
- Client disconnects cancel DNS waits, header waits and active transfers and
  immediately release application slots. OS DNS lookups may finish in the
  background; their result cannot start a new connection after cancellation.
- Helmet adds restrictive content security headers; file names cannot inject
  headers. Media IDs reveal no source URL and cannot select another destination.

Default exact source hosts: `images.unsplash.com`, `upload.wikimedia.org`,
`media.w3.org`, and `interactive-examples.mdn.mozilla.net`.
Domain compatibility grants no copyright license. Users must have permission
to save the media. Provider terms and availability still apply.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8787` | Listening port |
| `ALLOWED_ORIGINS` | `http://localhost:5173,http://127.0.0.1:5173` | Comma-separated exact frontend origins |
| `ALLOWED_MEDIA_HOSTS` | Listed above | Comma-separated exact source hostnames |
| `MAX_FILE_BYTES` | `104857600` | Maximum 100 MiB per file |
| `REQUEST_TIMEOUT_MS` | `20000` | DNS and upstream request deadlines |
| `MEDIA_TTL_SECONDS` | `900` | Resolved-token lifetime, max one hour |
| `RATE_LIMIT_PER_MINUTE` | `30` | Per-client resolve/batch/media requests |
| `MAX_CONCURRENT_DOWNLOADS` | `4` | Global simultaneous streamed transfers |
| `TRUST_PROXY_HOPS` | `0` | Explicit trusted reverse proxy depth, 0–3 |

Configure `TRUST_PROXY_HOPS` only after verifying the actual ingress topology.
An incorrect value lets forged forwarding headers evade per-client limits.
Resolves also have a fixed global cap of 12 and the registry holds at most 500
records. CORS is not authentication; retain hosting-level abuse controls for a
public service. Do not add user-supplied source domains dynamically.

## Validation

`npm run check -w server`, `npm run test -w server`, and
`npm run build -w server` verify the implementation. Tests use an injected
transport: no external service is required. They cover private/mixed DNS answers,
redirect rebinding, exact allowlisting, MIME/signature rejection, size limits,
range parsing, token expiry, real HTTP API bytes, changed-source validation,
batch errors and exact CORS. Run an authorized live source smoke test after
deployment because provider access policies can change.
