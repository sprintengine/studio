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
| Mobile control — the phone driving a desktop | `mobileControlProtocolVersion` (integer) | `mobileControlSupportedProtocolVersions` | `src/shared/mobile-control/protocol.ts` |
| MCP | dated strings, newest first | every entry in the list | `src/shared/mcp/protocol.ts` |

Two more version numbers are near these and are **not** wire windows.
`mobileControlWorkspaceSnapshotVersion` versions the snapshot body inside the
mobile protocol, and the backlog item schema version is a file format. Neither is
negotiated with a peer.

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
   `git grep -n 'protocolVersion' -- src | grep -v test` and
   `git grep -n 'transportVersion' -- src`. Note that this includes the
   validators for records read back off **this machine's own disk** — a check
   pinned to the current version alone unpairs every device paired before the
   bump, silently, on the first restart after it.
4. **Test the edge, not the middle.** A peer inside the window is accepted, one
   outside it is refused, and the refusal names both versions. The existing
   examples are in `src/main/automation/tailnet-peers.test.ts`,
   `src/main/automation/tailnet-fleet-reachability.test.ts` and
   `src/main/mobile/bridge/validation.test.ts`.
5. **Mirror the mobile protocol module.** `src/shared/mobile-control/protocol.ts`
   is a byte-identical copy of the phone app's own file, in a repository that is
   not this one. Both repositories pin its sha256 — here in
   `src/main/mobile/sprintengine/snapshot.test.ts`, there in
   `mobileControlProtocol.regression.test.js` — and the guard fails the moment
   they diverge. Editing that file means making the same edit in the phone's
   copy and setting both pins to the new shared hash. A desktop-only bump is
   half a change; the window is the grace period it needs, not permission to
   skip it.
6. **Update this file**, if what you changed is the policy rather than an
   instance of it.

## What never changes without a bump

- The meaning of an existing field.
- The type of an existing field.
- Whether an existing field may be absent.
- The shape of anything under `health` on the tailnet transport, which is read by
  peers that have never paired with us and may be several releases behind.
