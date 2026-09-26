# Conversation protocol

The additive `conversations` lane on Studio's tailnet gateway. A socket is
scoped to one conversation and receives a bounded snapshot before `synchronized`, followed
by live events. Every mutation has a stable `commandId`; reads have a
`requestId`. This package contains portable frame types, input validation, tool
classification and presentation, without Electron, Node, or React dependencies.

Reconnect snapshots carry `reset: true`: replace cached events and their sequence
cursor before consuming the following `synchronized` fence. A crashed desktop can
lose buffered deltas and reuse their sequence numbers, so an old cursor alone
cannot prove prefix identity. Pending command UUIDs remain intact for idempotent
retry. Earlier turns remain available through `loadEarlier`.

Transcript frames travel directly over the tailnet, never through the hosted
relay. Hosted push-notification delivery is a separate integration.
