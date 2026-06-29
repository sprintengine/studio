# Backlog item schema (v2)

A backlog item is a markdown file under `backlog/`. Its lightweight, human- and
agent-edited fields live in the file's **frontmatter** and are the source of
truth there. App-owned churn — stable id/source, star/highlight, links, module
metadata, and timestamps — lives in the sidecar object store
`.multi-code/backlog/items.json` and is merged over the file at scan time.

This split follows Google Cloud's **Open Knowledge Format (OKF) v0.1**: `backlog/`
is a bundle of markdown concept files, each with one required `type` field;
producer-defined fields are allowed, and unknown types and fields are tolerated
and preserved rather than dropped.

## Frontmatter

Frontmatter is a single block of **flat scalar** `key: value` lines — no nested
YAML, no YAML library, no schema validator. The one writer is
`serializeBacklogFrontmatterFields` in `src/shared/backlog/frontmatter.ts`; it
preserves the document body byte-for-byte and preserves unknown keys and their
order. The matching reader is `parseBacklogFrontmatter` in the same module, which
the renderer read model (`src/renderer/src/utils/backlog.ts`) delegates to so
there is exactly one parser.

```yaml
---
id: 240              # stable workspace-global integer; allocated once, never changes
type: feature        # epic | feature | bug | mockup | spike   (epic = container)
status: ready        # idea | ready | in_progress | needs_input | completed | archived
difficulty: m        # xs | s | m | l | xl   (effort to build)
criticality: high    # low | normal | high | critical   (impact if missing)
risk: normal         # low | normal | high   (likelihood it breaks; not effort)
epic: auth-revamp    # optional; slug of the epic this item belongs to
dependsOn: a-item, b-item   # optional; comma-separated slugs of prerequisite items
updated: 2026-06-26T10:00:00Z   # optional; drives the "recently updated" sort
---
```

### Fields

- **id**: a stable, workspace-global sequential integer that is the item's
  durable identity. Allocated once (scan-max + 1) and **never changed** — not
  across re-type, rename, or re-triage — so anything keyed on it (a commit
  message, an external dashboard) stays valid. The human-facing identifier shown
  in the panel is `<KEY>-<id>` (e.g. `MC-240`), where `KEY` is the per-workspace
  display key; the type is conveyed by a glyph, never encoded in the id (the
  Jira/Linear convention). The number is allocated automatically by the app's
  scan-time pass (`ensureBacklogItemIds`), so a hand-authored item can omit it
  and get one on the next open; an agent that needs to cite an id immediately may
  allocate the next integer above the current max across `backlog/**`. The
  pure helpers live in `src/shared/backlog/item-id.ts`.
- **type** (required by OKF): one of `epic`, `feature`, `bug`, `mockup`, `spike`.
  `epic` marks a grouping container (see below). Unknown values are tolerated on
  read and left untouched.
- **status**: lifecycle state. Files under `backlog/archived/` are always treated
  as `archived` regardless of the field.
- **difficulty**: t-shirt effort estimate. Normally architect-owned.
- **criticality**: product impact. Follows user/product intent.
- **risk**: likelihood the change breaks something — a separate axis from
  `difficulty`. Combined with `difficulty` it derives a row color at render time;
  nothing is persisted, and a manual highlight color always wins.
- **epic**: optional up-pointing slug naming the epic this item belongs to. The
  slug is the epic file's name stem (see below).
- **dependsOn**: optional prerequisite list — a single **flat comma-separated
  scalar** (the frontmatter has no array support), e.g. `dependsOn: a-item, b-item`.
  Each entry is an item **slug = the prerequisite file's name stem** (the same
  identifier `epic:` uses). Read trims, dedupes, and drops the item's own slug, so
  an item can never depend on itself. Like `epic`, dependencies are **stored up,
  derived down**: only the dependent stores the edge; the reverse "blocks" edges
  and the derived "waiting" signal (an active item with an unresolved
  prerequisite) are recomputed on every scan and never persisted to `items.json`.
- **updated**: optional ISO-8601 timestamp powering the "recently updated" sort.

Set an axis only when the current context supports a grounded estimate; leave it
unset rather than guessing. Omitting a field is a calm neutral state, not a
defect — a rough capture can stay untyped and unestimated until an architect
sizes and prioritizes it.

### Backward compatibility

- A single nested `backlog:` section (e.g. `backlog:` then indented `size:`,
  `priority:`) is still read for legacy files, and the aliases `size` →
  `difficulty`, `priority` → `criticality`, and `itemType`/`backlog_type` →
  `type` are honored. New files should use the flat top-level keys above.
- The reader tolerates not-yet-migrated files and sidecar records indefinitely
  (lazy migration): unknown keys are preserved on write, never dropped.
- Star/highlight is owned exclusively by the object store and is never seeded
  from frontmatter.

## Display identifiers

The human-facing id is `<KEY>-<id>` — `MC-240` — composed at render time from the
frontmatter `id` integer and a per-workspace **display key**. The key lives in a
small committed config file `.multi-code/backlog/config.json`
(`{ "schemaVersion": 1, "key": "MC" }`), so the id reads identically on every
machine; when absent it is derived from the workspace folder name and persisted.
Changing the key only changes the displayed prefix — the stored `id` integer is
the identity and never moves, so a key rename never rewrites item files.

Allocation is **scan-max + 1** over committed frontmatter: no counter file, no
daemon. `ensureBacklogItemIds` (main process, invoked from the panel's load flow)
assigns an id to every item lacking one, oldest-first, and writes it to
frontmatter — idempotent once every item has one, mirroring the v1→v2 migration.
Two unmerged branches can mint the same id; that is **detected and surfaced** (a
panel warning naming the colliding files), never silently renumbered — git merge
is the arbiter. Imported issues (future importers) keep their provider key
verbatim and display that instead; the display formatter already accepts an
external override.

## Epics (grouping)

An **epic** is itself a concept file at `backlog/epics/<slug>.md` with
`type: epic`. Its `<slug>` is the filename stem (e.g. `backlog/epics/auth-revamp.md`
→ slug `auth-revamp`); its title is the first `# Heading`. Optional epic fields:

```yaml
---
type: epic
status: ready        # optional
color: blue          # optional; one of the 7 highlight colors, for the group stripe
order: 1             # optional; sort order among epic groups
---
```

Grouping is **derived down, stored up**. The only stored relationship is each
child's `epic:` field. An epic's children are the live query
`items.filter(i => i.epic === slug)`, regenerated on every scan — never persisted,
so it cannot desync. Changing an epic's slug orphans its children until they are
repointed; a child whose `epic:` slug has no matching epic file renders under an
"Unknown epic" group and is never dropped.
