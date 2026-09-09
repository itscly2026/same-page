# Reader touch momentum CI stability

> 后续测试价值审查：本文保留 #227 的历史诊断证据。常规 CI 已移除惯性位移和停住后松手对照，改为触点按下期间的原生滚动集成检查；`reader-touch` 实验现在重复该集成检查与原生双指输入。见 [2026-09-09 测试价值清理](../operations/test-value-audit-2026-09-09.md)。

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

The native `Input.dispatchTouchEvent` path uses explicit timestamps at 16ms
intervals to define velocity independently of host/transport scheduling. A
150ms transport stall before release is retained as regression pressure; it
must not change the synthetic input velocity. Passive browser listeners record
native release and subsequent scroll positions. The test observes at least one
second after release and retains the original >20px momentum assertion and
>50px native scroll assertion. Each new scenario has a 30-second bound and its
own browser lifecycle.

A separate stationary-release control uses the same event path but advances the
input release timestamp by 150ms, requiring <=20px post-release movement. This
distinguishes a genuine stationary release from a delay in transporting events.
Pinch zoom is separate; existing Chromium/WebKit tests still cover anchoring.
Diagnostics contain only synthetic event types, relative times and positions.

An initial `synthesizeScrollGesture` implementation passed locally but failed
all ten Ubuntu rounds with no touch moves or scrolling. It was replaced by the
original cross-platform dispatch path; that experiment is not passing evidence.

The existing Browser stability experiment accepts `scenario=reader-touch` to
run all three scenarios ten times on Ubuntu / Node 24. Its original
navigation/offline selection remains the default. Every round's log and exit
status are retained; a failed round fails the experiment rather than being
hidden by a successful retry.

## Local evidence

- Original scenario: passed; injected 150ms pre-release delay: failed with the
  same `145 -> 145` assertion as main.
- Timestamped positive/control scenarios passed, including an additional
  150ms transport stall before release (now retained as regression pressure).
- Final timestamped implementation: whole reader-immersive file passed all 15
  tests on macOS / Node 24.19.0, including Chromium/WebKit anchoring and editing.
- Removing the explicit input timestamps made the final positive scenario fail
  with `no momentum: 145 -> 145`; timestamps were restored.
- CI scope regression tests: 19 passed.

Ubuntu repetition and full PR CI are reported on the PR. These automated tests
are not real iPad/PWA acceptance or proof of deployment. A subsequent test-only
main push cannot establish that the previously blocked release was deployed.
