# Deployment

The repository deploys as two services: the static React application on GitHub Pages and the Express API on Render. Deploy the API first so the frontend can be built with its real public URL. The YAML files are configuration, not evidence that a deployment has already happened.

## 1. Put the source in GitHub

Create an empty repository, then push the contents of the `mediaflow` directory as its root. Run the following inside that directory, substituting your own repository URL:

```sh
git init -b main
git add .
git commit -m "Build MediaFlow media downloader"
git remote add origin https://github.com/YOUR-ACCOUNT/mediaflow.git
git push -u origin main
```

If a repository or remote already exists, use that existing repository instead of reinitializing it. Commit the dependency lockfile. Keep `.env` files, credentials, and `node_modules` out of Git. The `.gitignore` permits `.env.example` files deliberately.

The included CI workflow runs on pushes to `main`, pull requests, and manual dispatch. If your default branch has another name, update both workflow branch filters.

## 2. Deploy the API on Render

In Render, choose **New → Blueprint** and connect the GitHub repository. Render reads the repository-root `render.yaml`. The blueprint uses the Node runtime, builds the server workspace from the monorepo root, starts its compiled entry point, and checks `/api/health`. These fields follow the [Render Blueprint specification](https://render.com/docs/blueprint-spec); [Render's Express guide](https://render.com/docs/deploy-node-express-app) explains connecting a Git repository to a Node web service.

Supply `ALLOWED_ORIGINS` when prompted. For the example project URL `https://YOUR-ACCOUNT.github.io/mediaflow/`, the correct allowed **origin** is:

```text
https://YOUR-ACCOUNT.github.io
```

Origins do not include `/mediaflow/` or a trailing slash. Multiple allowed origins are comma-separated. Keep development localhost origins out of a public deployment unless intentionally needed.

The blueprint uses the free plan as an inexpensive initial deployment configuration. Choose a hosting plan appropriate to your expected traffic, latency, and outbound transfer requirements before launch. Review the provider's current pricing in your account before provisioning or upgrading.

The equivalent manual service settings are:

| Setting | Value |
| --- | --- |
| Runtime | Node |
| Root directory | Repository root; leave blank |
| Build command | `npm ci --include=dev && npm run setup:media --workspace server -- --check-runtime && npm run build --workspace server` |
| Start command | `npm run start --workspace server` |
| Health check | `/api/health` |
| Node | 22 |

Keep the repo root so npm can use the shared workspaces and lockfile. The server must listen on the hosting provider's `PORT`; the blueprint configures `8787`. Confirm a successful health response at `https://YOUR-API.onrender.com/api/health` and then test an authorized sample through the frontend.

### Media runtimes

Render's native runtimes include Python 3, FFmpeg, and FFprobe during build and runtime, so the Node service can run the media workflow without a Docker migration. The setup command installs pinned yt-dlp and Deno releases into `server/.bin` and checks every required runtime before allowing the build to proceed. [Render's native runtime documentation](https://render.com/docs/native-runtimes) lists the included tools.

The Render blueprint sets `PYTHON_PATH=/usr/bin/python3` to select Debian's installed interpreter directly instead of relying on a language-manager shim found through PATH. Debian Bookworm's [python3-minimal file list](https://packages.debian.org/bookworm/amd64/python3-minimal/filelist) includes that executable. The strict setup check confirms it actually runs in the deployment environment. Local development can use its own absolute Python path.

The tracked `server/.tools-version.json` records official release URLs and SHA-256 checksums. The installer verifies the complete yt-dlp artifact, the Deno ZIP archive, and the extracted Deno executable before installation or execution. Matching local files are reused; binaries are excluded from Git. No pip globals, runtime self-update, downloaded installer shell script, or remote EJS components are used.

The API uses Deno for bundled EJS code with default-denied network, file, and environment access. It does not fall back to Node for challenge execution. Keep the guarded extractor proxy enabled: the extractor's own page/API/manifest requests must pass its public-address DNS validation. Node downloads the selected direct media tracks, then FFmpeg verifies or combines local files with remote protocols disabled. These are separate stages; never replace them with an unrestricted yt-dlp or FFmpeg download subprocess.

The pinned extractor and Deno runtime are external dependencies with their own licenses. When a source changes, deliberately update the manifest, verify the official checksums, rerun the relevant tests, and redeploy. A pinned extractor can become incompatible with an upstream website; that is a maintenance event, not a reason to enable credential, DRM, or access-control bypasses.

### API environment

| Variable | Initial value | Purpose |
| --- | --- | --- |
| `NODE_ENV` | `production` | Production runtime mode |
| `PORT` | `8787` | Service listener |
| `ALLOWED_ORIGINS` | Your exact frontend origin | Browser CORS policy |
| `ALLOW_PUBLIC_MEDIA` | `true` | Permit validated direct media on public HTTPS hosts |
| `ALLOWED_MEDIA_HOSTS` | Explicit sample host list in `render.yaml` | Exact host policy when public-media mode is disabled |
| `EXTRACTOR_ENABLED` | `true` | Enable public video-page resolution |
| `EXTRACTOR_PATH` | Derived `server/.bin/yt-dlp` | Pinned extractor artifact; override only with a trusted tool |
| `PYTHON_PATH` | `/usr/bin/python3` on Render | Direct system Python executable for the extractor |
| `DENO_PATH` | Adjacent to extractor | Deno executable for restricted challenge code |
| `FFMPEG_PATH` | `ffmpeg` | Local verification and audio/video muxing executable |
| `EXTRACTION_TIMEOUT_MS` | `65000` | Video-page extraction deadline |
| `DOWNLOAD_TIMEOUT_MS` | `120000` | Track preparation deadline |
| `MAX_FILE_BYTES` | `104857600` | 100 MiB upper file limit |
| `REQUEST_TIMEOUT_MS` | `20000` | Upstream request deadline |
| `MEDIA_TTL_SECONDS` | `900` | Expiry for resolved media IDs |
| `RATE_LIMIT_PER_MINUTE` | `30` | Request rate per client |
| `MAX_CONCURRENT_DOWNLOADS` | `4` | Concurrent server fetch limit |
| `TRUST_PROXY_HOPS` | `0` | Number of explicitly trusted proxy hops |

Start with proxy trust disabled. If the host puts your app behind exactly one trusted reverse proxy and cannot be reached through a shorter untrusted path, set `TRUST_PROXY_HOPS=1` after verifying the network topology. An incorrect trust setting lets callers spoof addresses used by the rate limiter. With proxy trust disabled behind a proxy, clients may share one limit; resolve that operational issue before launch.

Public-media mode keeps public-IP, redirect, signature, size, timeout, and response-header checks enabled; it does not turn the API into a general response proxy. Set `ALLOW_PUBLIC_MEDIA=false` for an installation that must accept only an exact list of hosts. In that mode, entries such as `media.your-domain.com` contain no scheme, path, port, or wildcard, and redirected/selected media hosts need separate inclusion. This can limit page extraction as well as direct media. `EXTRACTOR_ENABLED=false` disables page resolution entirely.

## 3. Configure GitHub Pages

In the GitHub repository, go to **Settings → Secrets and variables → Actions → Variables** and create these repository variables. They are public configuration, so no API keys belong here.

| Repository variable | Project site example | Notes |
| --- | --- | --- |
| `API_BASE_URL` | `https://YOUR-API.onrender.com/api` | Required, HTTPS, ends in `/api` |
| `SITE_URL` | `https://YOUR-ACCOUNT.github.io/mediaflow/` | Required canonical URL, including project path |
| `BASE_PATH` | `/mediaflow/` | Optional for project sites; defaults to `/<repository-name>/` |

For a user/organization repository named `YOUR-ACCOUNT.github.io`, set `BASE_PATH=/` and `SITE_URL=https://YOUR-ACCOUNT.github.io/`. Use `/` for a custom domain as well.

In **Settings → Pages → Build and deployment**, select **GitHub Actions** as the source. Run **Actions → Deploy frontend to GitHub Pages → Run workflow**, or push to `main`. The workflow validates required settings, installs the lockfile, checks types, runs tests, builds the frontend, uploads `client/dist`, and deploys the artifact. The build job has `pages: read` to inspect site configuration; the deploy job has the required `pages: write`, `id-token: write`, and `github-pages` environment. This follows [GitHub's custom workflow guidance](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages).

The workflow uses the current Node 24 action runtime releases: `setup-node@v6`, `configure-pages@v6`, `upload-pages-artifact@v5`, and `deploy-pages@v5`. The application itself still builds and runs on Node 22. GitHub retired the Node 20 action runtime in September 2026, so older examples may show obsolete action versions. See the [GitHub runtime announcement](https://github.blog/changelog/2026-09-23-node-20-is-no-longer-available-in-github-actions/), [configure-pages release](https://github.com/actions/configure-pages/releases/tag/v6.0.0), [upload-pages-artifact release](https://github.com/actions/upload-pages-artifact/releases/tag/v5.0.0), and [deploy-pages release](https://github.com/actions/deploy-pages/releases/tag/v5.0.1).

The Pages build is skipped until `API_BASE_URL` and `SITE_URL` exist. Configure both values and enable Pages, then rerun the workflow. CI runs independently. Review both CI and the actual Pages deployment result before announcing the site.

React uses a hash router, so `/#/privacy` and `/#/terms` reload correctly on static hosting. `VITE_BASE_PATH` controls asset paths, not the hash route. Changing a Vite variable requires a new build/deployment.

## 4. Add a custom domain

For a subdomain such as `app.example.com`, verify your domain in GitHub, add it in the repository's Pages settings, and then add the DNS CNAME requested by GitHub. Point it to `YOUR-ACCOUNT.github.io`, excluding the repository path. GitHub Actions deployments do not require a source `CNAME` file. Follow [GitHub's domain instructions](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/managing-a-custom-domain-for-your-github-pages-site) for apex records and HTTPS.

Then update:

```text
GitHub BASE_PATH=/
GitHub SITE_URL=https://app.example.com/
Render ALLOWED_ORIGINS=https://app.example.com
```

Rerun the Pages workflow. Enforce HTTPS after certificate provisioning finishes. If you also assign an API domain, configure it in Render and change `API_BASE_URL` to its HTTPS `/api` URL before rebuilding the frontend. Keep both old and new origins temporarily only if both frontends should remain accessible during migration.

## Operations and limits

- The default media registry, preparation cache, and limiter are process-local. Run one API instance. A restart invalidates previously resolved IDs; the interface must resolve again. Use shared state, coordinated temporary storage, and shared rate limiting before horizontal scaling.
- The default API is anonymous. CORS is a browser policy, not authentication. For a larger public deployment, put network rate limits, abuse monitoring, and usage controls in front of it. Keep the application's own restrictions enabled.
- Direct media may be fetched separately for preview and save. Page-video results are prepared into temporary files and reused during their expiry window. Budget bandwidth, source quota, and temporary disk space accordingly. No permanent media library is maintained.
- Preparation is limited to two concurrent jobs with a disk budget derived from the configured file cap; active inputs and muxed output also need transient space. Ensure the host has room for the runtime binaries plus temporary tracks. Abandoned jobs are cancelled, and expired prepared files are removed. Use a deployment-level ephemeral-storage cleanup strategy for unclean process termination.
- The browser buffers a permitted file for the save action and independently caps it at 100 MiB. Keep the server cap at or below that limit; reduce it for constrained devices and test real mobile browsers. A successful browser handoff cannot prove that the user saved to disk.
- The source controls format, resolution, response time, and availability. Login, DRM, geographic rules, bot checks, hosting-IP blocks, expiry, removal, and anti-hotlink rules can stop a URL. A platform being recognized by the extractor is not a guarantee that every public link will download from a cloud host. MediaFlow does not bypass these controls.
- Logs, metrics, support details, retention policies, and legal operator information depend on your hosting arrangement. Complete those for your deployment and keep the public legal pages consistent with actual practices.
- Request policies and a passing test suite are defense in depth. Review egress restrictions and dependency updates as part of normal security operations. The API must remain a restricted downloader, never an unrestricted proxy.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Workflow stops before build | Set the required repository variables and ensure both URLs use HTTPS |
| Frontend assets return 404 | Check `BASE_PATH`; project sites need `/<repo>/`, domain/root sites need `/` |
| API connection error | Check Render service status, HTTPS, `API_BASE_URL` including `/api`, and the network response |
| CORS rejection | Match the browser's exact origin in `ALLOWED_ORIGINS`; omit project paths |
| All users share rate limits | Check trusted proxy topology before changing `TRUST_PROXY_HOPS` |
| Source host rejected | Check whether restricted mode is enabled, or whether the host resolves to a blocked address |
| Resolved preview expires | Resolve again; IDs expire and are lost on restarts |
| Video-page resolver unavailable | Run setup with `--check-runtime`; verify Python, yt-dlp, Deno, and FFmpeg paths on the server |
| Python version check times out | Use the actual interpreter path; the Render blueprint uses `/usr/bin/python3` to avoid PATH shims |
| Platform blocks the server | Source-side access can differ from a personal browser; report the actual restriction instead of promising universal support |
| No complete video quality | The page may expose only unsupported manifests, protected media, silent video, or a file exceeding the cap |
| Video preparation fails | Confirm FFmpeg runs, temporary storage is writable, and both source tracks remain available |
| Unknown download percentage | Upstream length is absent or unusable; the UI should show activity without a percentage |

