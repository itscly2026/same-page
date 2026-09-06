---
status: partially superseded by ADR-0014 (personal-layer read access)
---

# Use application-level privacy for personal layers

Personal layers use authenticated server authorization and are private by default. The original decision that administrators and other users could never read them is superseded by [ADR-0014](0014-configurable-and-published-layers.md): an author may share a personal layer for one score with drive members, who receive read-only access. Editing remains author-only.

The encryption decision remains in effect: V1 does not use end-to-end encryption against Same Page operators. End-to-end encryption would complicate account recovery, multi-device synchronization, conflict handling, and support; operational access is instead minimized and disclosed, and annotation content is excluded from application logs.
