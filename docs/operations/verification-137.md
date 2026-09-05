# Issue 137: independent image display verification

Implementation target: [#137](https://github.com/itscly2026/same-page/issues/137), building on the ReaderSession and offline activation boundaries from #136. This report separates local evidence from release and device acceptance. No production migration, provisioning or deployment has been performed.

## Architecture and operating limits

PDF.js remains the default. Its engine import is deferred inside the cancellable document loader, so a failed engine module does not prevent the reader shell or the image path from loading. ImageDocument supplies server geometry and a replaceable background to the existing page layouts and normalized annotation overlay. Local preferences are keyed by owner and score, with a separate owner default. No device-name classification or annotation migration is used.

The native engine is PDFium through pinned pypdfium2 5.13.0 / Pillow 12.3.0; the checked fixture reports PDFium 153.0.7999.0. pypdfium2 distributes PDFium dependency notices with its wheel ([licensing](https://pypdfium2.readthedocs.io/en/stable/readme.html)). The container retains installed notices. This is a separate Python process, not PDF.js in another wrapper. Cloudflare's [Containers integration](https://developers.cloudflare.com/containers/get-started/) and [Container package](https://developers.cloudflare.com/containers/container-package/) provide the intended deployment boundary behind a private Durable Object and Queue. The app never receives a public renderer URL.

| Resource | Bound |
| --- | --- |
| Queue / container | One message per batch, one consumer concurrency, one instance; serial HTTP server |
| Native child | 15 CPU seconds; 20-second subprocess wall timeout; Linux address-space limit 768 MiB; unprivileged user; container egress disabled |
| Conversion | 180-second request deadline, at most 200 pages, source limit 50 MiB (upload policy remains 20 MiB) |
| Output | Lossless RGB PNG, long-edge tiers 2048 / 3072, max 32 MiB per image and 512 MiB per generation |
| Client canvas | Max edge 4096, 4 MiPixels per canvas, aggregate 24 MiPixels, two concurrent renders, one lower-resolution retry |
| Offline images | Complete 2048 tier only, max 64 MiB bundled bytes; zoom uses these bytes without requesting the higher tier |

Each immutable PDF version has a deduplicated job with a generation token. The Worker validates source SHA-256, geometry, PNG dimensions/size and the complete sequential manifest before publishing `ready`. Partial outputs have registered object keys. Failure and obsolete generations enqueue deletion through the existing retryable storage cleanup, which rechecks references before deletion. A preparing job becomes retryable after 20 minutes; failed jobs can be retried explicitly. Published generations are reused rather than regenerated on every read.

Manifest, status, conversion initiation and image routes all call the same PDF-version authorization resolver as original PDF delivery, including candidate-only administrator access, membership changes, trash and version retention. Images remain derivatives: they do not create PDF versions or increase the existing one-GB PDF quota. Their R2 physical storage is service overhead and must be monitored separately. Version deletion cascades image metadata into object cleanup.

The offline copy contains either the source PDF or the ordered image bundle plus manifest. All downloaded image hashes, dimensions, decoding, total length and source identity are checked before the existing atomic activation transaction. Previous active bytes and drafts survive a failed replacement. The manifest declares the source PDF hash; the local blob hash covers the complete selected representation. Mode availability labels follow the actual stored representation. Existing #136 owner-session, stale-operation and annotation snapshot safeguards remain in force.

## Fixed specimen and visual inspection

`renderer/fixtures/score-specimen.pdf` is an original synthetic three-page specimen using the unmodified Bravura font under [SIL OFL](https://github.com/steinbergmedia/bravura/blob/master/LICENSE.txt). Page 1 embeds music glyphs, vector staff/stems/slurs and lyrics; page 2 is a rasterized scan surrogate; page 3 uses a CropBox and 90-degree rotation. It is not a user problem file or a published score. Fixture generation and license files are checked in.

Actual PNG outputs were inspected against the source: filled and hollow noteheads, sharps/flats/naturals, augmentation dots, lyrics and curved lines remain visible at both tiers; crop/rotation preserves the intended displayed geometry. The six checked-in golden images enforce pixel comparison, nonblank output and dimensions. An engine upgrade that changes pixels requires inspection before explicitly recording new goldens. Automated comparison cannot prove musical correctness beyond the specimen.

Local macOS measurements (one run; includes native child startup, excludes Cloudflare cold start): source PDF **132,994 bytes**.

| Page | 2048 bytes / seconds | 3072 bytes / seconds |
| --- | ---: | ---: |
| Music font / vectors | 117,984 / 0.140 | 184,462 / 0.192 |
| Raster scan surrogate | 181,573 / 0.169 | 319,849 / 0.261 |
| Rotated / cropped | 143,162 / 0.156 | 225,153 / 0.233 |
| Total | 442,719 | 729,464 |

The lower-tier offline bundle is 3.33 times this small source PDF; both server tiers total 1,172,183 bytes (8.81 times). The scan surrogate is measured separately and does not establish compression ratios for real scans. Machine-readable timing, dimensions and checksums are in `artifacts/verification/137/renderer-measurements.json`.

## Verification evidence

The public test boundaries agreed with the user are ReaderSession open/switch/cancel, Worker conversion/status/manifest/image authorization, offline download/verification/activation, and real-browser display/annotation/offline reopen.

- Native golden regression invokes the actual installed PDFium process.
- Reader tests cover cancelled and timed-out loads and image geometry without starting PDF.js. Existing session tests cover late results, offline/cloud source arbitration, owner changes and protected drafts.
- Worker tests exercise authorization, version deduplication, failed queue dispatch and retry. Browser storage fixtures use real local Worker, D1, R2 and Queue handling; only the container transport is an auxiliary local Durable Object forwarding to the actual native renderer because this machine has no Docker.
- Chromium and persistent-profile WebKit exercise upload, PDF-to-image switching, native conversion, image download, second-page offline reopen and a truthful missing-PDF-mode message. Chromium additionally writes an offline annotation and verifies reconnect synchronization and switching back to PDF on the same page. WebKit's server is stopped to establish actual network unavailability; this avoids treating emulated offline navigation as proof. The image entry path is checked for absence of the PDF.js engine chunk.
- Existing PDF storage smoke covers browser process restart, offline annotations, reconnect, version changes and owner isolation. Existing PWA update handover and precache gates still apply. The image-specific browser scenario uses reload with the same persistent profile; a full image browser-process restart and real installed-PWA update remain device/release acceptance below.

The first full run passed renderer, PWA update, lint, types, client and Worker suites, then one visual diagnostic test hit a process-cleanup `EPERM`. Its isolated rerun passed. Final gate results and performance are recorded after review below.

## Release and remaining acceptance

Before production release: provision the `same-page-images` Queue; verify account Containers availability and credentials, build/run the Linux Docker image with the native regression specimen, apply migration 0015, deploy the sealed Worker/assets plus renderer sources, then verify health/build identity and authenticated conversion on the deployed Container. Wrangler needs Docker to build the configured image; this was not verified locally. The release archive includes the renderer inputs and hashes them so deployment cannot silently omit or substitute those sources. The upstream Python base tag is mutable, so the actual release image digest must also be recorded.

Use [current platform limits](https://developers.cloudflare.com/containers/platform/limits/) and [current pricing](https://developers.cloudflare.com/workers/platform/pricing/) when provisioning. At the reviewed rates, incremental container compute beyond included usage is memory GiB-seconds × $0.0000025 + CPU seconds × $0.000020 + disk GB-seconds × $0.00000007, with separate Durable Object, Queue and R2 charges. Thirty seconds of configured idle lifetime and cold start can dominate a short conversion. Local wall time is not measured CPU billing, and no actual production cost or latency has been established.

Browser capabilities needed for the image path include modern ES modules, Canvas 2D / PNG decoding, Blob/ArrayBuffer, Web Crypto, AbortController and the existing IndexedDB/PWA platform support; successful image decoding does not make the entire app compatible with legacy engines. PDF.js retains its own modern-browser requirements. Tested desktop Chromium and WebKit are not an asserted minimum supported device/browser version.

Still unverified: the user's original failing PDF and device versions; the reported missing noteheads; representative constrained/e-ink hardware; real iPhone/iPad Safari and installed PWA update, memory pressure, Pencil/keyboard and weak-network behavior; full image browser-process restart; production Container cold start, isolation/memory enforcement, resource cleanup and cost. None is represented as passed by desktop emulation or golden-image success. Issues #98, #105 and #136 are not modified or closed by this implementation.
