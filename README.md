# MediaFlow

A cinematic, responsive media downloader with a React interface and a separately hosted, restricted Express API. Midnight surfaces, violet light, cyan details, editorial typography, and thoughtful motion make a practical workflow feel considered.

**Real files. Honest compatibility.** MediaFlow downloads publicly reachable direct image and video files from an explicit host allowlist. Platform modules identify TikTok, Instagram, Facebook, YouTube, Pinterest, Reddit, and X links and explain their restrictions. These modules do **not** scrape social pages or bypass platform controls. A public post URL is not the same as a downloadable media URL.

![MediaFlow desktop interface](docs/preview.png)

## Included

- Responsive homepage, floating media showcase, downloader, platform compatibility, three-step guide, feature cards, FAQ, and legal pages.
- Dark and light themes, Motion for React entrances and reveals, restrained CSS lighting, hover details, and reduced-motion support.
- URL validation, clipboard paste, real server-backed metadata, image/video previews, original-file downloads, supported-source batch processing, cancellation, friendly errors, and retry.
- Progress based on received bytes when the server exposes a useful content length. No invented percentage when it does not.
- MP4, WebM, JPG, PNG, WebP, and GIF handling. A quality selector reflects variants actually supplied by the source; direct-file sources expose their original variant.
- Exact media-host allowlisting, public-IP checks, DNS-pinned outbound requests, validated redirects, request deadlines, response limits, attachment headers, rate limits, and restricted CORS.
- TypeScript workspaces, automated checks, GitHub Pages deployment, a Render API blueprint, environment examples, and operational documentation.

## Start locally

Install Node.js 22.12 or later in the Node 22 release line and npm. Run commands from this repository's root.

```sh
npm ci
```

Copy `server/.env.example` to `server/.env` and `client/.env.example` to `client/.env` using your file manager or shell. Keep the sample localhost values for development. Then run:

```sh
npm run dev
```

Open the Vite URL printed in the terminal, normally `http://127.0.0.1:5173`. Both `http://localhost:5173` and `http://127.0.0.1:5173` are allowed by the development API configuration. The API listens on `http://localhost:8787`; its health endpoint is `http://localhost:8787/api/health`.

The downloader needs the API running. If the API is unavailable, the interface reports the connection problem. The showcase is decorative; it never impersonates a resolved result.

Try the labeled sample in the downloader to resolve a real, public sample file. Third-party sample hosts can change or be unavailable; an upstream error remains visible rather than producing simulated media. Use media you own or have permission to download.

## Repository map

```text
mediaflow/
├── client/                    React, Vite, TypeScript, Tailwind, Motion
│   ├── public/                Static brand and SEO assets
│   └── src/                   Routes, components, styles, API client
├── server/                    Express API, source adapters, secure fetcher
│   ├── src/
│   └── tests/                 Security and API regression tests
├── docs/
│   ├── DESIGN.md              Visual system and architecture
│   ├── DEPLOYMENT.md          GitHub, Pages, Render, domains, operations
│   └── TESTING.md             Automated checks and manual acceptance
├── .github/workflows/         CI and Pages deployment
├── render.yaml                Independent Node API deployment
└── package-lock.json          Shared reproducible dependency lock
```

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start frontend and API development servers |
| `npm run check` | Check TypeScript across both workspaces |
| `npm test` | Run the repository's automated tests |
| `npm run build` | Build frontend and API |
| `npm run build:client` | Produce `client/dist` for static hosting |
| `npm run build --workspace server` | Produce the server distribution |
| `npm run start --workspace server` | Start the compiled API |

## Supported sources

| Input | Result |
| --- | --- |
| Public direct HTTPS image/video URL on an allowed host | Resolve, preview, and download its original file |
| Supported formats | MP4, WebM, JPG/JPEG, PNG, WebP, GIF |
| TikTok, Instagram, Facebook, YouTube, Pinterest, Reddit, or X post/page URL | Platform-specific limitation and authorized alternative guidance |
| Private IP, local address, unapproved hostname, protected URL, or unsupported content | Explicit rejection |
| HTML page, playlist, DRM stream, or media requiring login | Unsupported |

The default direct-media hosts are `images.unsplash.com`, `upload.wikimedia.org`, `media.w3.org`, and `interactive-examples.mdn.mozilla.net`. A host allowlist is a network policy, not a license grant. Check each file's license and the provider's terms. Social CDNs are not enabled by default.

The service does not transcode, upscale, strip watermarks, merge audio/video, resolve adaptive manifests, or promise qualities the source does not provide. Use a platform's own export/download tools for page URLs. Additional integrations belong in the platform module registry and should use a permitted API with credentials kept on the server.

## Configuration

Frontend settings are compiled into public JavaScript. They must never contain secrets.

| Setting | Development example | Meaning |
| --- | --- | --- |
| `VITE_API_BASE_URL` | `http://localhost:8787/api` | API base, including `/api` |
| `VITE_BASE_PATH` | `/` | Asset base; use `/mediaflow/` for a project Pages URL |
| `VITE_SITE_URL` | `http://localhost:5173` | Canonical public site URL, including project path if any |

The API's `.env.example` lists all supported server settings. `ALLOWED_ORIGINS` contains exact frontend origins, without a path or trailing slash. `ALLOWED_MEDIA_HOSTS` contains exact trusted media hostnames, without schemes, paths, or wildcards. Never broaden it to arbitrary user input.

## API and extensions

| Endpoint | Purpose |
| --- | --- |
| `GET /api/health` | Service health |
| `GET /api/platforms` | Platform identity and truthful compatibility |
| `POST /api/resolve` | Resolve `{ "url": "https://approved-host/path/file.jpg" }` |
| `POST /api/batch` | Resolve `{ "urls": ["https://approved-host/path/file.jpg"] }`; 1–5 input URLs, deduplicated |
| `GET /api/media/:id?format=original&disposition=inline` | Validated preview for an unexpired opaque ID |
| `GET /api/media/:id?format=original&disposition=attachment` | Validated attachment for the same file |

Batch results preserve per-source success or error details. A media ID is a temporary reference, not persistent storage. The default source adapter exposes the original variant. New authorized adapters should reuse the network restrictions and return only variants that really exist. The [design and architecture guide](docs/DESIGN.md) explains responsibilities and extension boundaries.

## Publish in GitHub

Push this directory as the **repository root**, including `.github`, `client`, `server`, `package.json`, and `package-lock.json`. The repository includes workflows; it does not contain GitHub credentials or claim to have created a remote repository.

1. Create an empty GitHub repository named `mediaflow` (or choose another name).
2. Upload or push the complete source directory.
3. Deploy `render.yaml` as a Render Blueprint and set the frontend origin when prompted.
4. Add GitHub repository variables `API_BASE_URL` and `SITE_URL`; set `BASE_PATH` if needed.
5. In repository **Settings → Pages**, choose **GitHub Actions** as the source.
6. Run the **Deploy frontend to GitHub Pages** workflow or push to `main`.

The deployment job waits until `API_BASE_URL` and `SITE_URL` are configured; ordinary CI still runs on the first push. Once configured, the workflow checks, tests, builds, uploads `client/dist`, and deploys it to the `github-pages` environment using the documented GitHub Actions approach. See the full [deployment guide](docs/DEPLOYMENT.md) for exact values, commands, custom domains, and troubleshooting. [GitHub's custom workflow documentation](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages) describes the required deployment permissions.

GitHub Pages hosts the frontend. A Node host runs the API. Without a deployed API and matching CORS origin, the hosted downloader cannot resolve or download files.

## Before a public launch

Run the [acceptance checks](docs/TESTING.md) against the actual deployed URLs. Set your site's canonical URL, operator information, support channel, privacy terms, production limits, and permitted source policy. Review source-host permissions and operational capacity for your own deployment.

The default resolver registry and rate limiter are process-local. Use one API instance with these defaults; restarts expire previews. Horizontal scaling requires a shared expiring registry and rate-limit store. Browser downloads buffer the permitted file in memory, so choose a lower file-size cap for a mobile-heavy audience. CORS limits browser access; it is not API authentication or protection from non-browser clients. See [operations and limits](docs/DEPLOYMENT.md#operations-and-limits).

## License

Application code is MIT licensed. External media, platform names, trademarks, and fonts retain their respective rights. The sample media is not included in the code license.

