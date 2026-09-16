# Wire compatibility

Studio talks to software it does not ship with: another Studio on your tailnet,
and the phone app. Both ends update on their own schedule, so neither can assume
the other is the same build. This file is the policy for what that obliges you
to do when you change something that crosses the gap.

It is short on purpose. The one thing it must get across: **a wire format is not
a private data structure, and changing one is not a local edit.**

## What is versioned

| Wire | Version | Window | Declared in |
|---|---|---|---|
| Tailnet transport — Studio driving another Studio | `TAILNET_TRANSPORT_VERSION` (integer) | `TAILNET_MIN_SUPPORTED_TRANSPORT_VERSION` .. current | `src/main/automation/tailnet/tailnet-routes.ts` |
| Mobile control — the phone driving a desktop | `mobileControlProtocolVersion` (integer) | `mobileControlSupportedProtocolVersions` | `packages/mobile-control-protocol/src/index.ts` |
| MCP | dated strings, newest first | every entry in the list | `src/shared/mcp/protocol.ts` |

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
  `unsupported_protocol_version` error code. Enforced on inbound commands, on the
  relay pairing payload, on the pairing link, and on the device records read back
  off disk.

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

## The wire version and the npm version

The mobile protocol is the one wire that ships as a package —
`@sprintengine/mobile-control-protocol`, built from
`packages/mobile-control-protocol` — so it has two numbers where the others have
one: `mobileControlProtocolVersion`, the integer on the wire, and the package's
npm semver.

**The npm major is the wire version.** `mobileControlProtocolVersion` is 4, so
the package is `4.x.y`. Bumping the wire to 5 means publishing `5.0.0`.

This is not a naming convention dressed up as policy. A wire bump changes which
peers are refused at the handshake — the one thing every consumer of this package
depends on — so semver's major is already the correct number for it, and pinning
the two together means a dependency line states the wire version a build speaks
without anyone opening the file. `scripts/verify-mobile-protocol-pack.mjs` fails
the build if they disagree.

| Change | What moves |
|---|---|
| A wire version bump — step 1 below says you need one | major, in lockstep with `mobileControlProtocolVersion` |
| Additive: a new capability, command, event or optional field | minor |
| A validator fix, or a comment, that changes nothing crossing the wire | patch |

The cost of the rule is that a source-only breaking change — renaming an exported
type — has no number left to signal itself. Ship it as a minor with the old name
kept as a deprecated alias. A protocol's consumers cannot absorb two independent
axes of breakage, and between "the bytes changed" and "an identifier was tidied",
the bytes are the one a version number owes them.

Note what this does **not** do: it does not put the package's version on the
wire. Nothing negotiates over semver. The integer is still the only thing a peer
sees, and the window in `mobileControlSupportedProtocolVersions` is still the only
thing that decides whether it is accepted.

## Changing a wire format

If your change alters anything that crosses either wire, do all of this:

1. **Decide which it is.** Additive → a new entry in `TAILNET_CAPABILITIES` (or
   the mobile capability list), no version bump. Otherwise → a version bump.
2. **If you bump**, move the current version and the minimum together so the
   window stays one version wide, and leave the code that reads the previous
   shape in place for that one release. A bump that also drops the old reader
   refuses every peer that has not updated yet, which is what the window exists
   to prevent.
3. **Check every enforcement site.** They must agree, or a peer is accepted by
   one and refused by another. Today:
   `git grep -n 'protocolVersion' -- src packages | grep -v test` and
   `git grep -n 'transportVersion' -- src`. The mobile protocol's own
   declaration moved out of `src` when it became a package, so leave `packages`
   in that first command — a sweep of `src` alone now silently skips the file
   the version is declared in. Note that the sites include the
   validators for records read back off **this machine's own disk** — a check
   pinned to the current version alone unpairs every device paired before the
   bump, silently, on the first restart after it.
4. **Test the edge, not the middle.** A peer inside the window is accepted, one
   outside it is refused, and the refusal names both versions. The existing
   examples are in `src/main/automation/tailnet-peers.test.ts`,
   `src/main/automation/tailnet-fleet-reachability.test.ts` and
   `src/main/mobile/bridge/validation.test.ts`.
5. **Mirror the mobile protocol module, and publish it.** Note that each repo's
   pin hashes only its OWN copy, so the two constants have to be set to the same
   value by hand — a pin left at its old value in one repo does not fail there,
   it just stops comparing the two files, which is how the copies came to differ
   by an optional `rolesUnavailable` field before v3 found it. The module now lives
   in `packages/mobile-control-protocol` and is published as
   `@sprintengine/mobile-control-protocol`. Until a released phone build depends
   on that package it still carries its own copy, so
   `src/main/mobile/control/snapshot.test.ts` and the phone's
   `mobileControlProtocol.regression.test.js` still pin the same sha256 of the
   source and fail the moment the two diverge. Editing the module means making
   the same edit in the phone's copy, setting both pins to the new shared hash,
   and publishing a version whose major matches the new wire version. A
   desktop-only bump is half a change; the window is the grace period it needs,
   not permission to skip it. `docs/mobile-protocol-package.md` has the
   migration and the order of operations.
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

`packages/mobile-control-protocol/CHANGELOG.md` has the member-by-member list.

### 3 — the Sprint Engine leaves the wire (2026-09-16)

**Breaking, and deliberately so.** `sprintEngines` was a required member of the
snapshot; the nine sprint commands, the eight sprint capabilities, their relay
scopes, the role catalogue and the `sprintengine` workspace kind were all wire
vocabulary. All of it is deleted. `mobileControlProtocolVersion` moved 2 -> 3 and
the window moved with it, to `[2, 3]`. The package published `3.0.0`.

**Why it could not be additive.** MC-2575 took the Sprint Engine out of the
desktop as a signed module, and the desktop stopped being able to serve any of
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

`packages/mobile-control-protocol/CHANGELOG.md` has the member-by-member list.

## What never changes without a bump

- The meaning of an existing field.
- The type of an existing field.
- Whether an existing field may be absent.
- The shape of anything under `health` on the tailnet transport, which is read by
  peers that have never paired with us and may be several releases behind.
