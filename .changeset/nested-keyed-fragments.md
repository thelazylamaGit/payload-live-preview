---
'payload-live-preview': patch
---

Target content edits at the smallest covering nested keyed fragment, using the existing boundary cache and per-boundary coalescing scheduler. List structure changes, ambiguous keys, owner mismatches and broad dependencies retain parent rendering. Parent work suppresses descendant requests and writes; list morphs refresh indexed children and bindings.
