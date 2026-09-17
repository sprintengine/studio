---
name: studio-canvas
description: Draw, read and revise diagrams on a SprintEngine Studio Canvas board through the canvas_* tools, with the layout craft and the describe-edit-lint-screenshot loop behind a board worth looking at. Use when asked to draw, sketch, diagram, whiteboard, or visualise an architecture, a flow, a sequence or a data model; when asked to read or react to what the person drew on a Canvas board; or when a prompt names a `.excalidraw` file.
---

# Drawing on a Canvas board

A board is a `.excalidraw` file inside the project, normally under `diagrams/`,
and it is versioned with the repository like any other file. Drawing on one is
editing the person's project, and the person may have the same board open in
front of them while you work.

## When to draw

Draw when the shape of the thing is the answer: how services call each other,
the order of steps in a flow, who talks to whom in a sequence, how the tables
relate. Answer in text when the answer is a decision, a list, a tradeoff or a
paragraph — a diagram of three bullet points is worse than three bullet points.
When you are unsure, say what you would draw and offer.

If you drew something, tell the person which board it is on so they can open it.

## The board is a file the person is also holding

Their edits and yours are merged shape by shape, and the person always wins a
shape you are both touching: an edit of yours that lands on a shape they just
moved is recomputed once against the board they left, and told `interrupted` if
it collides again. Edits to shapes they are not touching go through, even while
they are drawing. `canvas_describe` reports what they changed since
you last looked, under "Changed since you last looked" — read it before you
touch anything, and treat it as instruction: they moved that box for a reason.

**Never wipe the person's work.** A `replace` import empties the board, and a
mass delete does the same slowly; both need the person to have asked for exactly
that. When you want a clean surface, draw on a new board instead: pass a new
`board` name and you get a new file.

## The loop

1. **`canvas_describe` first.** Never assume a board is empty, even one you
   created a minute ago. The outline gives you ids, positions and connections;
   `detail: full` adds the editable skeleton of every element.
2. **Plan the layout before the first call.** Decide the grid, the column or row
   positions and the size of each box on paper (in your head) — the coordinates
   are a consequence of that plan, not a thing to discover by trial.
3. **`canvas_edit` in batches.** One call per section, with the arrows for that
   section in the same call so they can attach by `tempId`.
4. **Read the lint that comes back.** It scores the drawing out of 100 and names
   what is wrong: overlaps, cramped neighbours, text that does not fit its box,
   arrows attached at one end or at neither. **Fix a low score by redesigning the
   layout** — wider gutters, a column that becomes two rows, a box sized to its
   label. Nudging one shape by 12 px to clear one overlap is how a board ends up
   looking like a pile of rectangles.
5. **`canvas_screenshot` once**, at the end or after a substantial change. The
   lint is the cheap check; the screenshot is for judging the drawing the way a
   person sees it. Do not take one after every edit.

Iterate a few times at most. If the third pass is still fighting the lint, the
plan is wrong, not the coordinates.

## Laying out a board

**Work on a grid.** A default node is 200×80. Leave 80–120 px between
neighbours, and 160–240 px between one region and the next. Round every
coordinate to something you can hold in your head — multiples of 20 — so the
next edit is arithmetic you can do without reading the board back.

**Direction carries meaning.** Architecture reads left to right: client, edge,
service, store. A process or a decision flow reads top to bottom. A sequence
reads top to bottom with one lifeline per participant, left to right. Pick one
and keep it for the whole board.

**One idea per region.** A board that holds an architecture and a deployment
timeline holds two boards. If both are wanted, use two board files, or two
frames far enough apart that nobody reads across the gap.

**Size shapes to their labels.** Text is roughly 9–10 px per character at the
default font size, plus padding on both sides. "Auth service" needs about 160 px
of width; give it 200. Keep labels to a few words — rewrite the label rather than
widen the box past 280 px.

**Titles are text elements, not labels.** A shape's `text` is drawn centred on
it, so a title on a large rectangle sits on top of everything inside it. Put a
board title or a zone name in its own text element at the top-left of the zone,
one line above whatever it names, at a larger `fontSize`.

**Attach every arrow.** `startElementId` and `endElementId` are the only way to
connect shapes; an arrow whose geometry merely touches a box is not attached and
comes loose the first time anything moves. Point them at an existing id, or at a
`tempId` created in the same `canvas_edit` call. Label an arrow only when the
label carries information the shapes do not ("on failure", "async") — an
architecture where every arrow says "calls" is noise.

**Order nodes so arrows do not cross.** If two arrows cross, swap the two nodes
they connect; that is almost always the fix. Long arrows that must cross a
region read better `elbowed`.

**Use `canvas_layout` rather than arithmetic.** Align a column on `left`,
distribute a row `horizontal`, stack a sequence with a fixed `gap`. It is
straighter than recomputing coordinates, and it is one call. Read the
`warnings` it comes back with: an element this format cannot re-describe — a
freehand stroke, an image — is named there and was NOT moved.

**Frames group a section.** A frame with a `name` holds its children and moves
with them — better than a big rectangle behind them, which is a shape the person
has to click around.

## Colour

Restraint reads as design. Use one stroke/fill pair per meaning and leave
everything else neutral:

| Meaning | Stroke | Background |
|---|---|---|
| Neutral, the default | `#1e1e1e` | `transparent` or `#f8f9fa` |
| Primary — the thing being explained | `#1971c2` | `#d0ebff` |
| Healthy, done, success path | `#2f9e44` | `#b2f2bb` |
| Warning, degraded, needs attention | `#e8590c` | `#ffec99` |
| Failure, deleted, danger | `#e03131` | `#ffc9c9` |

Most of a good board is neutral. Colour marks the two or three shapes the person
should look at first. Dashed strokes mean optional, planned or asynchronous;
keep solid as the norm so dashed still means something.

## Big boards

Build them section by section: one `canvas_edit` per section, describe or
screenshot between sections if you are unsure, and place each section at a
planned offset so sections never collide. Lay out the sections themselves on a
grid — left to right in rows of two or three — rather than in one endless column.

For a flowchart, sequence, class, entity-relationship or state diagram, a
`canvas_import` of Mermaid source is the fastest start: it arrives as real
editable shapes. Follow it with a tidy-up `canvas_edit` — imported layouts are
mechanical, and the lint will tell you where. Any other Mermaid kind arrives as a
single image element you cannot edit, so for those draw the shapes yourself.

## Reading what the person drew

Start with `canvas_describe` at `detail: outline`: it lists every element with
its id, position and label, and the connections between them. Use `canvas_find`
to pull one region (`bbox`), one kind (`type`) or one name (`query`) out of a
large board — it returns the same skeleton shape `canvas_edit` takes, so a
found element can be passed straight into an update.

Take a `canvas_screenshot` when the arrangement itself is the content: a sketch
with freehand strokes, a drawing with images pasted in, anything where "what is
near what" matters. Freehand strokes, images and embeds are counted in the
outline but are not in the skeleton view, so a board full of them is one you have
to look at.

## When something goes wrong

- **`revealed: false` from `canvas_open`** — no window is showing this workspace,
  so the tab could not be brought up. It is not a failure: the board is on disk
  and every other tool works on it. Carry on, and say where the board is.
- **`interrupted`** — the person edited the same shapes your action was
  changing, twice in a row, so nothing was written. Call `canvas_describe`
  again, read what they changed, and redo the part that is still wanted. Never
  simply retry the same edit.
- **`canvas_module_disabled`** — the Canvas module is switched off. Say so and
  point at Settings → Modules; there is no way around it from here.
- **`too_large` from `canvas_screenshot`** — the render did not fit the wire.
  Capture a subset with `elementIds`, or lower `maxEdge`.
- **`not_found`** — there is no board at that path yet. `canvas_open` creates one
  and shows it to the person; `canvas_edit` creates one with your first shapes.
- **`invalid_scene` naming the board file** — somebody has the file open in
  another program mid-save, or has hand-edited it into something unreadable.
  Nothing was written and the file is untouched. Wait a moment and try again;
  if it keeps happening, say so rather than working around it.
- **A lint report that says "at least N issue(s)"** — the board is large enough
  that the scan stopped early, so the score is an upper bound. Draw the next
  section on its own board rather than adding to this one.
