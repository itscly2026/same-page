# Reader touch momentum CI stability

## Failure and controlled reproduction

PR #223 head `3254a952` and merge `118a39a1` have the same Git tree
`3200d0715670d2f023d0ae0eec168a57152f5b25`. Both ran `visual/all`.
The PR's native touch scenario passed; main run
[34343576622](https://github.com/itscly2026/same-page/actions/runs/34343576622)
failed at `no momentum: 145 -> 145`. Checks and integration passed and deployment
was skipped. PR attempt 1 had a separate Worker 5-second timeout.

On macOS, the original test passed unchanged. Adding only 150ms between the
pre-release position read and `touchEnd` reproduced `no momentum: 145 -> 145`:

```sh
node --test --test-name-pattern='continuous native touch' visual-report/reader-immersive.test.mjs
```

The host-paced gesture is sensitive to release latency: delayed release can
legitimately produce no native fling. This establishes a test weakness, not the
exact scheduler delay on the historical Ubuntu runner. No production code was
changed to produce the failure. The temporary delay was removed.

## Change and protection

Chromium now schedules one `Input.synthesizeScrollGesture` with explicit touch
input, speed and fling policy. Passive browser listeners record native release
and subsequent scroll positions, avoiding a host read between movement and
release. The test observes at least one second after release and retains the
original >20px momentum assertion and >50px native scroll assertion. Each new
scenario has a 30-second bound and its own browser lifecycle.

A separate no-fling control uses the same browser input path with
`preventFling: true` and requires <=20px post-release movement. Pinch zoom is a
separate scenario; existing Chromium/WebKit anchor tests still cover anchoring.
Diagnostics contain only synthetic event types, relative times and positions.

The existing Browser stability experiment accepts `scenario=reader-touch` to
run all three scenarios ten times on Ubuntu / Node 24. Its original
navigation/offline selection remains the default. Every round's log and exit
status are retained; a failed round fails the experiment rather than being
hidden by a successful retry.

## Local evidence

- Original scenario: passed; injected 150ms pre-release delay: failed with the
  same `145 -> 145` assertion as main.
- New positive/control/pinch scenarios: passed. The first positive observation
  moved from 151px at release to 337px; the no-fling control stayed at 159px.
- Entire reader-immersive file: 15 passed, including Chromium/WebKit anchor,
  editing, alignment and shape interactions (Node 24.19.0).
- Mutation check: forcing the positive scenario to use `preventFling: true`
  failed with `no momentum: 162 -> 162`; the mutation was removed.
- CI scope regression tests: 19 passed.

Ubuntu repetition and full PR CI are reported on the PR. These automated tests
are not real iPad/PWA acceptance or proof of deployment. A subsequent test-only
main push cannot establish that the previously blocked release was deployed.
