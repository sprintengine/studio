# Skills aside — architect sign-off

Epic: `backlog/epics/skills-aside.md` (1956). Fourteen tasks, nine children, five
review tasks. Signed off 2026-07-29.

Verdict: **the epic's acceptance is met.** Eleven findings remain open,
collapsing to eight distinct issues; none blocks the epic's own acceptance and
all are filed. One is high severity and should be scheduled before this surface
is relied on for removal.

## The five acceptance criteria

Verified against the evidence T10–T13 produced, plus one re-run of the seam
suite at HEAD (`npm run test:seams:skills-aside`, 29 ok / 0 failing) to confirm
the reports still hold after the deep review's fixes landed.

**1. Opening the pane on any of the twelve bundled CLIs shows a truthful answer
— its skills, its servers, or a stated reason there are none. — MET.**
Twelve named assertions, one per bundled plugin, driven from the real manifests
(`skillsAsideSeam.test.tsx`, cases 3–14), with a thirteenth asserting all three
support shapes are represented among them: six native, one `unsupported`, five
declaring no `skillIntegration`. The UI review separately exercised populated,
empty, failed, stale and no-matches in the running app, and confirmed a failed
read renders as a danger banner naming the path, never as an empty list. Loading
and unsupported were not reachable in the built app — resolution beats the 120ms
poll, and the spawn menu offers roles rather than CLIs — and are asserted from
rendered markup instead. That is an honest substitution, not a gap.

**2. A CLI added to `resources/plugins/` with no code change appears correctly.
— MET, and this is the strongest result in the epic.** It was executed twice
independently: a fixture manifest through the real registry at the resolver
(T10), and end to end from manifest to rendered pane in the seam suite (case 17),
with case 18 confirming the twelve keep their own answers once a thirteenth is
loaded. The integration test found the one place it did *not* hold — the invoke
path was resolving reachability from the frozen `SKILL_PACK_HARNESSES` union, so
a thirteenth CLI never received its declared invocation form — and it was fixed
and pinned (case 28). That is the epic's own stated acceptance test for the whole
backend, and it passes by execution rather than by argument.

**3. The pane and `SkillPickerPopover` resolve through the same service. — MET,
with one deliberate documented exception.** Seam case 21 asserts both return the
same reachable skills for one fixture. The picker still calls
`workspaceSkillsList` on one branch: when there is no CLI in play — a
conversation provider, or an automation installing into a per-run worktree —
there is no harness to ask about, and the workspace-wide inventory is the honest
answer. That is a different question, not a second implementation of the same
one. The two call sites that *did* have a CLI and were not passing it were found
and fixed by the spec review.

**4. Editing a harness directory or a CLI config file outside Multicode updates
the pane without a restart. — MET.** Seam cases 22 and 23 cover both halves
against real `fs.watch`. The deep review found the failure mode underneath: a
watched directory deleted out from under the watcher left a dead handle with no
re-attach and no diagnostic — permanent silent staleness, the exact shape the
freshness work existed to prevent. Fixed with a failing-first test.

**5. No surface renders a count, a skill or a server it has not read. — MET.**
Seam cases 15 and 16 assert it directly, and the pane model test pins the
boundary case: an unstated tool count stays absent, never zero. Per D5 no adapter
sets `toolCount`, so the count the mockup draws renders as nothing rather than as
a fabricated number.

## Findings ledger

Forty-five findings were recorded across the fourteen tasks. Thirty-four were
fixed in the session that raised them, each with its verification re-run. Eleven
remain open; several are the same problem seen by more than one reviewer, so they
collapse to eight distinct issues, and all eight are now filed:

| Finding | Severity | Filed as |
|---|---|---|
| `T13-F1` remove deletes across every harness, gated on provenance not content, with no confirm | high | `backlog/2026-07-29-skill-remove-content-gate.md` |
| `T1-F4`, `T2-F2` user-scope MCP servers unread and undisclosed for five CLIs | medium | `backlog/2026-07-29-mcp-server-list-completeness.md` |
| `T1-F5`, `T2-F3`, `T13-F5` `enabled` parsed then dropped, so a disabled server reads as live | medium | same item |
| `T13-F3` two harness→directory maps; eight legacy modules still on the literal | medium | `backlog/2026-07-29-converge-harness-directory-map.md` |
| `T11-F2` pane answers for an agent the user is not looking at | medium | `backlog/2026-07-29-skills-pane-non-agent-tab.md` |
| `T11-F1` row tooltip repeats the description already open below it | medium | `backlog/2026-07-29-skills-pane-tooltip-contract.md` |
| `T11-F4` product tooltip repositions on scroll; the bundle's contract says dismiss | low | same item |
| `T13-F8` `modelRegistry.ts` 1341→1544 lines in an already-overloaded module | low | `backlog/2026-07-29-split-model-registry.md` |

Nothing was closed by assertion. Every "fixed" above carries either a re-run
command with its output or a test that was confirmed to fail against the old
behaviour.

Two of the open findings deserve naming beyond the table. **`T13-F1`** is the
one I would schedule first: the deep review confirmed no input can escape the
intended directories, so this is not a path-traversal risk, but the gate checks
that we wrote a directory and not that its contents are still ours. A user who
adopted a managed skill and edited it loses those edits silently, and the source
item for the attach work called that unrecoverable. **`T13-F3`** is the one most
likely to be dismissed as tidying and should not be: the new path is
manifest-driven and the old one is not, so a thirteenth CLI is correct in the
pane and wrong in install, sync and legacy adoption — the acceptance test passes
while the product is wrong.

## The plan's two open questions

**1. Should `cursor` declare `skillIntegration`, or should `.cursor` leave
`SKILL_HARNESS_DIR`? — Still open. D4's default stands.** No plugin manifest
gained a `skillIntegration` block; the resolver reports Cursor as
skill-unsupported and the stale `SKILL_HARNESS_DIR` entry is untouched. Nothing
in the epic's execution produced evidence either way, because answering it means
establishing whether Cursor genuinely reads a skills directory — a vendor
capability question, not a codebase one. It is carried into
`backlog/2026-07-29-converge-harness-directory-map.md`, which has to confront the
entry anyway.

**2. Do the five install-target `format` values differ on disk? — Answered: no.**
Recorded at `src/main/agent-skill-installer.ts:15–24`. All are the same layout —
a directory whose entry document is `SKILL.md` with YAML frontmatter — and the
three the bundled manifests actually use (`claude-code`, `codex`, `opencode`)
were each read by their own CLI from a byte-identical directory during T4. So
`format` is a routing label rather than a conversion, and there is one writer
instead of a per-format adapter. The comment states what would justify adding
one.

Separately, D6's empirical restart check ran and is worth recording as a result
rather than a default: `restartRequired` was verified **false** for `claude-code`,
`codex`, `kimi-claude` and `zai` by creating a skill directory against a running
CLI and watching it appear in the picker. `grok` and `opencode` could not be
reached on this machine — no Grok sign-in, no OpenCode provider credentials — so
both keep `restartRequired: true` with a `$comment` stating the probe failed and
how to complete it. That is D6 working as intended: the over-warning banner
stands where the evidence is missing, and the missing evidence is named.

## Knowledge Graph

Five notes were assigned. Four were updated, plus two the plan did not anticipate:

- `extensibility-platform.md`, `builtin-skills.md`, `workspace-shell.md`,
  `design-system-bundle.md` — all updated.
- `agent-capabilities.md` — **new**, 222 lines, and the substantive record of
  this epic. It is where the resolver, the freshness contract and the pane's
  verbs are documented.
- `skill-sources.md` — linked to the new note.
- `skills-and-tips.md` — **not updated, correctly.** The plan assigned it, but
  that note documents the Learn Center (startup tips, lessons, `appSettings.learning`)
  and has nothing to do with skill resolution. The developer who found the
  mismatch raised it (`T1-F5`) and wrote `agent-capabilities.md` instead, linked
  from the two notes that do own the area. The plan's assignment was wrong; the
  work was right. No KG gap remains.

## Children

All nine set to `status: completed` in this project's worktree. The epic file
carries no status field — completion derives from its children.

The six follow-up items above are deliberately **not** filed under
`epic: skills-aside`. The epic derives completion from its children, so attaching
open follow-ups to it would keep a finished epic permanently incomplete.

## The hot seam

The engine flagged `ipc:agent-skill-installer` as hot — three tasks have
published changes to it — and asked whether a checkpoint review is warranted.
**It is not, as a new task in this run.** T13 was a whole-change deep review that
audited exactly this file as its highest-priority surface, and the one thing it
found and could not fix forward is `T13-F1`, already filed. A checkpoint task now
would re-read what T13 read and reach the same conclusion. The follow-up item
carries it, and that item's own work should be reviewed when it lands.

## Residual risk

The pane tells the truth about what it read. Where it is incomplete — user-scope
MCP servers on five CLIs, disabled servers shown as live — it is currently silent
rather than explicit, which is the one place this epic's own sixth decision is
not fully honoured. That is the substance of the MCP completeness item and the
reason it is medium rather than low.

The remove path is the only destructive surface here and the only high-severity
finding left open. Everything else is recoverable.
</content>
