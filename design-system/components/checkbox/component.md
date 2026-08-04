# Checkbox

**Status: planned — not yet shipped.** Built by MC-2117.

The one-of-a-set form control: a value the person marks now and submits
later. The `switch` entry already draws the line — a switch commits
immediately, a checkbox belongs to a form — and today the checkbox side of
that line has no primitive. Five hand-rolled `type="checkbox"` stylings ship
in the product (`learn/TipStartupModal.tsx`,
`settings/TrackerWriteBackSettings.tsx` — the styled-peer control that
motivated `FOCUS_RING_PEER_CLASS` — `workspace/NewWorkspacePanel.tsx`,
`panels/SprintEngineBoardPanel.tsx`, `worktree/WorktreeManager.tsx`), each
with its own box chrome and focus treatment. This entry replaces all five
with one token-backed control: `radius.chip` box, `accent.primary` checked
fill, the shared focus ring, and a real `<label>`.
