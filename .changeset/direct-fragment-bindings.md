---
'payload-live-preview': patch
---

Allow fragment boundaries to opt exact bound fields into direct DOM updates with `patchFields`. Add a safe hex-colour binding for `background-color`, preserve pending server work across revisions, and keep direct updates responsive during sustained edits. Add optional `bindingDebounceMs` to schedule direct writes independently of population; `0` coalesces revisions on animation frames without changing default timing or fragment routing.
