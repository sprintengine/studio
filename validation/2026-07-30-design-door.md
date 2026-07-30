# Design door — whole-flow validation in the running app

Epic `design-door` (2000), item T6. Run 2026-07-30 against branch
`sprintengine/design-door` at the merged result of T1–T5.

Harness: `scripts/testing/design-door-pass.mjs` — a real Electron launch driven
with Playwright, against **this worktree's** renderer (served from its own vite
dev server, `ELECTRON_RENDERER_URL` overwritten, never inherited). Screenshots
and a JSON transcript land in `$MULTICODE_T6_OUT_DIR`, default
`/tmp/multicode-t6-design-door/out`.

```
npm run build                       # out/main + out/preload
tmp=/tmp/multicode-playwright
npm --prefix "$tmp" install playwright --no-audit --no-fund
NODE_PATH="$tmp/node_modules:$PWD/node_modules" \
  node scripts/testing/design-door-pass.mjs
```

## Result: 15/15 checks passed

Against real folders on disk, not fixtures: the repo's own `design-system/`
copied to `/tmp/multicode-t6-design-door/cloned-repo/design-system` to stand in
for "a repo they have cloned", and a synthesised 100-component bundle.

| # | Check | Evidence |
|---|---|---|
| 1 | The Design door has a row in the sidebar | — |
| 2 | The door opens and owns the ONE navigation column | `{"surfaceLabel":"Design","navColumns":["context-rail"]}` |
| 3 | Back is a pinned rail row | `railHasBack=true` |
| 4 | The canvas renders manifest-declared groups with previews | `Foundations, Components, Patterns, Glyphs`; 8 iframes |
| 5 | The chrome bar carries the folder path with Reveal and Reload | screenshot 03 |
| 6 | Every preview is a sandboxed iframe | `sandbox=""` on all 8 |
| 7 | No Release / lint / regenerate / version history / pull affordance | full-text scan |
| 8 | Pointing at a folder registers a PATH and copies nothing | `registryHasPath=true legacyCopy=false` |
| 9 | A component opens with every stage and its `component.md` sections | `Anatomy,Variants,States,Usage,Accessibility`; 2 stages |
| 10 | The generated `tokens.css` is left deliberately stale | asserted before the reload |
| 11 | Editing the token SOURCE, then Reload, shows the new value | `before=rgb(8,8,12)` → `after=rgb(255,0,255)` |
| 12 | A deleted folder is a NAMED broken row with its path, offering Re-point and Forget | `{"namesTheKind":true,"showsPath":true,"offersRepoint":true,"offersForget":true,"rowSurvives":true}` |
| 13 | 100 components scroll without the page becoming unusable | measured, below |
| 14 | Lazy mounting stands up only the visible previews on open | measured, below |
| 15 | Back leaves the door and returns the projects rail, still one column | `navColumns:["projects-tree"]` |

## Measured numbers

**Density — 100 components, full-list scroll (40 steps over 4842px):**

```
tiles              113
liveIframesOnOpen   15   of 113 tiles
liveIframes        100   after scrolling the entire list
scrollHeight      4842
elapsedMs         1648
frameCount         231
medianFrameMs      6.9
p95FrameMs        10.7
worstFrameMs      17.4
```

**15 live previews on open, out of 113 tiles** — that is what lazy mounting
buys, measured rather than assumed.

A median of 6.9 ms and a p95 of 10.7 ms is 60 fps throughout, with the worst
single frame at 17.4 ms — one frame's budget. **No jump-to-group control was
needed**, which the item allows only if scroll alone stopped working. It did not.

`liveIframes` reaching 100 after a full scroll is by design, not a leak:
`PreviewFrame` mounts a frame when it first nears the viewport and then KEEPS it,
because unmounting on exit would reload the document every time the user
scrolled back. The property that matters is how many stand up **on open**, and
that is what check 14 measures. My first version of that check asserted the
after-scroll number instead and failed; the check was wrong, not the code, and
correcting it was the honest fix.

**Read path (from `bundle-read.test.ts`, same 100-component shape):** one IPC
call, 23 ms, 548 KiB payload (~5.6 KB/component), with the emitted token block
appearing exactly once — the reason the payload ships fragments rather than
composed documents.

## What the screenshots show

Committed beside this report in `validation/2026-07-30-design-door/`, with the
run's JSON transcript: `01-door-empty`, `02-create-screen`, `03-canvas-rendered`,
`04-component-detail`, `05-reload-after-source-edit`, `06-broken-row`,
`07-hundred-components`, `08-back-to-workspace`.

Reviewed as pixels, not source. The canvas renders all eight of the repo
system's real components — `button`, `input`, `list-row`, `provider-row`,
`split-button`, `switch`, `task-card`, `tooltip` — each as its own markup, with
`4 variants · 4 states` style counts read from `component.md` and no count line
at all on `switch` and `tooltip`, whose docs carry prose rather than lists. The
specimen shows `multicode` in the system's own face over its own palette; the
rail row carries the rounded-square chip in the system's accent.

### One defect found by looking, and fixed

**Tiles clipped mid-element.** A demo stage taller than the 132 px tile was
CENTRED in it, so the tile showed a band cut through the middle of two controls
— real content, drawn in a way that reads as broken. Fixed in `preview-doc.ts`
by switching the tile layout to `align-items: safe center` /
`justify-content: safe center`: a stage that fits is centred, one that overflows
is anchored to its top edge, so the first row is always whole and the clip reads
as "there is more below" rather than as damage. Confirmed by re-running the pass
and looking at `03-canvas-rendered.png` again: every tile now opens on a
complete control — the whole `Create workspace` button, the whole input field,
two whole switch rows — where before each was a band cut through the middle.

## Honest remaining gaps

- **Detail stages reserve a fixed 260 px, so a short stage leaves dead space
  below it before its caption.** Cosmetic, not lost content. It is not trivially
  fixable: `sandbox=""` gives the frame an opaque origin, so the parent cannot
  read `contentDocument.scrollHeight` to size it, and the only ways to auto-size
  are to add `allow-same-origin` (weakens the isolation this surface exists to
  guarantee) or to let the frame run script (same). Left as-is deliberately
  rather than trading isolation for spacing.
- **The pass cannot isolate `~/.multicode`.** Overriding `HOME` to a temp
  directory hangs Electron's renderer before it becomes evaluable — measured
  twice, and the cause of two dead runs before it was identified. The pass
  therefore registers into the real user registry and **forgets exactly its own
  entries** on the way out (`cleanup: forgot 2 registration(s) from this pass`).
- **Attach from a registered folder was not exercised in the app.** It is covered
  at the unit level (`attach.test.ts`: a library entry addressed by registration
  id lands the full bundle at `design-system/`, and an existing one is a typed
  conflict with nothing written), but the wizard step that drives it lives in
  new-workspace creation, which this pass does not walk.
- **`npm run verify:app` cannot go green**, at this branch or at `main`: three of
  its 375 steps fail at clean HEAD — `test:renderer:xterm-output-queue`,
  `test:renderer:sprintengine-handoff`, `test:seams:premium-feel`. All three
  were reproduced in a detached worktree at `HEAD` and are unrelated to this
  epic; two others in the same family (`test:main:agent-launch-render`,
  `test:renderer:diagnostics-report`) were stale copy assertions and were fixed
  in T1. Everything else in the chain passes.
