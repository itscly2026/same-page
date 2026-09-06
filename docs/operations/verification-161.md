# UI/UX refinement — #161

Scope: one isolated branch from `40aff5dfc34119b6ee0324238e88bfc50481dc6b`; PR delivery only. Privacy copy is limited to “默认仅自己可见”. No sharing behavior changes.

## Behavior verification

- Existing client/page seams cover edit completion, restored page navigation and subscriptions, offline feedback, authentication copy and navigation.
- Continue-reading tests cover user changes with late responses, current memberships, and current-version page-count clamping.
- Offline control tests cover failed updates retaining an older copy, and download failure before local verification completes. Unknown availability is never reported as confirmed unavailable.
- Worker integration covers admin-only atomic layer reordering, persisted order, boundary moves and missing layers. Layer browser tests cover explicit detail saving and preserved custom names.
- Chromium and WebKit cover responsive layouts, 200% tablet text, 44px controls, zoom/pan preservation across editing, continuous-reader locking, and mobile text composition.

The first complete check run exposed stale UI assertions and one loading-placeholder label. Those were corrected and affected files rerun successfully. Backend unit/integration tests, migrations, typecheck and lint pass. Build/precache and browser smoke checks are recorded in the PR and CI.

## Visual reproduction

Run `npm run build`, then:

```sh
VISUAL_REPORT_SCENARIO=home-guest,home-guest-mobile,home-guest-desktop,home-continue-reading,library-admin-management,shared-layer-management-mobile,shared-layer-grants,reader-tools-mobile,reader-offline-failure,reader-layers-mobile-personal node scripts/generate-visual-report.mjs
```

The generated report is under `artifacts/visual-report/index.html`; screenshots are local verification artifacts. Homepage imagery comes from a self-authored synthetic PDF rendered by the actual reader; see `design/README.md` for regeneration.

## Standards

One P3 finding: stale display terminology in CONTEXT.md. Updated and independently rechecked; no open findings.

## Spec

One P2 finding: a failed download could report a still-unverified local copy as unavailable. Added a failing component test, fixed the unknown state, and rechecked independently; no open findings.

## Acceptance boundary

Browser simulation is not physical iPad/Pencil/soft-keyboard acceptance. Installed-device offline/reconnect and a new user's rehearsal task remain manual acceptance. Production deployment, merging, and closing the issue are outside this PR-only request. Prior observations from an old online session were not treated as independently reproduced defects.
