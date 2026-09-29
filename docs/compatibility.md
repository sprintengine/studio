# Wire compatibility

Studio talks to software it does not ship with: another Studio on your tailnet,
and the phone app. Both ends update on their own schedule, so neither can assume
the other is the same build. This file is the policy for what that obliges you
to do when you change something that crosses the gap.

It is short on purpose. The one thing it must get across: **a wire format is not
a private data structure, and changing one is not a local edit.**

## What is versioned

| Wire                                                                              | Version                                  | Window                                               | Declared in                                     |
| --------------------------------------------------------------------------------- | ---------------------------------------- | ---------------------------------------------------- | ----------------------------------------------- |
| Tailnet transport — Studio driving another Studio                                 | `TAILNET_TRANSPORT_VERSION` (integer)    | `TAILNET_MIN_SUPPORTED_TRANSPORT_VERSION` .. current | `src/main/automation/tailnet/tailnet-routes.ts` |
| Mobile control — the phone reading and driving a desktop over the tailnet gateway | `mobileControlProtocolVersion` (integer) | `mobileControlSupportedProtocolVersions`             | `src/main/mobile/control/protocol.ts`           |
| MCP                                                                               | dated strings, newest first              | every entry in the list                              | `src/shared/mcp/protocol.ts`                    |

One more version number is near these and is **not** a wire window: the
backlog item schema version is a file format, and is not negotiated with a peer.
(`mobileControlWorkspaceSnapshotVersion` was a second; it versioned the mobile
snapshot's `workspaces` detail body and left the wire with it in v4.)

Alongside the tailnet version is `TAILNET_CAPABILITIES` — a list of named,
additive features. It is not a version and does not follow one; see
"Capabilities, not version arithmetic" below.

## The support window

Both integer wires accept **one version of slack**: the current version and the
one before it. Anything outside is refused at the handshake, by a named error
that says both what was seen and what is supported.

- Tailnet: `checkTailnetTransportVersion` in `tailnet-routes.ts`, applied in
  `readRemoteIdentity` (`tailnet-remote-client.ts`). A machine outside the window
  is reported unreachable with the reason, and shown as such in the Remote panel.
- Mobile: `isSupportedMobileControlProtocolVersion`, and the
  `unsupported_protocol_version` error code. Enforced on inbound commands
  (`command-validation.ts`, behind `workspace.mobile_command`). The snapshot the
  desktop sends is stamped with the current version, and the phone reads it at
  that version only. The phone pairs through the tailnet gateway's own pairing,
  which is versioned by the tailnet transport, not by this integer.

One version, and not more, because the second version back is one this tree no
longer has to be able to produce, and a window wider than the shapes anyone
tests is a promise that quietly stops being true.

The window is also why the **refusal must name both numbers**. "Unsupported
protocol version" alone cannot tell someone which of their two installs to
update, which makes it a support thread instead of a fix.

## Capabilities, not version arithmetic

Where the question is "can this peer do X", ask the capability list, not the
version integer. A capability list is what the peer says about itself now; a
version is a proxy for it that goes stale in three ways — a feature can be
back-ported to an older version, withdrawn by a build that keeps the version, or
shipped behind a setting.

The tailnet transport advertises `capabilities` on `health`, on the pairing
response and on `identity`; `tailnetPeerSupports` is the accessor. A peer that
advertises no list has no capabilities, not all of them — but note that a peer
which published **no list** (null) is a different fact from one that published an
**empty list**, and only the second is a denial. The capability list shipped a
day after the first feature it describes, so silence there means "unknown".

This is what lets the version window stay narrow while the wire keeps growing: a
**purely additive** feature ships as a capability with no version bump at all, so
no peer is refused over it.

Bump the version instead when the change is not additive: a field that changes
meaning or type, a field that is removed, a response whose shape a peer is
already parsing. Nothing a capability flag can describe should bump the version,
and nothing a capability flag cannot describe should ship without one.

## The mobile wire lives in this tree

The mobile-control shapes — the snapshot the phone reads and the commands it
sends — are declared in `src/main/mobile/control/protocol.ts`, next to the
snapshot builder and command service that are their only producers here. They
used to ship as the `@sprintengine/mobile-control-protocol` package, when the
same wire also ran through a hosted relay; the relay was removed on 2026-09-27
(owner ruling) and the package with it. Its published `4.x` versions stay on
npm, and wire version 4 is what this tree still speaks, unchanged.

The phone app keeps its own copy of these types. Nothing compares the two
automatically any more, so a change that crosses the wire is made on both sides
in the same coordinated change, and the version integer is still the only thing
a peer sees.

### Direct conversation lane

`@sprintengine/conversation-protocol` is a separate portable package for the
additive `conversations` tailnet capability. It owns the direct conversation
WebSocket frames, their client validator and pure tool-presentation helpers.
It does not change the mobile-control wire or its version number.

The initial `0.1.0` contract requires the `conversations` capability. Additive
optional fields preserve that contract. Model switching is one such addition: its own
`conversation-models` capability, a `models` catalog on a listed thread, the
`setModel` command, the `unsupported_model` code and a `notice` on an accepted
command. A client hides its model control for a desktop that does not
advertise it, and such a desktop refuses the command as `unsupported_command`.
The pictures a chat's steps show are another: the `conversation-images`
capability names a plain `GET /tailnet/v1/conversation-image` beside the socket
rather than a frame, so it changes neither the frame contract nor this package.
A client that does not see it says the picture is on the other machine, and an
older desktop answers the route 404. Breaking frame changes require a new
negotiated capability or the tailnet version-window process above, not merely
a package version change. Presentation-only fixes use a package patch.
Both ESM and CommonJS tarball consumers and Node16 declarations are checked by
`npm run test:conversation-protocol:pack` as part of `verify:app`.

Until a published version is adopted, the phone carries the same portable source
files with a shared SHA-256 pin. A wire or presentation edit must update both
copies and both pins in companion changes; passing one repo's local hash check
alone does not prove the two peers agree. Publishing is a separate release step.

## Changing a wire format

If your change alters anything that crosses either wire, do all of this:

1. **Decide which it is.** Additive → a new entry in `TAILNET_CAPABILITIES` (or,
   for the phone, a new command in the snapshot's advertised `commands`, which
   the phone reads as plain strings), no version bump. Otherwise → a version bump.
2. **If you bump**, move the current version and the minimum together so the
   window stays one version wide, and leave the code that reads the previous
   shape in place for that one release. A bump that also drops the old reader
   refuses every peer that has not updated yet, which is what the window exists
   to prevent.
3. **Check every enforcement site.** They must agree, or a peer is accepted by
   one and refused by another. Today:
   `git grep -n 'protocolVersion' -- src | grep -v test` and
   `git grep -n 'transportVersion' -- src`. Note that the sites include the
   validators for records read back off **this machine's own disk** — a check
   pinned to the current version alone unpairs every device paired before the
   bump, silently, on the first restart after it.
4. **Test the edge, not the middle.** A peer inside the window is accepted, one
   outside it is refused, and the refusal names both versions. The existing
   examples are in `src/main/automation/tailnet-peers.test.ts`,
   `src/main/automation/tailnet-mesh-reachability.test.ts`,
   `src/main/mobile/control/command-validation.test.ts` and
   `src/main/mobile/control/protocol.test.ts`.
5. **Make the same edit on the phone.** The phone carries its own copy of the
   mobile-control types (see "The mobile wire lives in this tree" above), so a
   desktop-only change to a shape the phone parses is half a change. The window
   is the grace period a bump needs, not permission to skip the other side.
6. **Update this file**, if what you changed is the policy rather than an
   instance of it.

## Bumps that have happened

### 4 — the members nothing produces leave the wire (2026-09-16)

**Breaking, deliberately, and for the same reason as 3.** Taking the Sprint Engine
off the wire left members no desktop could produce: the `workspaces` collection
(always `[]`, with its `switchboard` / `watchtower` kinds, nine workspace
capabilities, detail shapes and the `desktopWorkspaces` snapshot collection), the
`roadmaps` rider, the always-`undefined` `statePath`, and the `python_tool_failed`
error code. All of it is deleted. `mobileControlProtocolVersion` moved 3 -> 4 and
the window moved with it, to `[3, 4]`. The package published `4.0.0`.

Removing `desktopWorkspaces` from the collection list is what makes this a bump
rather than a quiet tidy: a v3 phone that asked for it would now be refused with
`invalid_payload`.

As with 3, pre-release: no users and no paired devices. The phone's mirror moved
in the same coordinated change, with both sha256 pins set to the same new hash.
Step 2's one-release grace reader was skipped for the same reason as in 3; the
window is still one version wide and still enforced, and nothing reads v3.

The phone's project list and switcher were built from `workspaces` joined with
`backlog`. With `workspaces` always empty they were already built from `backlog`
alone, so the phone's projects are unchanged; only the dead join went.

The member-by-member list was in the protocol package's `CHANGELOG.md`, removed
with the package; `git show 84500b7f2:packages/mobile-control-protocol/CHANGELOG.md`
still has it.

### 3 — the Sprint Engine leaves the wire (2026-09-16)

**Breaking, and deliberately so.** `sprintEngines` was a required member of the
snapshot; the nine sprint commands, the eight sprint capabilities, their relay
scopes, the role catalogue and the `sprintengine` workspace kind were all wire
vocabulary. All of it is deleted. `mobileControlProtocolVersion` moved 2 -> 3 and
the window moved with it, to `[2, 3]`. The package published `3.0.0`.

**Why it could not be additive.** The Sprint Engine moved out of the
desktop into a signed module, and the desktop stopped being able to serve any of
it. It kept emitting `sprintEngines: []` anyway, and the phone kept demanding
the key, because removing a required member is not additive: a desktop that
dropped it while the phone still required it would fail EVERY snapshot read on
the phone with `invalid_payload`, taking backlog and automations down with the
runs. Emitting an empty array forever was the right answer while a paired phone
existed. It also meant the wire carried a large vocabulary — a whole run type
tree, nine commands, eight capabilities — that nothing on either side could
produce or act on.

**What made it possible.** Pre-release: no users, no published consumers, no
paired devices to protect. Both halves — this package and the phone's mirror of
it — moved in one coordinated change, with both sha256 pins set to the new shared
hash in that same change.

**Where this departs from step 2 below.** Step 2 says a bump leaves the code that
reads the previous shape in place for one release, so the window is a grace
period rather than an outage. That was skipped on purpose here: there is no
deployed peer to grant grace to, and a retained v2 reader would have been a copy
of exactly the vocabulary the change exists to delete. The window itself is still
one version wide and still enforced; nothing reads v2.

The member-by-member list was in the protocol package's `CHANGELOG.md`, removed
with the package; `git show 84500b7f2:packages/mobile-control-protocol/CHANGELOG.md`
still has it.

## Withdrawals that did not bump

### Terminals leave the tailnet (2026-09-29)

**Not a bump, and the tailnet transport stays at 2.** Owner ruling: nothing
about a terminal crosses the tailnet any more; what a paired device reads,
drives and starts is a conversation. Everything that went is one of the shapes
this file already says a peer must tolerate, so no peer on version 1 or 2 is
refused over it:

- **Two capabilities withdrawn**, `sliced-frames` and `terminal-resume`. Both
  described the terminal stream. A capability is what a peer asks before relying
  on a feature, and a build that stops advertising one is read as not having it
  — the case "withdrawn by a build that keeps the version" above.
- **The route**, `/tailnet/v1/terminal`. An upgrade there is answered 404, which
  is what a peer from before the route existed answered.
- **Five tools off the tailnet**, `terminal.list`, `terminal.create`,
  `agent.launch`, `backlog.work` and `automation.run`. All five still exist and
  are served on the local socket, to the agents and MCP clients on this machine;
  a paired device's `tools/list` no longer names them, and a call to one is
  refused as `tailnet_local_only`, the refusal the `tailnet.*` family already
  had. `tools/list` is read on every connection and never pinned, so a shorter
  list is a shape every peer already reads.
- **A change-feed kind**, `terminals`. No `changed` frame names it, and the
  `hello` frame's `revisions` map no longer has its key. That map is keyed by
  the lists this machine announces and has grown a key before (`conversations`)
  without a bump; a key a build does not announce is absent, the same as it was
  before the key existed.
- **Two scopes**, `terminal:observe` and `terminal:control`, retired the way the
  Horizon scopes were: `normalizeTailnetScopes` drops a scope outside the
  vocabulary, so a device stored with them loads with the rest of its grant, a
  pair request naming them is read without them, and a peer reading a grant
  list sees a shorter list, which a grant list always could be.
- **The upload route** keeps its path, its `upload` capability and its
  conversation shape. Its terminal branch — a file written into a session's
  folder — is gone, and the `kind=conversation` older phones send is accepted
  and no longer needed.

The phone's side of this is its own change: it stops asking for terminals.
Nothing in `src/main/mobile/control/protocol.ts` changed, so the mobile-control
version stays at 4.

### Automations leave the phone (2026-09-29)

**Not a bump, and the mobile-control version stays at 4, window `[3, 4]`.**
Owner ruling: the phone does not show or drive automations any more. What
left `src/main/mobile/control/protocol.ts`:

- **The snapshot member** `automations`, with its types
  (`MobileControlAutomationSnapshot`, `MobileControlAutomationRunSummary`,
  `MobileControlAutomationRunStatus`) and the producer's caps
  (`automationsPerProjectMax`, `automationRecentRunsMax`,
  `automationRunTextMaxChars`). The member was optional and already absent
  whenever a desktop had no automations to show, so a snapshot without it is
  one every v3 and v4 phone reads. That is why this is not the case "a field
  that is removed" in the bump rule above: nothing about whether it may be
  absent changed.
- **The collection** `automations` from `mobileSnapshotCollections`. This is
  the part that would have been a bump — it is what made v4 one — because
  phones built before this ask for `['backlog', 'automations']` on every read,
  and `workspace.snapshot` refuses a name it does not know. So the name is kept
  as a retired collection (`retiredMobileSnapshotCollections`): accepted in
  `include`, and answered with nothing, the way the upload route still accepts
  the `kind` older phones send.
- **The command** `automations.control`, with `AutomationsControlCommand`,
  `MobileControlAutomationAction` and the `task_not_ready` error code only it
  produced. A command is advertised in the snapshot's `commands` strings, and
  the tailnet never advertised this one: the gateway's `workspace.mobile_command`
  allowlist is `backlog.update` alone, so since the hosted relay went
  (2026-09-27) no transport served it. A phone that sends it is refused
  `command_not_supported` by the gateway, as before.

The phone's mirror drops the same members in its own companion change. On the
desktop, automations are unchanged, and `automation.run` stays a local-socket
tool.

## What never changes without a bump

- The meaning of an existing field.
- The type of an existing field.
- Whether an existing field may be absent.
- The shape of anything under `health` on the tailnet transport, which is read by
  peers that have never paired with us and may be several releases behind.
