# Glyphs

The product's icon language: one concept per glyph, drawn in `currentColor`
line work, sized only by the `--sem-icon-size-*` ramp. The twenty-two SVGs in
`glyphs/` (close, search, spinner, multicode-mark, git-branch, remote-machine,
commit, worktree, history, folder, file-typescript, file-generic, and the eleven
Commit-window action marks — rollback, move-to-changelist, stash, group-by,
expand-all, collapse-all, next-difference, side-by-side, unified, gear,
open-in-editor) are
the framework-neutral assets; the shipped vocabulary lives in React —
`src/renderer/src/components/AppIcons.tsx` and the `ui/` glyph primitives
beside it. This entry documents that vocabulary so a consumer can pick, size,
and color a glyph without reading the React source.

A glyph is not decoration and not a status pill. It answers exactly one
question — *which thing is this* (identity), *where is it in its pipeline*
(lifecycle), *who is working on it* (role), *what kind of capability*
(capability), *which runtime* (CLI), or *what will this control do* (action) —
and each question has its own family below. A surface that reaches for two
families to answer one question has the wrong hierarchy, not the wrong icon.

## Anatomy

Two drawing grids, each with its own stroke discipline:

| Grid | Primary stroke | Drawn by |
|---|---|---|
| 24 × 24 | `1.7` (the `iconStroke` constant) | `AppIcons.tsx` — every action, identity, status, and settings icon; `CliIcon.tsx` tile marks (1.7 frame, 1.9 letterform) |
| 16 × 16 | `1.2 – 1.5` | the `ui/` primitives — `LifecycleGlyph` (1.4–1.5), `CapabilityGlyphs` (1.3), `RefreshIcon` (1.35), `StarGlyph` (1.4), `FileTypeGlyph` (1.2 frame, 1.3–1.4 line work, 1.45 letterform) — and the assets in `glyphs/` |

The 24-grid stroke flexes deliberately and narrowly: secondary strokes step
*down* by 0.1–0.3 (`iconStroke - 0.3` on the `RoleGenericIcon` inner ring), and a
check or emphasis stroke steps *up* to 1.8–1.9 (the shield tick, the tile
letterforms). Anything outside that band is drift, not a variant.

- **`currentColor`, always.** A glyph inherits the ink of the text beside it
  and never carries its own palette. The whole list of self-coloring
  exceptions: `PriorityIcon` urgent/high (`--tone-error` / `--tone-warn`),
  `StatusIcon` done and the in-progress wedge family (`--tone-good` /
  `--tone-accent`), the role tone applied by `RoleGlyph` / `RoleAvatar`
  (see Variants), and the two **identity-colour** families ruled 2026-09-06
  (principles.md → "Identity colour"): vendor marks in their vendors' colours
  (`CliIcon`, `brand/EditorMarks`), and `FileTypeGlyph` under `tone="kind"`,
  which inks by language from the `--sem-color-mark-*` ramp.
- **Drawn for 16 px.** Every glyph must read at `--sem-icon-size-sm`; detail
  that only resolves at 22 px is detail the glyph cannot afford.
- **Named by grid.** 24-grid components end in `Icon`; 16-grid primitives end
  in `Glyph`. (`RefreshIcon` predates the rule — see Known drift.)
- **Never its own hit area.** An interactive glyph pads out to
  `--sem-size-control-xs` (26 px) with a transparent hit area; the glyph
  itself never grows to fill the target.

**The size ramp** — these four steps are the sanctioned sizes, and 16 px is
the rail canon (the leading-glyph slot of every sidebar and door-rail row):

| Token | Value | Use |
|---|---|---|
| `--sem-icon-size-xs` | 13px | Inline glyphs beside meta copy and inside chips |
| `--sem-icon-size-sm` | 16px | **The default.** List-row leading slots, toolbars, close glyphs |
| `--sem-icon-size-md` | 18px | Icons paired with button labels, panel-header chrome |
| `--sem-icon-size-lg` | 22px | Empty-state glyphs, large overlay close buttons |

A rail row reserves a fixed 16 px leading slot whether or not the glyph fills
it — an unreserved slot is what lets sibling doors' titles start at three
different x-offsets (Known drift, MC-2098).

## Variants

The variants of this system are its families. Within a family, glyphs share a
grid, a stroke, and a naming pattern; across families they share nothing but
the ramp and `currentColor`.

### Core actions and navigation (24-grid)

| Export | Meaning |
|---|---|
| `CheckIcon` | Confirmed / applied |
| `ChevronDownIcon` | Disclosure; rotate for other directions rather than adding siblings |
| `CopyIcon` | Copy to clipboard |
| `NewChatIcon` | Compose — pencil-in-square, deliberately *not* a plus, because compose is not create |
| `WarningIcon` | Finding / warning triangle — a real glyph so it scales and inks like one, never the `▲` character |
| `FolderPlusIcon` | Install from a folder on disk — a folder wearing the plus |
| `ResetIcon` | Restore a default: the shortcut a person rebound, a setting they changed |
| `ReleaseNotesIcon` | What changed in this version |

There is no standalone `CloseIcon`. The dismiss mark lives inside
`ui/CloseIconButton`, on its own 14-grid at stroke 1.4, because a close glyph
is only ever a button — an unpadded one is below the hit-target floor.
`glyphs/close.svg` is the framework-neutral sample of the same mark.

### Workspace-type identity (24-grid, registry-resolved)

`WorkspaceTypeIcon` is the dispatcher: it resolves a workspace mode through
the renderer host registry, gated on module enablement when
`moduleOverrides` is passed, and degrades to the standard glyph for anything
disabled or unknown. Consumers go through it; the concrete marks exist for
the registry to point at:

| Mark | Drawing |
|---|---|
| the standard fallback | Terminal-in-frame — module-private, reached only through the dispatcher |
| `SprintEngineWorkspaceTypeIcon` | Three-node crew triangle |
| `SprintEngineMarkIcon` | The SprintEngine brand comet — pair with `--tool-sprintengine-ink` |
| `AutomationsWorkspaceTypeIcon` | Schedule dial around a lightning bolt — "on a schedule, do work" |
| `FolderTypeIcon` | The project folder, optionally wearing a workspace's own logo |

### Status (16-grid)

There is one status vocabulary, and it is `LifecycleGlyph` (below). The 24-grid
`PriorityIcon` / `StatusIcon` pair that used to sit here is gone: it was a
second answer to the same question, drawn on a different grid, and the folder
status enum it keyed off is now `FolderStatus` in the shared layer with no
glyph family of its own.

One status idiom per surface: a surface shows the 6 px `StatusDot` *or* a
`LifecycleGlyph`, never both.

### Lifecycle (16-grid — `ui/LifecycleGlyph.tsx`)

The shape-coded lifecycle vocabulary shared by Backlog readiness and Sprint
Engine task state. Eighteen states, read by shape first — every state
survives grayscale — with ink only reinforcing:

| Shape | States |
|---|---|
| Ring (plain / dashed) | `todo`, `ready` (heavier stroke), `idea` (dashed) |
| Ring + inner mark | `blocked` (bar), `paused` (pause bars), `needs_input` (!), `changes_requested` (return arrow), `archived` (slash), `failed` (×) |
| Filling gauge arc | `in_progress` ¼ (spins when `live`), `review` ½, `testing` ¾, `product` ⅞ |
| Disc / ring + check | `done` (filled), `approved_auto` (outline) |
| Branch fork | `done_unmerged` (`--tone-good`), `done_merged` (`--tone-merged`) — same shape, tone carries merged-ness |
| Document + tick | `recorded` |

Held states (`blocked`, `paused`) are neutral ink, never the accent — the
accent means *startable or live right now*, and never `--tone-error` —
waiting is calm, not a defect.

### Role (24-grid drawings, 16-grid wrappers)

`SprintEngineRoleIcon(role, registry)` dispatches to module-private drawings
(architect, product, developer, frontend and ui/ux reviewer, tester, security,
performance, production-readiness, cross-platform) and falls back to a neutral
disc for an absent or unrecognised role. `SpecialistActionIcon(icon)` keys the
same drawings by specialist-action id (adding writing, spaghetti, nuclear,
infra, shield and the two design ids).
The drawings are private on purpose: going through the dispatcher is what
makes unknown ids degrade instead of crash.

Two wrappers apply role *tone* — the documented exception to the one-accent
rule, and the only one:

- `RoleGlyph` — the bare toned glyph, for a single inline slot (kanban-card
  trailing slot, task-graph node label). Sizes sm/md/lg (12/14/16 px).
- `RoleAvatar` — the toned identity disc with the glyph centered, for roster
  rows, running-agents lists, chips, spawn-dialog headers. Sizes xs/sm/md
  (16/24/28 px disc).

Role tone never bleeds into panel chrome, list rows, headers, or inspector
sections; status and selection stay on `--accent-primary` and `--tone-*`.

### Capability (16-grid — `ui/CapabilityGlyphs.tsx`)

| Export | Meaning |
|---|---|
| `SkillsGlyph` | The Skills category mark (framed panel) |
| `McpGlyph` | The MCP plug mark |

Shared by Extensions and capability inventory rows so a category reads the
same everywhere; default themselves to `icon-xs` + `--text-muted`.

### CLI / runtime marks (`CliIcon.tsx`)

`CliIcon(cli)` resolves an agent CLI to one of eight marks: `claude-code`
(the brand starburst — the one glyph with its own fill), `codex` (the knot
mark, `currentColor`), `opencode`, and five original rounded-square tile
marks (`zai`, `grok`, `kimi`, `cursor`, `muse` — placeholders until official
brand SVGs are bundled; both Kimi runtimes share one mark so they read as one
provider), with `terminal` as the fallback. Tile marks keep the 24-grid
discipline: 1.7 frame, 1.9 letterform.

### File type (16-grid — `ui/FileTypeGlyph.tsx`)

*Which kind of file is this row about*, answered by shape first. One drawing
per kind in the 16 px leading slot every tree and list row reserves — the File
Explorer and the Git changes list wear the same mark for the same file, so a
`.ts` reads as a `.ts` on both (owner 2026-09-05, the IDE Project-view
idiom). `fileTypeKind(name)` is the pure resolver and `FILE_TYPE_LABEL` names each
kind for a tooltip or `aria-label`; the identity hue a kind wears when coloured
is private to the component, applied through its `tone` prop.

| Kind | Shape |
|---|---|
| `typescript` · `javascript` · `python` · `rust` · `go` | Letter tile: rounded frame at 1.2, letterform at 1.45 (TS / JS / PY / RS / GO) — the 16-grid cousin of the `CliIcon` placeholder tile |
| `typescript-test` · `javascript-test` · `python-test` · `rust-test` · `go-test` · `react-test` | The same drawing with its bottom-right corner notched for a tick — `*.test.*` and `*.spec.*` |
| `react` | The atom — `.tsx` / `.jsx` |
| `json` | Braces `{ }` |
| `markdown` | M with a down arrow |
| `yaml` | Indented list lines |
| `html` | Angle brackets `< >` |
| `css` | Hash `#` |
| `shell` | Prompt `>_` |
| `java` | Cup |
| `image` | Framed landscape |
| `lock` | Padlock — lockfiles (`package-lock.json`, `yarn.lock`, `Cargo.lock` …) |
| `config` | Gear — dotfiles, `.env*`, `Dockerfile`, `.toml` / `.ini` / `.xml` |
| `text` | Document with lines — `.txt`, `.csv`, `LICENSE`, `README` |
| `generic` | Plain document — anything unrecognised |

Colour is the `tone` axis, and the surface picks it (ruled 2026-09-06,
amended 2026-09-09, principles.md → "Identity colour"). `tone="ink"`, the
default, is the monochrome glyph the 2026-09-02 ruling left: it takes the
row's ink, and it is what a row uses when its glyph names no language or when
the surface wants no identity channel at all. `tone="kind"` inks the glyph in
its language's identity hue from the `--sem-color-mark-*` ramp, the pairings
people know from their editors:

| Hue | Kinds |
|---|---|
| `mark.blue` | `typescript` · `python` · `markdown` |
| `mark.yellow` | `javascript` · `json` · `lock` |
| `mark.cyan` | `react` · `go` |
| `mark.orange` | `html` · `rust` |
| `mark.red` | `yaml` · `java` |
| `mark.teal` | `shell` |
| `mark.violet` | `css` · `image` |
| *(row ink)* | `config` · `text` · `generic` — they name no language |

A `*-test` kind takes its base language's hue: the notch says "test", the hue
still says which language.

**Both file surfaces wear `tone="kind"` (amended 2026-09-09).** The
2026-09-06 ruling let the hue on only where nothing else in the row was
coloured, which admitted the File Explorer and excluded the Git changes list.
The owner reversed the exclusion for the Commit window: a Git row carries the
kind hue on its glyph **and** the status tint on its name, because the hue
identifies and the tint grades. The glyph is the same blue on a modified,
added and deleted `.ts` row — it never moves with state — so the only thing
grading in the row is still the name.

The hue identifies and never grades: it is not a status ramp, and a `.ts` row
is not "more" than a `.md` row for being bluer. A row still spends at most two
colour channels, and the second one is the name's. `glyphs/file-
typescript.svg` and `glyphs/file-generic.svg` are the framework-neutral samples
of the tile and document idioms, in `currentColor`.

`FolderGlyph(open)` is the family's folder: the outlined folder in the same
16 px slot, so a folder row's name starts at the same x as a file row's. The
chevron beside it carries expanded state, so a tree may leave `open` off and
let the folder read the same either way. `glyphs/folder.svg`.

### Git views (16-grid — `panels/GitPanel.tsx`)

The Git panel's glyph-only view strip. Three of the five were redrawn on
2026-09-05 to the shapes IDEs have taught a decade of developers to read;
the first set had to be learned from the tooltip.

| View | Shape | Asset |
|---|---|---|
| Changes | A commit node on a line identifies changes | `glyphs/commit.svg` |
| Worktrees | A folder holding that node: a checkout in its own directory | `glyphs/worktree.svg` |
| Log | The history clock | `glyphs/history.svg` |
| Stashes | The drawer — the same one drawing the Stash *action* wears, extracted to `ui/GitActionGlyphs.tsx` so the view strip and the toolbar cannot drift | `glyphs/stash.svg` |
| Terminal | The prompt in a frame | — |

### Git and diff actions (16-grid — `ui/GitActionGlyphs.tsx`)

*What will this toolbar button do* on the Commit window and the diff window
(epic `git-commit-window`, 2026-09-09).
Action glyphs, not identity: they answer the sixth question, so they sit here
rather than in the Git-views strip above, and the two families share `stash`
because putting changes away is one concept whether it is a view or a verb.
16-grid, `currentColor`, `fill="none"`; frame 1.3, line work 1.4. Every one is
`aria-hidden` — the icon-only button that hosts it carries the `aria-label`.

| Export | Concept | Shape | Asset |
|---|---|---|---|
| `RollbackGlyph` | Discard a file's changes | The undo arrow: a hook doubling back on itself. **Not** `ResetIcon` — that is "restore a default", a 24-grid settings act, and this one throws work away | `glyphs/rollback.svg` |
| `MoveToChangelistGlyph` | Move files between changelists | Two opposed arrows, one over the other | `glyphs/move-to-changelist.svg` |
| `StashGlyph` | Stash uncommitted work | The drawer. One drawing, shared with the Stashes view above | `glyphs/stash.svg` |
| `GroupByGlyph` | Grouping options | The target: a ring crossed by four ticks | `glyphs/group-by.svg` |
| `ExpandAllGlyph` | Expand every group | Two chevrons apart | `glyphs/expand-all.svg` |
| `CollapseAllGlyph` | Collapse every group | The same two chevrons, together | `glyphs/collapse-all.svg` |
| `NextDifferenceGlyph` · `PreviousDifferenceGlyph` | Step to the next / previous hunk | An arrow travelling to a rule — the hunk boundary it lands on. One drawing, mirrored for the other direction, the way `ChevronDownIcon` is rotated rather than twinned; a bare chevron would say *disclosure*, which stepping is not | `glyphs/next-difference.svg` |
| `SideBySideGlyph` | Diff layout: two panes | A frame split by one vertical line | `glyphs/side-by-side.svg` |
| `UnifiedGlyph` | Diff layout: one pane | The same frame, unsplit. The pair is a two-state toggle, and the presence or absence of the divider *is* the difference | `glyphs/unified.svg` |
| `GearGlyph` | Settings on a toolbar | A real toothed gear. `GeneralSettingsIcon` is sliders on the 24-grid rail and the `config` file kind is an identity mark, so neither serves an action toolbar | `glyphs/gear.svg` |
| `OpenInEditorGlyph` | Open the file in an editor | The pencil on the page: the one mark in this family that leaves the diff rather than rearranging it | `glyphs/open-in-editor.svg` |
| `WriteCommitMessageGlyph` | Compose the commit message | Three lines of a message with a crossed spark beside them: *text, composed for you*. A pencil would say a person types it, which is `OpenInEditorGlyph`'s job | `glyphs/write-commit-message.svg` |
| `OpenInEditorGlyph` | Open this file in an editor | The pencil on the page. The one mark in the family that leaves the diff rather than rearranging it, so it is not another frame (added 2026-09-09 for the diff window's toolbar, T4) | `glyphs/open-in-editor.svg` |

Reused, not redrawn, by the same two surfaces: `RefreshIcon` (re-read the
working tree), `FileTypeGlyph` `lock` (the padlock), `glyphs/commit.svg`,
`glyphs/worktree.svg`, `glyphs/history.svg` (the view strip), and
`ChevronDownIcon` rotated for disclosure.

### Utility marks (16-grid)

| Export | Meaning |
|---|---|
| `StarGlyph(filled, stroked)` | The one star path for starred/favorite — solid when earned, outlined for menu unstarred states. Caller owns size and ink |
| `RefreshIcon` | The canonical two-arrow refresh, shared by every panel that offers a manual re-read (Git status, Backlog scan) |
| `GitBranchGlyph` | The branch fork beside a branch name — sidebar rows, the git button, the run-on strip. `glyphs/git-branch.svg` |
| `PresetDialGlyph` · `LockGlyph` · `UnlockedGlyph` · `SparkGlyph` | The access-level vocabulary (CLI default · Manual · Bypass · Auto) on the permission-preset menu rows and the composer's permission pill — one drawing per concept, shared by both hosts. Inline in `AppIcons.tsx`; no standalone asset. |
| `RemoteMachineGlyph` | The stacked-server mark for anything remote — rows, group headers, pickers, the top-bar glyph (remote-sessions-ux decision 7: one glyph, machine name beside it or in the tooltip). Stroke 1.4. `glyphs/remote-machine.svg` |

### Settings rail (24-grid, one per category)

`GeneralSettingsIcon` (sliders), `ProfileSettingsIcon` (person),
`AppearanceSettingsIcon` (half-filled disc), `ShortcutsSettingsIcon`
(keyboard), `AgentsSettingsIcon` (robot), `ProvidersSettingsIcon` (plug),
`SpecialistPacksSettingsIcon` (package cube), `GithubSettingsIcon` (branch),
`TrackersSettingsIcon` (tagged file), `KnowledgeGraphSettingsIcon` (node
triangle), `DesignSystemSettingsIcon` (disc, square and triangle),
`ModulesSettingsIcon` (2 × 2 grid), `MobileSettingsIcon` (phone),
`RemoteSettingsIcon` (two linked machines), `LearnSettingsIcon` (open book).
All at `iconStroke` so the rail reads as one set.

## States

| State | Treatment |
|---|---|
| Rest | Inherits the surrounding ink — typically `--sem-color-text-muted` in a row or toolbar |
| Hover / active | The *owning control* shifts its ink and background; the glyph itself defines no hover |
| Live | `LifecycleGlyph` `in_progress` with `live` rotates (`.ds-glyph--spin`). The only animated glyph state, honoring `prefers-reduced-motion` |
| Disabled | Ink drops to `--sem-color-text-disabled` via the owning control |
| Meaning-bearing | `role="img"` + `aria-label` (see Accessibility) |
| Decorative | `aria-hidden="true"` |

## Usage

- **Pick the family by the question, then the glyph by the table.** Never
  answer a lifecycle question with a status dot *and* a glyph, or an identity
  question with an action icon.
- **Size from the ramp, nothing else.** Rails and toolbars at `sm`; chips and
  inline-with-meta at `xs`; button-paired and panel-header at `md`;
  empty states at `lg`. A 28 px icon button is not a size the system has
  (Known drift, MC-2119).
- **Reserve the slot.** A rail row's leading glyph slot is a fixed
  `--sem-icon-size-sm` box; a smaller glyph centers in it rather than
  narrowing it.
- **One meaning per shape.** The plus belongs to create; compose gets
  the pencil-in-square; a second surface wanting "add" reuses `PlusIcon`, it
  does not redraw it. Duplicating a path into a second file is how the
  title-bar chrome ended up with two divergent copies of the same four
  glyphs (Known drift).
- **Drawing a new glyph:** 24-grid, `iconStroke` 1.7, `currentColor`, one
  concept, `fill="none"` line work, legible at 16 px. Name it `<Concept>Icon`
  (24-grid) or `<Concept>Glyph` (16-grid); a framework-neutral copy
  contributed to `glyphs/` takes a kebab-case concept name per the naming
  grammar in `design-system.json`.
- **Rebuilding in a framework:** React consumers import from `AppIcons.tsx`
  and the `ui/` primitives — never paste paths inline. Framework-neutral
  consumers take the `glyphs/` assets. Both size via the ramp tokens and ink
  via `currentColor`.

## Accessibility

- **Decorative is the default.** A glyph whose meaning is carried by adjacent
  text is `aria-hidden="true"` — every core action, identity, and settings
  icon ships that way.
- **Meaning-bearing glyphs label themselves.** `PriorityIcon`, `StatusIcon`,
  a labelled `LifecycleGlyph`, `StarGlyph` with `label`, and
  `RoleGlyph`/`RoleAvatar` carry `role="img"` + `aria-label` (and a `<title>`
  where hover should confirm). Omit the label only when the row's text
  already announces the state.
- **Icon-only buttons carry `aria-label`** on the button; the glyph inside
  stays hidden. Pair with a tooltip that says the consequence, not the name.
- **Shape first, color second.** Every status and lifecycle state is
  distinguishable in grayscale; ink only reinforces. Color is never the sole
  differentiator — the one narrow exception is merged-vs-unmerged on the
  branch fork, where a distinct merge shape read as noise at 16 px and the
  label carries the difference.
- **Hit targets.** Nothing interactive below `--sem-size-hit-target-min`;
  the glyph pads out, it does not grow.

## Known drift

Shipped divergences from the conventions above, with their backlog homes.
Cite these rather than matching the code you happen to be nearest.

1. **Four icon-button sizes in the chrome strips** — 22 px
   (`WorkspaceIdentity` star toggle), 26 px (`SidebarChrome`
   `BRAND_ROW_BUTTON`), 28 px (`AppTitleBar` / `WorkspaceHeader`
   `STRIP_BUTTON` — off the 26/30/34 control ramp entirely, and with no
   radius or hover fill where SidebarChrome's 26 px button has both), and
   30 px (`AppMenuButton`). Canon is `--sem-size-control-xs` (26 px).
   Tracked as **MC-2119** (icon-size conformance axis). *2026-09-02:* the
   kit's own off-ramp sites are resolved — `CursorErrorPopover`'s two 20 px
   reveal buttons are `IconButton` / `CloseIconButton`, and `MenuSwatchRow`'s
   20 px swatches pad out to the 24 px hit-target floor. **Resolved 2026-09-02**
   for the app chrome too: `STRIP_BUTTON` is deleted from `WorkspaceHeader` and
   `AppTitleBar`, and every strip, popover-trigger and row glyph button in the
   renderer is `IconButton` / `CloseIconButton` at `--sem-size-control-xs`
   (backlog `icon-buttons-off-the-control-ramp`); the conformance guard's
   `focus-ring-missing` rule keeps a bare button from returning.
2. **Per-door rail glyph sizes 16 / 13 / 12 px** — Sprints and
   Automations lead rows with 16 px glyphs (titles at x = 42 px), Extensions
   with bare 13 px `icon-xs` glyphs and no fixed-width wrapper (39 px), the
   Design door with a 12 px chip (38 px) — so sibling doors' titles start at
   three different offsets in the same column. `AutomationTypeGlyph`
   compounds it: an 18 px `icon-md` SVG inside a 16 px box, overflowing by
   2 px. Canon: `sm` glyph in a reserved 16 px slot. Tracked as **MC-2098**
   (door glyph normalization).
3. **Copy-pasted chrome SVGs.** The back / forward / search / panel-left
   paths are duplicated between `AppTitleBar.tsx` and `SidebarChrome.tsx`
   rather than shared, and the two copies get different hit areas and hover
   treatments (item 1). One export, two consumers, is the fix.
4. **Stroke drift at the edges.** The chrome strips draw bespoke 16-grid
   glyphs at 1.5 with a one-off 1.6 "+"; window controls sit at 1.2–1.4; a
   backlog toggle at 1.3 beside a skills glyph at 1.5. The 16-grid band is
   1.2–1.5, so most of these pass individually — the drift is per-surface
   inconsistency, resolved by consuming the shared exports (item 3).
5. **`RefreshIcon` is a 16-grid primitive named `Icon`** where the family
   convention is `Glyph`. Rename when it next moves.
6. **The `glyphs/` folder holds twenty-two assets** against a shipped vocabulary of
   roughly sixty. This entry closes the documentation gap; extracting
   framework-neutral SVGs for the core-action set into `glyphs/` (and
   registering them in `design-system.json`) remains open. *2026-09-05:* the
   Git view marks, the folder and two file-type samples joined the folder.
   *2026-09-09:* the ten Commit-window and diff-window action marks joined
   it (Git and diff actions, above).
