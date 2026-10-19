# Verification record

## Local verification — 19 October 2026

- Frontend and backend TypeScript checks passed.
- After the audio-metadata update, all 75 automated tests passed: 28 frontend/API-client tests and 47 backend security/integration tests, with no skips. Required real FFmpeg checks cover known audio, explicitly silent video, and preservation of progressive sources with unknown audio metadata. Backend build and frontend TypeScript checks passed.
- Both production builds passed, including a GitHub project Pages asset base and canonical URL.
- Dependency audit reported zero vulnerabilities after dependency updates.
- The checksum-pinned yt-dlp and Deno tools installed and ran. The actual Linux Deno archive also passed the installer's ZIP extraction, archive checksum, extracted binary checksum, and x86_64 executable checks.
- A Deno permissions probe confirmed denial of network access, local file reads, and environment access with the extractor's restricted runtime flags.
- Review and regression checks cover private/mixed DNS, redirect rebinding, guarded extractor egress, pending-header cancellation, transfer cancellation, occupied slots, signature/MIME validation, bounded preparation, and offline FFmpeg arguments. These checks are not a substitute for ongoing security review.

## Real media verification

- The normal [Big Buck Bunny Archive-page link](https://archive.org/details/BigBuckBunny_328) resolved to its actual MP4. The complete approximately 43 MB file downloaded and was verified to contain H.264 video and AAC audio. This is the downloader's current sample. Credit: © 2008 Blender Foundation, [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/), hosted by Internet Archive. Preserve its film credits.
- The [official Sintel YouTube page](https://www.youtube.com/watch?v=eRsGyueVLvQ) resolved locally. Two original tracks totaling 33,734,420 bytes were downloaded and combined into a 33,941,551-byte MP4. Verification found H.264 video at 640 × 272, AAC audio, and a duration of 888.093605 seconds. The reported complete preparation took 9.233 seconds. This verifies a real YouTube page and separate-track merge locally; it is not a hosted-YouTube success claim. Sintel is a Blender Foundation film; its [sharing terms](https://durian.blender.org/sharing/) require attribution and preserved credits.
- Earlier direct-file checks resolved, previewed, and saved the MDN CC0 MP4; the download matched its 1,128,375-byte source length. Unsplash WebP and JPEG checks matched signatures and byte counts of 7,120 and 6,569 bytes respectively.
- The Instagram video fixture resolved locally after the audio-state fix and offered three MP4 choices explicitly labeled video only. This was metadata verification only; no Instagram media file was downloaded.

## Interface verification

Desktop, tablet, and narrow phone layouts were inspected. Mobile grid overflow and input zoom risks were corrected. Sticky navigation, light theme, legal routes, actual previews, and browser save were exercised. Repeat responsive, keyboard, reduced-motion, and real-device mobile checks after material interface changes.

## Hosted verification — 19 October 2026

The final backend revision [52e029f1fca4ec9125044ba27973b59028b0b0fd](https://github.com/WoshiRaphael/mediaflow/commit/52e029f1fca4ec9125044ba27973b59028b0b0fd) deployed successfully on Render. The live GitHub Pages interface resolved the normal Archive sample page, completed the browser download action, and displayed its success/“Download again” state.

The sample also played in the live browser. At inspection, the player was paused at 13.740 seconds, reported `readyState=4`, a duration of 596.416667 seconds, and dimensions of 426 × 240. This records observed playback, rather than claiming the full film was watched. A browser screenshot was saved as `mediaflow-live-download.png` in the delivery outputs.

The actual cloud API attachment was an MP4 containing 43,315,070 bytes. Its SHA-256 matched the locally downloaded original:

```text
3aaecd80a8fa3cbe6df8e79364af0412b7da6fa423d14c8c6bd332b32d7626b7
```

Hosted source checks recorded these outcomes:

| Source fixture | Hosted result |
| --- | --- |
| Archive sample | Resolved; full MP4 attachment downloaded and hash matched; live browser playback and save succeeded |
| Instagram | HTTP 200; three MP4 formats labeled video only; metadata verification only |
| Pinterest | HTTP 200; one MP4 format; metadata verification only |
| YouTube Sintel | Final backend returned HTTP 422 `SOURCE_UNAVAILABLE` after 29.815 seconds; underlying cause unconfirmed |
| TikTok, Facebook, X | Earlier hosted fixture checks returned `SOURCE_UNAVAILABLE` |
| Reddit | Earlier hosted fixture check returned `LOGIN_REQUIRED` |

Instagram and Pinterest metadata success is not a completed file download. Local Sintel extraction and merging succeeded as recorded above, while the hosted Sintel attempt failed. No cause beyond the reported source error has been established, and this record does not declare every named platform functional in the cloud.

Repeat deployment acceptance checks after relevant source, configuration, runtime, or hosting changes. Source access can differ between a local computer and a hosting IP. Login requirements, DRM, unavailable formats, platform blocks, and removed media must remain explicit failures; no universal all-links guarantee is made.
