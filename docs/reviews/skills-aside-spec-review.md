# Spec review — is the backend genuinely manifest-driven?

Sprint `skills-aside`, task T10. Audits T1–T4 (`agentCapabilities` resolver and
harness map, MCP config read path, freshness watchers, attach/remove) against the
seven architectural decisions in `backlog/epics/skills-aside.md`, which bind
every child of the epic.

**Verdict: conforms.** The decisive check passes — an invented thirteenth CLI
resolves its skills and its servers, and receives an attach, with no edit to any
production file. Four findings are recorded below; two were fixed in this review,
two are residual and named with their owner.

## The decisive check, executed

The epic names one acceptance test for the whole backend: *adding a thirteenth
CLI must require zero change to the resolver.* It is now run rather than argued,
in `src/main/workspace-skills-service.test.ts` (`testThirteenthCli`).

A fixture `plugin.json` for an invented CLI (`hypertron`) is written into a
temporary **user plugin root** and loaded through the real
`createPluginRegistry`, so the manifest passes the same validation a dropped-in
plugin would. Every path in it is invented precisely so a hardcoded directory,
config path or CLI list anywhere in the chain would fail the test:

| Declared | Value |
|---|---|
| `skillIntegration.harnessId` | `hypertron` |
| `installTargets[0].path` | `{{workspaceRoot}}/.hypertron/agent-skills/{{skillId}}` |
| `installTargets[0].format` | `generic` |
| `invocation.explicitTemplate` | `#{{skillId}}` |
| `mcpConfig.path` | `{{workspaceRoot}}/hyper-mcp.json` |
| `mcpConfig.userPath` | `{{home}}/.hypertron/hyper-mcp.json` |

Asserted, all passing:

- the registry accepts the manifest (`report.rejected` empty) and lists exactly
  one more CLI than the app ships;
- `agentCapabilities` reports `support: native`, `harnessId: hypertron`, no
  diagnostics;
- the skill in `.hypertron/agent-skills/deploy` is read, named from its
  `SKILL.md`, and invoked as `#deploy` — from the fixture's own template;
- both declared MCP scopes are read from the fixture's own paths, workspace
  first, user second, unioned by server id;
- `attach` writes `.hypertron/agent-skills/shipit` on disk, reports
  `restartRequired: false` from the fixture's own manifest, and attributes the
  target to `hypertron`.

Command: `npm run test:main:workspace-skills` → `workspace-skills-service tests
passed`. Working tree after the run contains no change to `resources/`,
`src/main/`, `src/shared/` or `src/renderer/` beyond this review's own edits.

## The seven decisions

**1. Derived, never stored — PASS.** `createAgentCapabilityService`
(`src/main/workspace-skills-service.ts:125`) reads the filesystem on every
`resolve`; there is no cache, no persisted "installed skills" model, and the IPC
handler (`src/main/ipc/workspace-skills-ipc.ts:34`) is a direct pass-through.
`app-services.ts:119` wires `listPlugins` and `lookupManifest` as live registry
lookups, so a reloaded registry is reflected without a restart. The watcher emits
invalidation only — `{ workspaceRoot, harnessId, pluginIds }` — never a payload,
so nothing downstream can become a second source of truth.

**2. The plugin manifest is the only map — PASS.** `src/shared/harness-map.ts`
parses the skills directory out of the declared `installTargets[].path` template
(`skillsDirFromTemplate`) and refuses anything it cannot read literally. Grep
over `harness-map.ts`, `mcp-config-readers/`, `workspace-skills-service.ts`,
`agent-skill-installer.ts` and `capability-watcher.ts` finds no harness directory
or config path as a string literal — the only matches are prose in comments. The
fixture above is the executed proof.

**3. Harness is the unit, not CLI — PASS.** `buildHarnessMap` collapses
`claude-code`, `kimi-claude` and `zai` onto one `claude` binding and attributes
the result to all three via `AgentSkill.pluginIds`. A recording reader in the
existing test proves one directory read per resolve, not three, and that asking
about `kimi-claude` returns all three plugin ids.

**4. Ports and adapters for formats — PASS.** `McpConfigReader` +
`MCP_CONFIG_READERS` (`src/main/mcp-config-readers/registry.ts`); the resolver
looks the format up by key and never names one. There is no `switch` on format
anywhere in the read path. `generic` is deliberately unregistered and produces a
stated diagnostic rather than "no servers". Adding a format is one adapter file
and one registry line. (The *write* path — `syncForFormat` in
`mcp-config-service.ts` — still switches; pre-existing and outside this epic.)

**5. One query, one shape — PASS.** One channel, `skills:agent-capabilities`,
returning the sketched shape. No surface joins several calls to answer the
question; the renderer's only resolution logic is choosing which of the two
inventories to ask for (see finding 1).

**6. Unavailability is a result, not an empty list — PASS.** All five states are
distinguishable in the payload and each is asserted in
`workspace-skills-service.test.ts`: no `skillIntegration` (`support:
'unsupported'`, `harnessId: ''`), declared `unsupported` (harness id present),
directory never created (empty, no diagnostic), directory unreadable
(`reason: 'unreadable'` naming the path), config file that will not parse
(`reason: 'malformed'`). `CapabilityDiagnostic.capability` separates the halves
so one fault cannot blank the other, and `watch_unavailable` marks
stale-but-correct without claiming a read failure.

**7. The existing consumers converged — PASS, after one fix.**
`SkillPickerPopover` resolves through `agentCapabilities` whenever a CLI is
known, and falls back to the workspace-wide inventory only where no single CLI
applies (a conversation provider, an automation installing into a per-run
worktree) — that fallback is documented in the file. One call site with a CLI in
hand was not passing it; fixed (finding 1).

## The plan's own claims

- **`SKILL_PACK_HARNESSES` is no longer the source of truth — holds, partly.**
  It is gone from the capability read path and the attach path, both of which
  derive their own map. It remains the source of truth for the workspace-wide
  inventory and the built-in installer (finding 3).
- **`agent-config-import.ts` migrated or explicitly marked — now marked.** It is
  *partly* migrated: its format parsing moved onto the shared adapters, so it and
  the capability query cannot disagree about what a config file says; its
  *sources* are still the literal `codex` / `claude-code` pair. That status, and
  why the remainder is blocked on the manifests rather than on the file, is now
  stated at `sourceConfigs` in `src/main/agent-config-import.ts` (finding 2).

## Findings

**1 — `AgentComposerPopover` did not scope its skill list to the CLI it
launches. Fixed.** The popover-density sibling of the agent composer offers the
same "+ Skill" affordance, in spawn mode only, where `composer.selectionCli` is
the CLI that will actually run — and it was passing no `pluginId`, so it showed
the whole-workspace inventory while the panel-density sibling showed what that
agent can reach. Exactly the divergence decision 7 exists to prevent. Fixed by
passing `pluginId={composer.selectionCli}`
(`src/renderer/src/components/workspace/agentComposer/AgentComposerPopover.tsx`).

**2 — `agent-config-import.ts`'s status was undocumented. Fixed.** The file
shared the adapters without stating why its hardcoded pair remained, leaving the
next reader to conclude the migration had been missed. Now stated in place,
including the real blocker: only `codex` and `opencode` declare an
`mcpConfig.userPath`, so there is nothing for the manifest-driven path to resolve
for the rest.

**3 — User-scope MCP servers are invisible for the five claude-format CLIs.
Open; owner architect, then developer.** `claude-code`, `grok`, `kimi-claude`,
`zai` and `cursor` declare `mcpConfig.path` and no `userPath`, so the read path
lists workspace servers only. A user with servers in a user-scope Claude Code
config sees a shorter list than the CLI actually reaches, and no diagnostic says
so — the resolver is faithfully reading everything it was told about, which makes
this a manifest gap, not a resolver bug. It matters because it is the one way the
pane can be quietly incomplete while reporting no fault. The fix is a manifest
change, but it needs a decision first: the import wizard reads three candidate
Claude Code paths (`~/.claude/.mcp.json`, `~/.claude/mcp.json`, `~/.claude.json`)
and which is authoritative has not been established. Verify by adding `userPath`
to one manifest, writing a server into that file, and confirming it appears with
`scope: 'user'` and is overridden by a workspace entry of the same id; confirm
`syncClaude` is unaffected — it resolves `'workspace'` unconditionally, so the
write path does not change.

**4 — A server the config marks disabled renders identically to a live one.
Open; owner developer.** All three adapters parse `enabled`
(`claude-code.ts:39`, `codex.ts:37`, `opencode.ts:22`) and `resolveTarget` drops
it when building `AgentMcpServer`. Listing a disabled server is right — dropping
it would hide something the user wrote — but presenting it as reachable is the
same class of untruth decision 6 forbids: the user sees the server, asks the
agent to use it, and it is not there. The epic's payload sketch did not include
the field, so this is a gap in the sketch rather than a departure from it. Fix:
carry `enabled: boolean` on `AgentMcpServer` and mark it in the pane (T8).

## Fixed in passing: six suites were failing on this branch

Not a T1–T4 finding — it belongs to T6's rail work — but `verify:app` was red and
this review is where it surfaced. `modelRegistry.ts`'s new `RAILS` table reads
`DockLocation.LEFT` at **module scope**; every previous use was inside a
function. The test stub `scripts/testing/stubs/flexlayout-react.cjs` exposed its
symbols only through a Proxy `get` trap, and esbuild's `__toESM` namespace copies
own enumerable keys — so `DockLocation` arrived as `undefined` and six suites
crashed at load, before any assertion:
`automation-report-viewer`, `automation-run-actions`, `all-projects-backlog`,
`bundled-ids`, `backlog-door-actions`, `seams:skill-sources`. Fixed by giving the
stub real own properties (and `DockLocation` its real member names). All six pass
again. The product code is correct as written; the stub was under-specified.

## Residual risk

- The workspace-wide inventory (`listWorkspaceSkills`) still walks
  `SKILL_PACK_HARNESSES`, so a thirteenth CLI's skills do not appear there. Its
  `harnesses: SkillHarness[]` field is a closed union that a manifest-declared
  harness id cannot join, so migrating it is a typed change across the renderer,
  not a swap of the iteration source. Out of scope here; the epic's acceptance
  is about the pane and the picker, both of which resolve through the service.
- Restart truth remains partly unverified per plan decision D6: several manifests
  carry `restartRequired: true` with a `$comment` saying the probe could not run.
  Conservative and recoverable, but it means the pane's restart banner is not yet
  evidence-backed for every CLI.
- The pane itself (T8) does not exist yet, so decisions 5 and 6 are verified at
  the contract and payload level, not through a rendered surface. T11 covers it.
