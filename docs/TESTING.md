# Testing and acceptance

Run checks from the repository root with Node.js 22. Install exactly the committed dependencies first.

```sh
npm ci
npm run check
npm test
npm run build
```

CI runs the same checks. Type checks catch frontend/backend contract errors; tests cover the implemented validators and security behavior; the build confirms both production distributions are generated. A passing build does not verify a provider's future availability or prove a deployment is live.

## Local functional check

1. Copy both workspace `.env.example` files to `.env` and run `npm run dev`.
2. Load the homepage and use the labeled real sample URL.
3. Resolve it. Confirm the preview matches the actual file, with its real format and available metadata.
4. Save the original. Open the saved file and verify its content and extension.
5. Try a permitted small MP4 or WebM URL and verify video controls and save behavior.
6. Resolve a small batch of authorized direct-media URLs; inspect any individual error instead of assuming every source succeeds.
7. Enter an invalid URL, a public social-post URL, and a source whose domain is not approved. Confirm each receives an understandable restriction or validation error.
8. Stop the API, attempt a resolve, restart it, and retry. The UI should recover through a new request.

Sample hosts are external dependencies. If one is unavailable, use a file you control on an explicitly approved host. Do not alter the security rules to make an arbitrary sample pass.

## Responsive and accessibility review

Check at approximately 375, 768, and 1440 pixels wide, including a narrow phone in portrait and landscape. Verify no horizontal overflow, clipped text, obscured controls, or sticky navigation overlap. Test browser zoom at 200%.

- Tab through navigation, theme control, URL field, paste button, resolve button, available quality control, save/cancel actions, legal links, and FAQ.
- Confirm focus remains visible in both themes and Enter/Space activate the expected controls.
- Confirm form errors and downloader status are understandable without relying on color.
- Enable reduced motion in the operating system/browser. Decorative continuous motion should stop or be substantially reduced, while the workflow remains usable.
- Test a touchscreen with no hover and a browser where clipboard permission is denied. Manual paste must remain available.
- Check foreground/background contrast, labeled form fields, image descriptions, video controls, and meaningful accessible button names.
- Open privacy and terms routes directly, refresh, and return to the home downloader.

## Network and security review

The server's automated security tests should remain deterministic and should not need to contact arbitrary external hosts. Review failures instead of disabling assertions. Add regression tests when changing URL parsing, DNS resolution, redirect handling, response validation, or transfer limits.

In a controlled development environment, confirm these remain rejected:

- Non-HTTPS input, embedded credentials, unexpected ports, and oversized input. URL fragments are stripped before fetching.
- Literal loopback/private/reserved IPs, local names, a hostname outside the exact allowlist, and a hostname whose DNS resolves to a non-public address.
- Redirects to an unapproved host or private address, excessive redirect chains, and DNS changes between checks and a connection.
- HTML or executable content masquerading as a media URL, oversized declared files, oversized streamed files, and stalled upstream responses.
- Expired or unknown media IDs, malformed format/disposition values, excessive rates, and requests exceeding concurrency limits.

Inspect actual implementation and test names for the precise accepted input rules. Do not assume every malformed input has the same error code; the important acceptance condition is that no prohibited outbound access or file response occurs.

Check an unauthorized browser origin receives no permission to read API responses. Also confirm that non-browser callers still face the source, DNS, size, and rate policies: CORS is not an access-control boundary for those callers.

## Deployment acceptance

Test against the final HTTPS site and API, not only localhost:

1. Both GitHub workflows pass, Render health is healthy, and the frontend loads at its actual project path or domain.
2. The public HTML metadata, Open Graph URL, sitemap, and robots file use the intended public site URL.
3. A real image and a real video resolve, preview, and download from a permitted host.
4. The site's origin is allowed; an unrelated browser origin is rejected.
5. A source-page link produces accurate platform guidance.
6. Light/dark themes, reduced motion, keyboard operation, FAQ, legal routes, clipboard fallback, retry, cancellation, and batch behavior work.
7. Test progress with a measurable response length and an indeterminate response. The UI must not manufacture a percentage.
8. Test a real iOS Safari and Android Chrome device if mobile downloading is part of the launch promise. Save, preview, and share behavior varies by browser.
9. Restart the API and confirm stale previews recover by resolving again.
10. Review operator details, contact destinations, permitted sources, privacy statements, resource limits, rate limits, and hosting capacity for the real deployment.

## Extending coverage

When adding an authorized platform adapter, test permission/credential failure, no media available, one and multiple variants, expired source URLs, partial batch failure, redirect policy, and source removal. Verify that every offered variant corresponds to a real downloadable file. Keep credentials out of browser fixtures and CI logs.

