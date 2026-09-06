---
name: studio-automations
description: List, create, run and inspect SprintEngine Studio Automations, and read the capability modules and marketplace behind them. Use when asked to set up or fire a scheduled or triggered automation, to check why an automation did or did not run, to read an automation's run history, to find out whether a capability module is enabled, or to browse the extension marketplace the app itself reads.
---

# Automations

An Automation is a trigger plus an action, stored per workspace in
`.multi-code/automations`. Every one of these tools is keyed by `workspaceId` —
get it from `workspace_list` first. Studio's automation surface runs in the main
process, so a run works with no app window open.

## Read before you write

`automation_list` returns a workspace's definitions. `automation_runs` takes
`{workspaceId, automationId}` and returns that automation's history, newest
first; the store keeps the most recent fifty. Both are read-only, and both are
the honest answer to "did it fire?" — a definition that exists is not a run that
happened.

When an automation did not do what was expected, read its run history before
changing its definition. A run record says whether the trigger fired, and a
missing record and a failed record are different problems.

## Create

`automation_create` takes `{workspaceId, definition}` and goes through the same
validated pipeline the app's own UI writes through: provider and permission
checks, schedule validation, workspace-root trust. The definition carries
`name`, `trigger` (`{kind, config}`), `action` (`{kind, config}`) and an
optional `status`. Read the tool's schema for the trigger and action kinds this
build actually holds rather than assuming a vocabulary.

An agent-backed action must name `permissionPreset`, and on this surface the
answer is almost always `auto`. The vocabulary is `none`, `manual`, `auto`,
`bypass`. Naming none at all resolves to `bypass`, which this surface refuses
outright — that preset can only be set by a person, inside the app, and its
pre-rename spelling `bypass_all` is refused with it. If an automation genuinely
needs bypass, say so and let the user set it; do not work around the refusal.

`manual` is accepted here but is rarely what you want: an automation agent has
nobody at its terminal, so it stops at the first approval prompt and hangs the
run until the idle reaper fails it. `default` is the pre-rename spelling of
`manual` and carries the same problem — old definitions still using it are
honoured, but do not write it into a new one.

## Run

`automation_run` with `{workspaceId, automationId}` fires an existing
schedule-triggered automation now — the same "Run now" the panel offers. The run
record is confirmed in the store before the call succeeds, so a success here
means a run exists, not merely that a request was accepted. Agent-backed actions
launch in the main process.

Only schedule-triggered automations can be fired this way. An automation whose
trigger is an event is fired by that event.

## What is available to automate

`cli_runtime_list` is the list of agent CLIs this app can launch, with each
one's model ids and reasoning-effort levels. Read it before naming a `cli` or
`cliModel` anywhere — those are otherwise blind strings. Only rows with
`agentSelectable: true` may be launched; a false row is registry-held for
install and detection only, and every launch door refuses it. A row whose
`allowCustomModelId` is true accepts model ids outside its listed options, which
are a seed rather than a closed set. This reports what the registry holds, not
what is installed on this machine — it never probes for binaries.

`module_list` reports the capability modules this app has, as the user sees
them: bundled and third-party, each with its source, version, whether it is
enabled, and why it is not when it is off. A module that ships only in
development builds is absent from a packaged build entirely, never reported as
present-but-disabled. A third-party module that is installed but untrusted
appears as installed even though it loads nowhere.

`module_status` with `{id}` reads one module: its manifest, the permissions it
declares, the surfaces it contributes, the gateway tools it adds, and — when it
is not active — why. This is the tool that answers "why is that tool missing":
a `<moduleId>_module_disabled` refusal anywhere on this gateway is a module to
look up here.

Enabling, installing and trusting are **not** on this surface. They are trust
decisions and belong to a person in the app. Report what is off and why; do not
try to turn it on.

`marketplace_list` browses the extension index the app itself reads — modules,
MCP servers, skill packs, agent CLIs and automations — through the same registry
client, cache and bundled-first policy as the Plugins catalogue. Filter with
`provides` for the module-first facet, `query` to search, `forceRefresh` to skip
the cache. The result discloses where the index came from and whether it is a
stale offline cache; say which when you quote it, because an offline answer can
be out of date and is still the only honest one available.
