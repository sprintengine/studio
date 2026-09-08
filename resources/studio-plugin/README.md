# The SprintEngine Studio marketplace

This directory is a Claude-format **marketplace**. Its first plugin is what the
app installs into every workspace it opens; the rest are published for people to
install from the catalogue.

```
resources/studio-plugin/
  .claude-plugin/marketplace.json     the marketplace manifest
  sprintengine-studio/
    .claude-plugin/plugin.json        name, description, version
    .mcp.json                         the stdio bridge to the running app
    hooks/hooks.json                  the agent-state reporter
    skills/studio-*/SKILL.md          one skill per area
  studio-skills/
    skills/*/SKILL.md                 the workflow skills the app ships
  brave-search/ kubernetes/ snyk/
    .claude-plugin/plugin.json        name, description, version
    .mcp.json                         somebody else's server, and its env NAMES
    skills/use-*/SKILL.md             the skill that teaches that server
```

Installer: `src/main/skills/studio-plugin.ts` (what it writes) and
`src/main/studio-plugin-service.ts` (when).

## What is here is a template

Three things in this tree cannot be known until the app is running on a
particular machine: the binary that will run the bridge, the absolute path of
that bridge inside this app bundle, and the live agent-state socket. They appear
here as tokens — `__MULTICODE_NODE__`, `__MULTICODE_BRIDGE__`,
`__MULTICODE_USER_DATA_DIR__`, `__MULTICODE_AGENT_STATE_REPORTER__`,
`__MULTICODE_AGENT_STATE_SOCKET__` — and install materialises the whole
marketplace into `<workspace>/.multicode/studio-plugin` with each one replaced.
A test walks every materialised file and fails if a token survives.

## Where the bridge comes from

The item offered two ways to give the plugin its MCP server: **ship the bridge
inside the plugin**, or **rewrite the command at install** to the app's bundled
`resources/automation/mcp-stdio-bridge.mjs`, the way the agent-state hook
installer already rewrites its own absolute script path.

**We rewrite at install.** Three reasons:

1. **The bridge must belong to the running build.** It speaks that build's
   discovery file (`sprintengine-studio-mcp-info.json`), its connect frame, and
   its tailnet protocol constants, which the file itself says are kept in step
   with `src/main/automation/tailnet/tailnet-gateway-server.ts`. A copy inside
   the plugin would be a second 725-line file to keep in step with the first,
   and the failure mode of letting them drift is an agent that cannot reach the
   app at all.
2. **One resolver already exists.** `resolveStudioMcpBridgeScriptPath` in
   `src/main/app-services.ts` resolves the packaged and the development layout,
   and `syncManagedSprintEngineMcpConfig` already writes exactly this command
   into every CLI's own config. The plugin's `.mcp.json` now names the same
   path from the same resolver, so the two cannot disagree.
3. **`${CLAUDE_PLUGIN_ROOT}` cannot reach it.** That variable expands to the
   plugin's own directory, and the bridge is not in it. Shipping the bridge into
   the plugin purely so the variable could be used would be paying reason 1's
   price to avoid a substitution we already perform for the hook.

The same reasoning is why the hook command is rewritten rather than made
plugin-relative: the reporter's `--socket` argument is a per-profile path this
app run owns, and no path variable can stand for it.

## Native Claude Code enablement is wired, and off

Install writes both keys Claude Code documents for team-shared plugins:
`enabledPlugins` into `.claude/settings.json` (a project normally commits it,
and it names a plugin rather than a path, so it means the same thing on every
machine) and `extraKnownMarketplaces` into `.claude/settings.local.json` (which
is gitignored, because a directory marketplace's source is this machine's
absolute path).

Those two keys are **not enough on their own**. Measured against Claude Code
2.1.261 on 2026-09-06:

| `known_marketplaces.json` | workspace `extraKnownMarketplaces` | workspace `enabledPlugins` | plugin loads |
| --- | --- | --- | --- |
| absent | present (directory source) | present | **no** — no skills, no MCP server, no hooks |
| present | absent | present | **yes** — skills, MCP server and hooks all load |

So native loading needs the marketplace to be in Claude Code's own user-global
`~/.claude/plugins/known_marketplaces.json`, which `claude plugin marketplace
add` writes. This app will not write another product's user-global state behind
a person's back, so native enablement waits for a marketplace Claude Code
fetches for itself — the GitHub marketplace child of this epic.

Until then `STUDIO_PLUGIN_NATIVE_CLAUDE_ENABLEMENT` in
`src/main/skills/studio-plugin.ts` is `false` and the app delivers the same
three things itself: the skills are copied into every harness's skill directory,
the MCP server is written into each CLI's config by
`syncManagedSprintEngineMcpConfig`, and the hook is merged into
`.claude/settings.local.json` from the command and event set this plugin's own
`hooks/hooks.json` declares.

**When that flag goes true, the by-hand hook merge must stop** — Claude Code
would then register the plugin's hooks itself, and two registrations spawn the
reporter twice for every event. `installStudioPlugin` already skips the merge on
the flag; the flag is the whole change.

## The skills

One per area, as the item asks: `studio-sprints`, `studio-backlog`,
`studio-automations`, `studio-workspaces`, `studio-review`. Each is written to
the Agent Skills specification — `name` equal to its directory, a `description`
under 1024 characters that says **when** to use it, a body under 500 lines — and
`src/main/skills/studio-plugin-skills.test.ts` checks all three against the same
frontmatter parser the app's own skill reader uses.

They are distilled from `sprintengine_help`'s five topics, the tool descriptions
in `src/main/automation/automation-tools.ts` and the sprint-engine tool
schemas, and the review gateway tools. `sprintengine_help` stays — an agent that
arrives without the plugin still has it — but the skills are the manual: they
cost nothing until invoked and carry the workflow, not just the tool list.

They deliberately do **not** restate tool schemas. `tools/list` is the listing
surface and every parameter description is authoritative; a skill that copied
them would be a second copy to keep in step.

## The MCP servers we ship as plugins

`src/main/skills/studio-server-plugins.test.ts` holds this section to its word.

Every server here is a plugin: `.claude-plugin/plugin.json`, a `.mcp.json`
carrying the server's command or URL and the NAMES of the variables it reads,
and at least one skill that says when to reach for it and how. **A server
without a skill is not listed** — an agent that has to learn a server from its
tool descriptions is the thing this epic exists to stop, and a manual that is
wrong is worse than no manual at all.

Three rules, and each one has already caught something:

- **We do not list a server Anthropic's marketplace already carries.** The
  Anthropic tab is its home, and the same product under two tabs is a duplicate
  row. Measured against `anthropics/claude-plugins-official` at its head on
  2026-09-06: it lists 291 plugins, and they cover 39 of the 58 servers in
  `resources/mcps/catalog.json` plus three of the four signed MCP bundles.
  **Railway is one of them** — `railwayapp/railway-skills` ships a `railway`
  plugin whose `.mcp.json` is the same remote server and whose
  `skills/use-railway/` is a larger version of ours, with references and
  scripts. The item named Railway as the obvious first conversion; the rule
  that excludes GitHub and Playwright excludes it too.
- **A server keeps the id the connector catalogue already gave it.** The New
  chat door lists installed servers first and the catalogue's rest after, keyed
  by id, so a plugin that renamed its server would draw the same product twice.
  That is why the key in `snyk/.mcp.json` is `io-snyk-mcp` and not `snyk`:
  `src/renderer/src/utils/mcpDisplayName.ts` already turns those registry ids
  into product names on screen.
- **A `.mcp.json` names variables, never values.** `${BRAVE_API_KEY}` is both
  the ecosystem's spelling (`external_plugins/context7/.mcp.json` in the
  official repository does the same) and the only form the scanner reads an env
  var name out of. This tree is published to a public repository.

Writing a skill against the tool descriptions is how the first five skills
acquired three claims that made real calls fail (commit `a3fc7183`). So each
one here is written against the server's own published tool list, and that pass
found `resources/mcps/catalog.json` launching Snyk as `npx snyk` — the
interactive CLI, which never speaks MCP. This plugin runs
`npx -y snyk@latest mcp -t stdio`.
