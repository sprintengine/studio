# Conversation protocol

The additive `conversations` lane on Studio's tailnet gateway. A socket is
scoped to one conversation and receives a bounded snapshot before `synchronized`, followed
by live events. Every mutation has a stable `commandId`; reads have a
`requestId`. This package contains portable frame types, input validation, tool
classification and presentation, without Electron, Node, or React dependencies.

Resume with `subscribe({ afterSeq, generation })`, using the last sequence you
hold and the `generation` from the `snapshot` or `synchronized` frame it came
from. When the desktop can vouch for that cursor it sends one `event` per
missed event, then `synchronized`, then live events, with no snapshot. When it
cannot — another generation (the log was recreated), no generation, a cursor
ahead of the log, or one too far behind — it sends a `snapshot` with
`reset: true`: replace cached events and the cursor before consuming the
following `synchronized` fence. Earlier turns remain available through
`loadEarlier` with the page's `beforeCursor`.

Sequence numbers only increase but are not contiguous. A run of text deltas can
arrive merged into one delta numbered with the run's last sequence, so a gap is
normal and never a reason to resubscribe. Pending command ids remain intact for
idempotent retry.

Transcript frames travel directly over the tailnet between paired machines.
