# Verification record

## Local verification — 19 October 2026

- Frontend and backend TypeScript checks passed.
- Before the latest audio-metadata update, all 71 automated tests passed: 28 frontend/API-client tests and 43 backend security/integration tests, with no skips. The backend checks include actual FFmpeg processing. Final counts for the audio-metadata update are pending.
- Both production builds passed, including a GitHub project Pages asset base and canonical URL.
- Dependency audit reported zero vulnerabilities after dependency updates.
- The checksum-pinned yt-dlp and Deno tools installed and ran. The actual Linux Deno archive also passed the installer's ZIP extraction, archive checksum, extracted binary checksum, and x86_64 executable checks.
- A Deno permissions probe confirmed denial of network access, local file reads, and environment access with the extractor's restricted runtime flags.
- Review and regression checks cover private/mixed DNS, redirect rebinding, guarded extractor egress, pending-header cancellation, transfer cancellation, occupied slots, signature/MIME validation, bounded preparation, and offline FFmpeg arguments. These checks are not a substitute for ongoing security review.

## Real media verification

- The normal [Big Buck Bunny Archive-page link](https://archive.org/details/BigBuckBunny_328) resolved to its actual MP4. The complete approximately 43 MB file downloaded and was verified to contain H.264 video and AAC audio. This is the downloader's current sample. Credit: © 2008 Blender Foundation, [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/), hosted by Internet Archive. Preserve its film credits.
- The [official Sintel YouTube page](https://www.youtube.com/watch?v=eRsGyueVLvQ) resolved locally. Two original tracks totaling 33,734,420 bytes were downloaded and combined into a 33,941,551-byte MP4. Verification found H.264 video at 640 × 272, AAC audio, and a duration of 888.093605 seconds. The reported complete preparation took 9.233 seconds. This verifies a real YouTube page and separate-track merge locally; it is not a hosted-YouTube success claim. Sintel is a Blender Foundation film; its [sharing terms](https://durian.blender.org/sharing/) require attribution and preserved credits.
- Earlier direct-file checks resolved, previewed, and saved the MDN CC0 MP4; the download matched its 1,128,375-byte source length. Unsplash WebP and JPEG checks matched signatures and byte counts of 7,120 and 6,569 bytes respectively.

## Interface verification

Desktop, tablet, and narrow phone layouts were inspected. Mobile grid overflow and input zoom risks were corrected. Sticky navigation, light theme, legal routes, actual previews, and browser save were exercised. Repeat responsive, keyboard, reduced-motion, and real-device mobile checks after material interface changes.

## Hosted release status

The public frontend and backend are deployed. Final cloud acceptance of the latest extraction/audio-metadata revision is pending. Initial hosted metadata checks recorded these outcomes:

| Source fixture | Hosted metadata result |
| --- | --- |
| Archive sample | HTTP 200 |
| Pinterest | HTTP 200 |
| Instagram | `NO_DOWNLOADABLE_FORMAT` from the previous audio-only filter; fix awaiting cloud verification |
| TikTok, Facebook, X | Source rejected / unavailable |
| Reddit | `LOGIN_REQUIRED` |
| YouTube | Generic source failure after approximately 30 seconds |

Metadata success is not a completed file download. Local Sintel extraction and merging succeeded as recorded above, but those results do not establish hosted YouTube success. The latest audio-state fix must be checked after deployment; this record does not declare every named platform verified in the cloud.

Run the deployment acceptance checks against the actual hosted API and GitHub Pages URL. Source access can differ between a local computer and a hosting IP. Login requirements, DRM, unavailable formats, platform blocks, and removed media must remain explicit failures; no universal all-links guarantee is made.
