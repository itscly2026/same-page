# Issue 137: independent image display verification

> 历史记录：本文描述当时的实现与验证。#156 已移除图片显示、专属 renderer 及其部署/测试入口；相关旧命令和路径不再适用。当前决定见 [ADR0013](../adr/0013-provide-independent-image-score-display.md)，资源处置见 [退役步骤](../operations/image-renderer-retirement.md)。原测量不代表当前性能或 Safari 17.5 真机验收。

Implementation target: [#137](https://github.com/itscly2026/same-page/issues/137), building on the ReaderSession and offline activation boundaries from #136. This report separates local evidence from release and device acceptance. No production migration, provisioning or deployment has been performed.

## Architecture and operating limits

PDF.js remains the default. Its engine import is deferred inside the cancellable document loader, so a failed engine module does not prevent the reader shell or the image path from loading. ImageDocument supplies server geometry and a replaceable background to the existing page layouts and normalized annotation overlay. Local preferences are keyed by owner and score, with a separate owner default. Automatic failure recovery is temporary; only explicit selections persist. No device-name classification or annotation migration is used.

The native engine is PDFium through pinned pypdfium2 5.13.0 / Pillow 12.3.0; the checked fixture reports PDFium 153.0.7999.0. pypdfium2 distributes PDFium dependency notices with its wheel ([licensing](https://pypdfium2.readthedocs.io/en/stable/readme.html)). The container retains installed notices. This is a separate Python process, not PDF.js in another wrapper. Cloudflare's [Containers integration](https://developers.cloudflare.com/containers/get-started/) and [Container package](https://developers.cloudflare.com/containers/container-package/) provide the intended deployment boundary behind a private Durable Object and Queue. The app never receives a public renderer URL.

| Resource | Bound |
| --- | --- |
| Queue / container | One message per batch, one consumer concurrency, one instance; serial HTTP server |
| Native child | 15 CPU seconds; 20-second subprocess wall timeout; Linux address-space limit 768 MiB; unprivileged user; container egress disabled |
| Conversion | 180-second request deadline, at most 200 pages, source limit 50 MiB (upload policy remains 20 MiB) |
| Output | Lossless RGB PNG, long-edge tiers 2048 / 3072, max 32 MiB per image and 512 MiB per generation |
| Client canvas | Max edge 4096, 4 MiPixels per canvas, aggregate 24 MiPixels, two concurrent renders, one lower-resolution retry |
| Offline images | Complete 2048 tier only, max 64 MiB bundled bytes; zoom uses these bytes without requesting the higher tier |

Each immutable PDF version has a deduplicated job with a generation token. The Worker validates source SHA-256, geometry, PNG dimensions/size and the complete sequential manifest before publishing `ready`. Partial outputs have registered object keys. Failure and obsolete generations enqueue deletion through the existing retryable storage cleanup, which rechecks references before deletion. A preparing job becomes retryable after 20 minutes; failed jobs can be retried explicitly. Published generations are reused rather than regenerated on every read. If an authorized image request discovers a missing R2 object, a generation-guarded transition makes that generation retryable; the reader offers a full display reload to prepare a replacement under the same PDF version.

Manifest, status, conversion initiation and image routes all call the same PDF-version authorization resolver as original PDF delivery, including candidate-only administrator access, membership changes, trash and version retention. Images remain derivatives: they do not create PDF versions or increase the configured PDF quota. Their R2 physical storage is service overhead and must be monitored separately. Version deletion cascades image metadata into object cleanup.

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
- Chromium and persistent-profile WebKit exercise upload, PDF-to-image switching, native conversion, image download, second-page offline browser-process restart and a truthful missing-PDF-mode message. Chromium additionally writes an offline annotation and verifies reconnect synchronization and switching back to PDF on the same page. WebKit's server is stopped to establish actual network unavailability; this avoids treating emulated offline navigation as proof. The image entry path is checked for absence of the PDF.js engine chunk.
- Existing PDF storage smoke covers browser process restart, offline annotations, reconnect, version changes and owner isolation. Existing PWA update handover and precache gates still apply. The image-specific scenario also closes and relaunches each browser with its persistent profile while offline, then reads and annotates the stored image bundle. A real installed-PWA update remains device/release acceptance below.

The first full run passed renderer, PWA update, lint, types, client and Worker suites, then one visual diagnostic test hit a process-cleanup `EPERM`. Its isolated rerun passed. Final gate results and performance are recorded below.

## Final local checks and review

The final uninterrupted `npm run check:full` completed with exit code **0** on implementation commit `5aba1e1`: renderer regression, PWA handover, CI scope, lint, types, unit tests (37), client tests (287), Worker unit/integration (7 / 66), visual tests (31), migration verification, production build/precache, real-storage smoke (6) and controlled loading performance all passed. Earlier attempts hit intermittent macOS process-group cleanup `kill EPERM` in two different browser fixtures; the final aggregate run passed without changing that existing helper. The focused cancellation/preference regressions also passed in the affected 44-test run. Remote CI, including the new Linux Docker gate, is pending.

The final smoke includes native image conversion and persistent-browser restart in Chromium and WebKit. A 320 × 568 menu check caught a 7-pixel bottom overflow; the corrected height reserve accounts for the top control capsule, page indicator and safe areas. Both engines now keep the scrolling menu inside the viewport; the resulting screenshots were inspected.

| Normal PDF path | #136 recorded reference | #137 local run |
| --- | ---: | ---: |
| First open | 220–234 ms | 227 ms (another run: 213 ms) |
| Reopen | 31 ms | 31 ms |
| Return to cached drive | — | 38 ms (another run: 29 ms) |
| Precache entries / emitted bytes | 59 / 4,484,922 | 61 / 4,506,563 |

The prior reference comes from `verification-136.md`, not a simultaneous control run. The same controlled WebKit harness applies 75-ms API delay and 5000-ms return-network delay; these single runs do not establish a statistically significant speedup or production latency. The new precache adds 21,641 bytes (0.48%); native rendering and font fixtures are not client assets. Evidence: `artifacts/verification/137/final-build.log`, `final-smoke.log`, `final-performance.log`, `review-edges-green.log` and `check-full-complete.log` (successful aggregate run).

### Standards

The independent review identified persistent preference changes during automatic recovery and a recovery exit that bypassed the editing guard. Both were fixed. Follow-up review identified explicit acceptance of an already selected automatic mode and cancellation during pending authentication; both were reproduced, fixed and rechecked. **No outstanding code findings** after review of `303140e`.

### Spec

The independent review identified a late PDF result winning after selecting images, lack of recovery from a missing ready-generation object, and absence of image browser-process restart coverage. All three were fixed and tested. Follow-up preference/cancellation findings were also closed. **No outstanding code findings** after review of `303140e`; deployment and physical-device acceptance limitations remain as stated here.

## Release and remaining acceptance

Before production release: provision the `same-page-images` Queue; verify account Containers availability and credentials, build/run the Linux Docker image with the native regression specimen, apply migration 0015, deploy the sealed Worker/assets plus renderer sources, then verify health/build identity and authenticated conversion on the deployed Container. Wrangler needs Docker to build the configured image; this was not verified locally. CI now builds the actual Dockerfile and runs the fixed specimen in that image as its unprivileged user with no network, a 1-GiB container limit and the native child limits; the remote CI result remains pending. The release archive includes the renderer inputs and hashes them so deployment cannot silently omit or substitute those sources. The upstream Python base tag is mutable, so the actual release image digest must also be recorded.

Use [current platform limits](https://developers.cloudflare.com/containers/platform/limits/) and [current pricing](https://developers.cloudflare.com/workers/platform/pricing/) when provisioning. At the reviewed rates, incremental container compute beyond included usage is memory GiB-seconds × $0.0000025 + CPU seconds × $0.000020 + disk GB-seconds × $0.00000007, with separate Durable Object, Queue and R2 charges. Thirty seconds of configured idle lifetime and cold start can dominate a short conversion. Local wall time is not measured CPU billing, and no actual production cost or latency has been established.

Browser capabilities needed for the image path include modern ES modules, Canvas 2D / PNG decoding, Blob/ArrayBuffer, Web Crypto, AbortController and the existing IndexedDB/PWA platform support; successful image decoding does not make the entire app compatible with legacy engines. PDF.js retains its own modern-browser requirements. Tested desktop Chromium and WebKit are not an asserted minimum supported device/browser version.

Still unverified: the user's original failing PDF and device versions; the reported missing noteheads; representative constrained/e-ink hardware; real iPhone/iPad Safari and installed PWA update, memory pressure, Pencil/keyboard and weak-network behavior; production Container cold start, isolation/memory enforcement, resource cleanup and cost. None is represented as passed by desktop emulation or golden-image success. Issues #98, #105 and #136 are not modified or closed by this implementation.
