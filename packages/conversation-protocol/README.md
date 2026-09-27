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

A frame larger than `CONVERSATION_MAX_FRAME_BYTES` arrives as `chunk` frames
whose `json` strings concatenate, in `index` order, to the frame. A snapshot
larger than one frame arrives as several `snapshot` frames carrying
`part: { index, total }`; concatenate their `page.events` and apply the result
when the last part arrives.

A client that reads too slowly gets consecutive text deltas merged while it
catches up. One that stops reading is sent an `error` with code
`resync_required` and `retryAfterMs`, then closed with
`CONVERSATION_RESYNC_CLOSE_CODE`; the close reason carries the same delay
(`conversationCloseRetryAfterMs`). Wait that long, then resubscribe with the
last cursor. Requests beyond the per-socket bound are answered with code `busy`
and `retryAfterMs`, and the socket stays open.

Every refusal is correlated. A command is always settled by a `commandResult`
under its `commandId` (an unsafe decision or preset, a message over
`CONVERSATION_MAX_MESSAGE_CHARS`, a missing grant), a read by a `result` under
its `requestId` (including `too_large` for a response over 32 MB), and a
subscription that cannot start by `subscribeFailed` with its `key`, a
`retryable` flag and, when retryable, `retryAfterMs`. A client frame larger
than `CONVERSATION_MAX_CLIENT_FRAME_BYTES` is skipped and refused the same way;
put `type` and the id ahead of any long field so the refusal can name it.

Transcript frames travel directly over the tailnet between paired machines.
