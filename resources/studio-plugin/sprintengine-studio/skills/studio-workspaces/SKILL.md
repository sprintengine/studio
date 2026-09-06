---
name: studio-workspaces
description: Read and drive SprintEngine Studio's workspaces, agents, terminals, git checkouts and the workspace browser pane through the workspace_*, agent_*, terminal_* and browser_* tools. Use when asked what workspaces or agents exist, to open a workspace or launch an agent, to start or attach to a terminal on this machine, to inspect a workspace's branches and worktrees, to drive or screenshot the in-app browser, or to check the mobile companion snapshot or tailnet pairing.
---

# Workspaces and terminals

Everything here reads or writes the running app's own state through its main
process, so it works with no window open: a workspace created this way is
immediately addressable, and a terminal created this way appears as a painted
pane when a window opens later.

**Start with `workspace_list`.** Almost every other tool on this surface takes a
`workspaceId`, and this is where ids come from. It lists the workspaces visible
to the user, with window assignment and agent ids. Workspaces that survived a
restart are listed like any other — main owns the registry, so their name,
folder, mode and agents are real whether or not a window is open.

`workspace_status` with `{workspaceId}` reads one workspace including its agents
and their terminal liveness. `agent_status` with `{workspaceId, agentId}` reads
one agent's launch state plus its terminal session liveness — the two halves are
separate, and an agent recorded as launched whose session is gone is a real and
reportable state.

## Creating and opening

`workspace_create` takes `name`, `folderPath` and `templateId`, all optional,
and creates the workspace in the running app. `workspace_checkout` with
`{workspaceId}` reads the git side: whether the folder is a repository, the
branch it is on, the trunk, every local branch, and the worktrees the repository
holds. Read it before launching an agent on a worktree, because
`agent_launch`'s `worktree.baseRef` has to name a branch that exists.

## Launching agents and terminals

`agent_launch` with `{workspaceId}` adds a fully configured agent and starts its
CLI through the same renderer flow the UI uses. It can select the model,
permission preset, specialist and connector, and can isolate the agent in a git
worktree. Success is confirmed by the agent's terminal session registering with
the main process — a call that returns success has a live session behind it.

`terminal_create` starts an AGENT terminal on this machine and returns a session
id ready to attach — it launches a CLI under a permission preset through the
same path `agent_launch` uses, and `terminal_list`'s `kind` filter counts it as
`agent`, not as a plain shell. There is no tool here that opens a bare shell.
Name the workspace by `workspaceId` or by `workspaceName`. The CLI and
permission preset default to this machine's own launch settings unless you name
them; when you do name one it must be `manual` or `auto`. `bypass` is refused
here as everywhere on this surface, and so is its old spelling `bypass_all`; if
a task genuinely needs it, say so and let a person set it in the app.

`terminal_list` lists open sessions — session id, agent name, CLI, working
directory, workspace, whether the process is live or the session is paused, and
the agent phase when the CLI reports one. It reads the terminal runtime and
never writes.

Read `cli_runtime_list` before naming any `cli` or `cliModel`. Only rows with
`agentSelectable: true` can be launched as agents.

## The browser pane

`browser_open` with a `url` puts a page in the workspace's browser pane;
`browser_navigate`, `browser_press`, `browser_scroll`, `browser_resize` and
`browser_set_appearance` move it. `browser_status` says what is loaded.

**Take a `browser_snapshot` after every navigation or change.** It renders the
page as an outline of roles and names with `[ref=eN]` handles, which are what
`browser_click`, `browser_hover` and `browser_type` address. It is cheaper and
far more precise than a screenshot, and it is read-only. Reach for
`browser_screenshot` when a human needs to see the pixels, not when you need to
find an element.

`browser_console` and `browser_network` read what the page logged and requested;
`browser_actions` reports what has been driven. `browser_evaluate` runs an
expression in the page — use it when the DOM holds an answer the snapshot does
not, not as a substitute for clicking.

## The mobile companion and the tailnet

`workspace_snapshot` is the companion document: sprint engines, backlog,
automations and workspaces as one versioned read, in the same path-token form
the relay serves — `ws_` tokens round-trip and local paths never leave the
desktop. Pass `knownSnapshotVersion` from your previous read to get an
`{unchanged: true}` marker instead of the whole document when nothing moved; a
polling loop that ignores this is re-sending the same document every time.

`workspace_mobile_command` dispatches one mobile-control command envelope over
this transport instead of the relay. The device identity comes from the
transport, never from the arguments — do not try to name a device in the
payload.

The `tailnet_*` tools are served **only over the local socket** and are
unreachable from a remote client, by design. `tailnet_status` and
`tailnet_list_peers` read; `tailnet_set_enabled`, `tailnet_revoke_device`,
`tailnet_approve_pair_request` and `tailnet_deny_pair_request` change pairing
state. `tailnet_offer_pairing` returns the pairing code and the
`multicode-tailnet://` URL **once** — neither is re-readable afterwards, and
`tailnet_status` never returns them — so deliver them to the person who asked in
the same reply or they are lost. A lost code is recovered by offering again,
which replaces the outstanding offer rather than needing a cancel first; that
also invalidates one a person may be part-way through redeeming, so say that you
are replacing it. The code does not survive an app restart.

## Reaching this surface without the app running

These tools live in the running app. The stdio bridge finds it through a
discovery file in the app's user-data directory
(`sprintengine-studio-mcp-info.json`), which the app writes at start and removes
on quit. If a call fails because the app is not running, that is the honest
answer: say so rather than retrying. A "stale discovery file" message means the
app crashed and must be restarted before this surface exists again.
