# MediaFlow design and architecture

## Product principle

The primary action is always clear: enter an authorized public video-page or direct-media URL, inspect the actual result, choose a real available quality, and save the file. Visual effects support that sequence. Compatibility labels describe the current extraction support without promising access to every link on a platform.

## Visual system

The interface uses midnight/navy page surfaces, layered neutral panels, violet primary accents, and cyan highlights. A soft gradient horizon gives the hero depth. Transparent panel fills, delicate borders, and contained glows provide separation without compromising text contrast.

| Token | Dark-theme value | Role |
| --- | --- | --- |
| Midnight | `#080a14` | Main canvas |
| Surface | `#10121e` | Elevated cards |
| Violet | `#a78bfa` | Emphasis and light |
| Purple | `#9362ef` | Primary gradient |
| Cyan | `#68d5e9` | Supporting accent |

Space Grotesk gives headlines a geometric, expressive voice; Inter keeps controls and long passages readable. System fallbacks preserve usability while fonts load. Display type scales fluidly, while body copy stays comfortably readable on a narrow viewport. The logo pairs a distinct flow-shaped mark with a restrained wordmark.

The page follows a consistent spacing rhythm. A centered content width anchors the hero, compatibility cards, how-it-works section, feature grid, FAQ, and footer. Large rounded panels contain the practical workflow; smaller radius values define controls. The light theme changes the complete surface and text system, keeping the same accent identity.

## Composition

- **Navigation:** Sticky translucent bar, recognizable brand, in-page destinations, theme control, and a clear downloader action.
- **Hero:** Large editorial headline, violet emphasis, concise copy, floating image/video frames, and the main downloader.
- **Downloader:** A visible URL label, paste affordance, validation, resolving state, real preview, source metadata, available variant selection, and a clear save action.
- **Compatibility:** Platform identity and realistic extraction availability. Protected content, unsupported formats, and source-side hosting blocks receive specific errors.
- **How it works:** Paste, preview, download. An animated connector establishes the sequence.
- **Features:** Format support, restrained processing, privacy behavior, and usability explained in compact panels.
- **FAQ and footer:** Keyboard-operable disclosures, real legal routes, and working destinations.

## Motion system

Motion for React handles entrances, staggered content, viewport reveals, and component transitions. CSS handles ambient lighting and simple hover effects. Transforms and opacity carry most movement; the interface avoids continuously animating expensive layout properties.

Entrance delays remain short enough that useful controls are available immediately. Floating cards move slowly. Hover feedback is brief and reversible. Loading states reflect a pending request; progress reflects bytes, and success follows a completed response and browser save handoff.

`prefers-reduced-motion` removes decorative movement and reduces transitions. Small-screen or low-capability contexts should avoid pointer effects and heavy ambient motion. Touch actions do not depend on hover. Keyboard focus remains visible in either theme.

## Architecture

```text
Browser / GitHub Pages
  React routes and reusable UI
      ↓ fetch JSON / media with restricted CORS
Node / Express API
  Request validation and limits
      ↓
  Direct file → DNS/IP checks → pinned request → signature/size validation
  Public page → yt-dlp metadata through guarded public-IP egress
                → bundled EJS in Deno with denied I/O permissions
                → real direct MP4/WebM video and compatible audio plans
      ↓
  Expiring opaque media ID and actual available format IDs
      ↓
  Node downloads tracks with DNS pinning, redirect and byte limits
      ↓
  Local-only FFmpeg stream verification / lossless audio-video mux
      ↓
  Bounded temporary file → browser preview / attachment save
```

The frontend never receives API secrets, raw extractor metadata, or source download URLs. It treats server results as untrusted data and presents errors as text. The backend owns network access, byte limits, content validation, temporary preparation, and response headers. Browser URL checks improve feedback but do not replace server validation. Optional restricted-host mode narrows input and track hosts further.

The route layer keeps presentation separate from the downloader state and API transport. yt-dlp performs metadata extraction, while Node owns media-byte downloads and FFmpeg receives only local signature-checked containers. An integration must expose real assets, preserve available audio, and distinguish known audio, explicitly video-only media, and unknown audio metadata. It must reuse the network policies. Source recognition does not establish that the source will allow the hosting server to retrieve a particular file.

## Download states

The workflow moves from idle to validating/resolving, then ready or error. A ready result contains the actual upstream media type and retrievable metadata. Saving moves through fetching, progress when measurable, and success or failure. Cancelling or starting a new resolve invalidates obsolete work so stale results do not replace a newer selection.

The browser cannot confirm that a person saved a file to disk. The success state means that file bytes were received and a browser download was initiated. Mobile browsers may open a native preview or share sheet instead of the desktop save interface.

## Accessibility and SEO

Use semantic navigation, a single primary heading, labeled controls, meaningful button names, visible focus, status announcements, and an accordion with expanded state. Media previews have meaningful labels and video controls. Decorative lighting is hidden from assistive technology.

The static entry document supplies descriptive metadata and Open Graph information. The build uses the configured site URL for public SEO assets. Hash-based routes keep legal pages reloadable on GitHub Pages without a server rewrite. Hash routes are a static-hosting compromise: search engines primarily index the entry page. Use a rendering/static-generation layer and path routing if independently indexed legal or marketing routes become a product requirement.

