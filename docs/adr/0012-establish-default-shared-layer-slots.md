---
status: superseded by ADR-0014
---

# Fix the annotation model to ESATB and Personal

Every score contains exactly five shared layers: E · Ensemble, S · Soprano,
A · Alto, T · Tenor and B · Bass. E is the shared place for annotations that
matter to the whole ensemble. A signed-in user also has exactly one P · Personal
layer per score.

Shared layers are product slots rather than administrator-created records.
Administrators cannot add, rename, delete or reorder them. They configure a
default color and edit grants for each slot at drive scope. Edit grants therefore
apply consistently to the same slot across every score in the drive.

Shared-layer subscription and color are reading preferences, independent from
edit permission. Subscription resolves from score override, then the user's
drive default, then the product default. Color resolves from the user's drive
override, the administrator's drive default, then the product default; score
color overrides are not part of the model. Personal has neither subscription
nor administrator configuration.

Reading and editing deliberately use different visibility rules. Reading shows
subscribed shared layers plus Personal. Editing ignores subscription and shows
only the selected E/S/A/T/B/P layer, including an editable shared layer that is
currently unsubscribed. Selecting that layer never changes subscription or
creates a score override. Edit locks therefore belong only to shared-layer
buttons in the editing toolbar.

The UI follows the same separation. A score's layer panel owns score
subscription overrides and read-only effective colors under “显示哪些批注”.
“恢复默认显示” exists only while score overrides exist. Personal is an
always-visible status row. “我的偏好” opens “阅读偏好”: display defaults come
first, with “批注颜色” as a separate secondary screen in the same drive context.
Color overrides have one state, either drive default or custom, and only custom
colors offer a reset. All slots retain their English names without fixed Chinese
voice-part translations. “写到哪里” identifies shared and personal audiences,
while the editing toolbar keeps the selected target visible. Settings retain
confirmed values until a save succeeds and offer adjacent failure feedback and
retry; concurrent saves on different layers cannot overwrite each other's status.
“云盘管理 → 共享层” owns administrator default colors and member edit grants.

This replaces the earlier G/S/A/T/B plus custom-layer model. Because the product
is in greenfield development and the existing PDFs and annotations are
disposable, the migration rebuilds annotation tables and invalidates cached
offline content instead of preserving ambiguous legacy layer identities.
