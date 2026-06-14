# GPU process & terminal rendering — performance review (Workstream C)

> **Scope.** This document covers the **GPU process** angle of the June 2026
> whole-app performance profile (~2.4 GB total RSS, GPU process at 611 MB +
> 10–13% CPU). The renderer-memory (1.6 GB) and renderer-CPU (31–43%) findings
> are owned by separate workstreams. This review focuses on what drives GPU
> compositor memory and CPU: the xterm terminal rendering path and how many
> terminal surfaces are composited at once.
>
> **All findings below are re-verified against the current codebase
> (2026-06-14).** Where the original instantaneous profile's hypotheses no
> longer match the code, that is called out explicitly under
> "Corrections to the original profile."

## Measurement context

- Live dev instance (`electron-vite dev`), Apple M4, 10 cores, 16 GB RAM.
- Captured via `ps`, `top -l`, `footprint`, `sample`, `lsof` (instantaneous
  samples).
- **Caveat carried from the original profile:** the app was **not strictly
  idle** — 23 open terminals with live agent processes (a codex agent, a
  `sprintengine_mcp` HTTP server, multiple playwright-mcp workers). A material
  share of the observed load is legitimate streaming workload, not idle spin.
  This caveat materially changes the interpretation of the GPU/CPU numbers
  (see corrections).

| Process | Role | CPU (instantaneous) | Phys memory | Threads | FDs |
|---|---|---|---|---|---|
| Renderer | React + xterm UI | 31–43% sustained | 1.63 GB (peak 2.71 GB) | 20 | 52 |
| **GPU process** | **Chromium compositor** | **10–13%** | **611 MB** | 19 | 40 |
| Main | node-pty, watchers, IPC | ~2% | 172 MB | 79 | 248 |
| Network service | — | ~0% | 12 MB | — | — |

## Verdict on the GPU finding

**Real, and worth tackling — but it is a symptom of an architectural choice,
not a leak.** The 611 MB GPU footprint is consistent with **many
DOM-rendered xterm terminals being composited simultaneously**, each carrying
large scrollback. There is no evidence of a runaway/unbounded GPU leak: the
workspace-layer retention system bounds how many layers stay mounted. The cost
is structural — it scales with `(mounted terminals) × (per-terminal DOM render
surface + scrollback)`.

## Findings by severity

### 🟠 High — All terminals use xterm's DOM renderer; no GPU-accelerated renderer

**Confirmed.** No `@xterm/addon-webgl` or `@xterm/addon-canvas` is installed
(`package.json` — only `@xterm/addon-fit@^0.11.0`,
`@xterm/addon-web-links@^0.12.0`, `@xterm/xterm@^6.0.0`). Neither
`TerminalView.tsx` (`new Terminal()` at `src/renderer/src/components/panels/TerminalView.tsx:346`)
nor `PlainTerminalPanel.tsx`
(`src/renderer/src/components/panels/PlainTerminalPanel.tsx:69`) loads a
renderer addon. With no renderer addon, xterm uses its built-in **DOM
renderer**, which emits styled `<span>` runs per visible row.

The `rendererMode?: 'default' | 'webgl'` field in
`src/renderer/src/utils/terminalDiagnostics.ts:10` is a **diagnostics label
only** (defaults to `'default'` at `:103`); nothing wires a WebGL renderer.

**Impact.** The DOM renderer pushes per-row text layout and rasterization
through the Chromium compositor. Across many mounted terminals this is the
primary driver of GPU-process memory and compositing CPU. The DOM renderer is
xterm's slowest, most GPU/compositor-heavy path; the WebGL renderer draws each
terminal to a single GPU canvas instead of thousands of DOM nodes.

**Confidence.** High on the mechanism (verifiable from loaded addons).
Medium on it being *the* dominant GPU cost until measured (see plan).

### 🟠 High — Every live terminal is mounted and composited at once

**Confirmed.** Two layers of keep-alive stack:

1. **Workspace layers stay mounted while hidden.** Inactive workspace layers
   render with Tailwind `invisible` (`visibility: hidden`) rather than
   unmounting — `src/renderer/src/components/workspace/WorkspaceManager.tsx:1999`
   (`${active ? 'z-10 visible' : 'z-0 invisible'}`). Retention is bounded by
   `WORKSPACE_LAYOUT_RETAINED_INACTIVE_LIMIT = 4` and
   `WORKSPACE_LAYOUT_BUSY_RETAINED_LIMIT = 10`
   (`src/renderer/src/components/workspace/workspaceLayoutRetention.ts:9-10`),
   so **up to 10 busy workspace layers** can be mounted simultaneously.

2. **Inactive tabs within a workspace stay mounted.** The dock is
   `flexlayout-react@^0.8.12`. Tabs are created without `enableRenderOnDemand`
   (no occurrences in `src/renderer/src`), and flexlayout only unmounts an
   inactive tab when render-on-demand is enabled. With it off, **all tabs'
   components — and their `new Terminal()` xterm instances — remain mounted**
   regardless of which tab is visible. Tabs are only disposed on explicit tab
   close.

**Net effect.** With 23 live terminals spread across retained workspaces and
tabs, **most or all 23 xterm DOM instances exist in the live DOM
simultaneously**. `visibility: hidden` keeps an element's layout and its
cached compositor tiles — unlike `display: none` or `content-visibility:
hidden`, it does not let the compositor drop the layer. So hidden terminals
still contribute to the 611 MB.

**Impact.** GPU memory scales with total mounted terminals, not with the one
on screen. This is the largest lever on the 611 MB number.

**Confidence.** High (mount lifecycle traced through flexlayout's render
condition and the workspace-layer markup).

### 🟡 Medium — Large per-terminal scrollback (25,000 lines)

**Confirmed.** `scrollback: TERMINAL_RECENT_SCROLLBACK_LINES`
(`TerminalView.tsx:352`, `PlainTerminalPanel.tsx:75`), and
`TERMINAL_RECENT_SCROLLBACK_LINES = TERMINAL_STANDARD_SCROLLBACK_LINES * 5 =
5_000 * 5 = 25_000` (`src/shared/terminal-history.ts:10-11`).

**Impact.** 25k lines/terminal retained × up to ~23 mounted terminals is a
large retained buffer. This primarily feeds the **renderer** memory finding
(owned elsewhere), but it also enlarges each terminal's render/viewport state
and the work the compositor must cover when a hidden terminal is revealed.
Listed here as a contributing factor, not the GPU root cause.

**Confidence.** High on the value; medium on its share of GPU vs renderer
memory.

### 🔵 Informational — `cursorBlink: true` on every terminal

**Confirmed.** `cursorBlink: true` (`TerminalView.tsx:351`,
`PlainTerminalPanel.tsx:74`). xterm pauses cursor blink on blur, so this is a
continuous repaint on the **focused** terminal only — not a 23× multiplier. It
is a small, constant compositing cost on the active surface, worth noting but
not a priority.

## Corrections to the original profile

The instantaneous profile predates recent changes. Two of its CPU hypotheses
**no longer match the code** and should not be carried forward:

1. **"The rAF drain loop runs continuously per frame."** Not in current code.
   The output queue is **event-driven and self-suspending**:
   `scheduleDrain()` is armed only from `enqueue()` (new data) or when a single
   frame exceeds the write budget, and it early-returns if already scheduled
   (`src/renderer/src/utils/xtermOutputQueue.ts:145-180`). When the queue
   empties, `takeChunk()` returns `null` and the loop stops — no per-frame spin
   on idle terminals. The continuous CPU the profile saw is consistent with the
   stated **live streaming workload** (codex agent, playwright workers), not an
   idle drain loop.

2. **"The renderer parses projection JSON every tick."** Addressed.
   Token-based SprintEngine projection change-detection has landed
   (`src/renderer/src/utils/sprintengineProjectionRefresh.ts`; commits
   `d6939ce`, `ff49a9e`), so the renderer no longer re-parses/re-applies
   unchanged projections each tick.

These corrections matter for attribution: the residual GPU cost is best
explained by **how many DOM-rendered terminals are composited at once**, not by
a render-loop spin.

## Recommended actions (smallest effective first)

> Not yet implemented — recommendations pending measurement sign-off. Each is
> scoped to the GPU/compositor cost and preserves terminal correctness
> (scrollback + replay on attach).

1. **Drop GPU layers for hidden workspace layers.** Change inactive layers from
   `visibility: hidden` to `content-visibility: hidden` (preferred) — it skips
   rendering the subtree and lets the compositor release its tiles while
   preserving DOM/JS state and xterm buffers. The reveal path already re-fits on
   show via `WORKSPACE_LAYER_REVEAL_EVENT`
   (`WorkspaceManager.tsx:705-707`, `terminalFitScheduler.ts`), so the deferred
   re-fit hook this needs is already in place. **Lowest risk, directly targets
   the 611 MB; fully reversible.**

2. **Adopt the WebGL renderer for visible terminals.** Add
   `@xterm/addon-webgl` and load it on the active/visible terminal to collapse
   per-row DOM into a single GPU canvas. **Caveat:** browsers cap live WebGL
   contexts (~16); attaching it to all 20+ simultaneously-mounted terminals
   would exhaust contexts and trigger context-loss. So this must be paired with
   action 1 (or attach/detach the addon on visibility) so only visible terminals
   hold a WebGL context. **Higher payoff on compositing CPU, but needs the
   context-budget guard — do not attach blindly to all terminals.**

3. **Revisit the 25k scrollback default.** Confirm whether `RECENT` scrollback
   needs to be 5× standard for every mounted terminal, or whether hidden/idle
   terminals can carry a smaller live buffer with full history retained
   server-side (the main process already buffers for replay). Memory lever more
   than GPU; coordinate with the renderer-memory workstream to avoid
   double-counting.

## How to measure (required before claiming any fix)

The findings above are static; the GPU numbers must be confirmed at runtime.
None of this was run for this review — it is the verification plan.

1. **GPU memory attribution.** DevTools → **Layers** panel + `chrome://gpu` /
   `Memory` to count composited layers and GPU bytes. Baseline with 1 terminal
   vs N terminals to confirm linear scaling per mounted terminal.
2. **A/B action 1.** Measure GPU-process RSS with hidden layers on
   `visibility: hidden` vs `content-visibility: hidden`. Expected: GPU RSS drops
   roughly in proportion to hidden mounted terminals.
3. **A/B action 2.** Attach `@xterm/addon-webgl` to the visible terminal and
   record GPU-process CPU% during active streaming vs the DOM renderer.
   Expected: lower compositing CPU on the active surface. Watch for WebGL
   context-loss warnings as terminal count rises.
4. **Regression guard.** After any change, verify scrollback still restores on
   attach and on workspace/tab switch (replay correctness), and run the relevant
   suites (`test:renderer:xterm-output-queue`,
   `test:renderer:terminal-fit-scheduler`, `test:renderer:terminal-sessions`).

## Residual risks / open questions

- **WebGL context budget** is the main risk for action 2 — verify behavior at
  20+ terminals before rollout.
- **`content-visibility: hidden` and measurement** — children inside a
  `content-visibility: hidden` subtree report stale/zero geometry; the existing
  reveal-driven re-fit covers this, but confirm no other code path measures a
  hidden terminal's DOM directly.
- **Share of GPU vs renderer memory** for scrollback is not yet partitioned;
  coordinate with the renderer-memory workstream so the same buffers aren't
  optimized twice.

## File references

- Terminal instantiation: `src/renderer/src/components/panels/TerminalView.tsx:346`,
  `src/renderer/src/components/panels/PlainTerminalPanel.tsx:69`
- Renderer-mode label (no WebGL wired): `src/renderer/src/utils/terminalDiagnostics.ts:10,103`
- Workspace-layer hide mechanism: `src/renderer/src/components/workspace/WorkspaceManager.tsx:1999`
- Layer reveal / deferred re-fit: `src/renderer/src/components/workspace/WorkspaceManager.tsx:705-707`
- Retention limits: `src/renderer/src/components/workspace/workspaceLayoutRetention.ts:8-10`
- Scrollback constant: `src/shared/terminal-history.ts:10-11`
- Output queue (event-driven drain): `src/renderer/src/utils/xtermOutputQueue.ts:145-180`
- Projection token dedupe: `src/renderer/src/utils/sprintengineProjectionRefresh.ts`
- Dock: `flexlayout-react@^0.8.12` (`package.json:349`)
