# MediaFlow API

Node 22.9 or later. Install dependencies from the repository root, copy
`server/.env.example` to `server/.env`, configure Python/FFmpeg paths if needed,
then run `npm run setup:media -w server -- --check-runtime` and `npm run dev -w server`.
The repository-wide Vite build requires Node 22.12 or later.
Production: install/check tools, `npm run build -w server`, then `npm run start -w server`.
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

Returns a `direct` object with `publicHosts`, the configured restricted-mode host
list, supported formats, and maximum file size, plus platform metadata. A
platform's `available` status means its resolver feature is enabled; it is not a
guarantee that every source link is accessible from the host. Normal public video
links for YouTube, TikTok, Instagram, Facebook, Pinterest, Reddit, X, and other
yt-dlp-supported video hosts go through the real extractor. Protected content,
unsupported media, and hosting-IP blocks return specific errors.

### POST /resolve

Request:

```json
{"url":"https://archive.org/details/BigBuckBunny_328"}
```

This sample is a real video-page URL. Credit: © 2008 Blender Foundation,
[CC BY 3.0](https://creativecommons.org/licenses/by/3.0/), hosted by
[Internet Archive](https://archive.org/details/BigBuckBunny_328). Preserve its credits.

The response contains `id`, `title`, `platform`, `kind`, `formats`, and `expiresAt`.
Each format contains its actual `id`, `label`, `extension`, and `mimeType`, with
retrievable metadata when available. IDs, titles, qualities, lengths, and expiry
timestamps come from the running resolver; they are not hard-coded sample results.

`kind` is `photo` or `video`. `size` is included only when the source reports its
full size reliably. Width and height are provided for PNG/GIF when the header
contains them. No dimensions, bitrate, duration, quality variant or conversion is
invented. Direct files provide a single original format. For a public video page,
the response instead contains real available `video-…` format IDs, labels,
`hasAudio: true`, available codec/dimension metadata, and optional duration. The
server exposes no raw source URLs, cookies, extractor options, or credentials.
This service does not upscale, transcode, or produce MP3 files.

Direct-file resolution reads at most 64 KiB and closes the probe. It requests a
byte range but handles sources that ignore it. HTML and recognized video pages
use metadata extraction through a guarded egress proxy. Only unencrypted direct
MP4/WebM video files with audio, or video with a compatible separate audio track,
become plans. Manifest-only, silent-only, live, login-required, and DRM formats
are excluded. Actual size is optional until preparation; a source can expire
between metadata resolution and retrieval.

### GET /media/:id?format=FORMAT_ID&disposition=attachment

The opaque ID identifies a resolved record. Select an ID from its `formats`
array. Without `format`, page results use their first available format; direct
files use `original`. Unknown IDs are rejected. `disposition` defaults to
`attachment`; use `inline` for a preview. Video players may send one standard
`Range: bytes=…` header. Multipart ranges are rejected.

For page results, Node securely downloads the selected track(s) to private
temporary files. FFmpeg verifies video/audio stream presence and combines
separate tracks using codec copy, without transcoding or network input. FFmpeg
is required for progressive files too: a mislabeled silent file must not be
served as a complete video. The selected result is prepared once and reused
until expiry. Concurrent requests share preparation; cancellation of all
waiters aborts an unfinished job. Local prepared files provide actual length and
byte-range responses. Direct-file sources may ignore a range request and return
their normal `200` full response.

Successful responses contain a locked supported media MIME type, `nosniff`,
sanitized `Content-Disposition`, and source `Content-Length`/`Content-Range` when
available. CORS exposes these headers so the frontend can show real progress.
Unknown lengths show bytes transferred without a fabricated percentage.

Resolved IDs expire after 15 minutes by default. They are random 192-bit values
stored in a bounded process-local registry. Prepared files share that expiry and
are removed by a periodic cleanup when not leased to an active response. A restart
invalidates IDs. Deploy one backend instance; coordinate shared records,
prepared storage, and limits before horizontal scaling.
IDs are bearer capabilities: keep them out of analytics, logs and public posts.

### POST /batch

Request `{"urls":["https://images.unsplash.com/…","https://example.com/…"]}`.
Accepts 1–5 URLs. Duplicates are removed. Results are resolved sequentially and
returned independently:

```json
{
  "results":[
    {"url":"https://images.unsplash.com/…","media":{"id":"…","title":"…","platform":"direct","kind":"photo","formats":[],"expiresAt":"…"}},
    {"url":"https://example.com/…","error":{"code":"VIDEO_NOT_FOUND","message":"…"}}
  ]
}
```

Each successful result has the full `/resolve` schema. Download each successful
result through its `/media/:id` endpoint. The service does not create ZIP files.

## Source and transport policy

- HTTPS only, port 443, no URL credentials, no arbitrary client headers.
- Public HTTPS media is enabled by default. `ALLOW_PUBLIC_MEDIA=false` requires
  exact configured hostnames for input and media fetches; wildcards and IP
  literal configuration are rejected.
- Initial URLs and every redirect are validated. At most three redirects.
- All DNS answers must be publicly routable. Private, loopback, link-local,
  metadata, reserved, mapped and transition addresses are rejected.
- Each outbound request pins one validated DNS result while retaining the
  original TLS hostname and certificate validation. DNS is not repeated during
  connection establishment. DNS resolution has a deadline too.
- No cookies, authorization headers, or upstream credentials are forwarded.
  Extracted tracks can use only sanitized source-required User-Agent/Referer
  values; clients cannot supply arbitrary upstream headers.
- Bounded signature probing and MIME checks reject HTML, SVG, manifests, archives,
  and arbitrary content from media responses. HTML can enter the page resolver,
  but cannot be served back as a downloaded file. Full direct transfers are re-sniffed.
- yt-dlp page/API/manifest network requests use a loopback authenticated egress
  proxy that rejects non-public DNS and pins the checked address. Bundled EJS
  executes only through Deno with denied network/file/environment permissions.
  User/system config, plugins, remote components, and Node EJS fallback are disabled.
- Only Node fetches selected media bytes. FFmpeg receives local, signature-checked
  MP4/WebM containers, forced demuxers, disabled external MP4 references, and a
  `file,pipe` protocol whitelist. No source URL reaches FFmpeg.
- Known oversized files reject before streaming; unknown-length streams are
  counted and forcibly closed if they exceed the cap.
- Request timeouts, exact-origin CORS, JSON body limits, rate limits and global
  connection limits bound abuse. Rate limiting is process-local.
- Client disconnects cancel DNS waits, header waits and active transfers and
  immediately release application slots. OS DNS lookups may finish in the
  background; their result cannot start a new connection after cancellation.
- Helmet adds restrictive content security headers; file names cannot inject
  headers. Media IDs reveal no source URL and cannot select another destination.

Default exact restricted-mode hosts: `images.unsplash.com`, `upload.wikimedia.org`,
`media.w3.org`, and `interactive-examples.mdn.mozilla.net`. Public-media mode does
not require these hostnames but retains DNS, redirect, content, size, and timeout checks.
Domain compatibility grants no copyright license. Users must have permission
to save the media. Provider terms and availability still apply.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8787` | Listening port |
| `ALLOWED_ORIGINS` | `http://localhost:5173,http://127.0.0.1:5173` | Comma-separated exact frontend origins |
| `ALLOW_PUBLIC_MEDIA` | `true` | Permit validated media on public HTTPS hosts |
| `ALLOWED_MEDIA_HOSTS` | Listed above | Exact source hostnames in restricted mode |
| `EXTRACTOR_ENABLED` | `true` | Enable public video-page extraction |
| `EXTRACTOR_PATH` | `server/.bin/yt-dlp` | Installed pinned zipimport executable |
| `PYTHON_PATH` | `python3` (`python` on Windows) | Python executable |
| `DENO_PATH` | Adjacent to extractor | Restricted EJS runtime executable |
| `FFMPEG_PATH` | `ffmpeg` | Local verification/mux executable |
| `EXTRACTION_TIMEOUT_MS` | `65000` | Page resolution deadline |
| `DOWNLOAD_TIMEOUT_MS` | `120000` | Track preparation deadline |
| `MAX_FILE_BYTES` | `104857600` | 100 MiB file cap and aggregate video-plus-audio input cap |
| `REQUEST_TIMEOUT_MS` | `20000` | DNS and upstream request deadlines |
| `MEDIA_TTL_SECONDS` | `900` | Resolved-token lifetime, max one hour |
| `RATE_LIMIT_PER_MINUTE` | `30` | Per-client resolve/batch/media requests |
| `MAX_CONCURRENT_DOWNLOADS` | `4` | Global simultaneous streamed transfers |
| `TRUST_PROXY_HOPS` | `0` | Explicit trusted reverse proxy depth, 0–3 |

Configure `TRUST_PROXY_HOPS` only after verifying the actual ingress topology.
An incorrect value lets forged forwarding headers evade per-client limits.
Resolves also have a fixed global cap of 12 and the registry holds at most 500
records. Preparation has a fixed cap of two jobs and a temporary-storage budget
of four times `MAX_FILE_BYTES`, including reservations for active jobs. Leased
files are retained until active responses release them. CORS is not authentication;
retain hosting-level abuse controls for a public service.

## Validation

`npm run check -w server`, `npm run test -w server`, and
`npm run build -w server` verify the implementation. Network behavior uses an
injected transport so regression tests need no external provider. Real FFmpeg
preparation tests need an installed executable; CI installs FFmpeg and requires
those checks. Coverage includes private/mixed DNS, rebinding, optional host
restrictions, proxy authorization, MIME/signatures, byte caps, ranges, expiry,
actual HTTP bytes, changed-source validation, cancellation, batches, CORS,
progressive audio/video verification, offline muxing, and temporary-file cleanup.
Run authorized live page-resolution and audio/video download checks after
deployment because source policies can differ from local access and change over time.
