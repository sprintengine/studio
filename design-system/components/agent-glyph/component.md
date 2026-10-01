# Agent glyph

A spawned agent drawn as a small character. While its agent works the character
moves; when the agent ends it stands still and its face says how it ended.

It answers one question, *where is this agent*, for the agents a conversation
sends off to do part of the work: a search, a plan, a review. It is the
[liveness](../liveness/component.md) mark for an agent, and the one mark in the
system that is allowed a personality (ruling 2026-09-28): an agent is a helper
someone is waiting on, and a character they can recognise across a long run
reads faster than a fourth identical row.

## Anatomy

| Part | Class | Required |
|---|---|---|
| Glyph | `.ds-agent-glyph` | yes — a 16px SVG on the glyph grid, `currentColor` line work (1.4 stroke for the outline, 1.3 for detail) |
| Character | `.ds-agent-glyph--<character>` | yes — which drawing |
| State | `.ds-agent-glyph--<state>` | yes — working, done, failed, stopped or unknown; picks the ink and the face |
| Moving parts | `.ds-agent-glyph-whole`, `-eyes`, `-antenna`, `-string`, `-whiskers`, `-hat`, `-nose`, `-bow` | while working — the parts a character's loop moves |

## Variants

The characters come in seasonal pools. Each pool holds at least three, and the
robot is in every one, so an agent is never a stranger.

| Pool | When | Characters |
|---|---|---|
| Everyday | most of the year | robot, bubble, balloon, bear, gent, mushroom |
| Halloween | 1–31 October | robot, pumpkin, ghost, black cat, witch, skull |
| Christmas | 1–26 December | robot, elf, Santa, reindeer, present |

The character is picked from the current pool by the agent's id (the id of the
tool call that spawned it), so an agent keeps its face for as long as it is on
screen and agents running side by side usually differ. The season follows the
local calendar.

Each character moves in its own way while it works: the robot's antenna blinks
and its eyes scan, the bubble squishes and glances about, the balloon drifts on
its swaying string, the bear nods, the gent tips his hat, the mushroom squishes,
the ghost floats and blinks, the pumpkin and the skull rock by candlelight, the
cat's whiskers twitch, the witch's hat flops, the elf's hat flops, Santa
bounces, the reindeer's nose blinks and the present hops.

At 16px one unit of the grid is one pixel, so every character keeps a clear
face: solid eyes with room around them, and whatever says who it is (a hat,
ears, antlers, a string) outside the face rather than on it. A ring round an
eye, or a feature squeezed between the eyes and the outline, blurs into mush at
this size and leaves no room for the finished faces.

## States

| State | Ink | Face |
|---|---|---|
| Working | `accent.primary` | eyes open, moving |
| Done | `text.subtle` | eyes closed, content (^ ^) |
| Failed | `status.danger` | crossed out (x x) |
| Stopped | `text.subtle` | switched off (- -) |
| Unknown | `text.subtle` | as done — an agent from a transcript that never recorded how it ended |
| Reduced motion | as its state | a working character holds still, eyes open |

Every loop also holds still while the window is hidden or in the background,
and a transcript row pauses its own when it scrolls out of view.

## Usage

- On the row of the agent it stands for: an agent lane in a chat, a row of the
  Agents panel. Beside the agent's name and its state in words (`Working · 42s`,
  `Done in 1m 29s`, `Failed after 9s`), never instead of them.
- One per agent. A glyph and a working mark on the same row is two marks saying
  one thing.
- Not for conversations, terminals or jobs. Those are working
  [liveness](../liveness/component.md) marks; the characters are for agents a
  conversation spawned.
- People can turn the characters off (Settings → Appearance). Then a working
  agent wears the working mark and a finished one a lifecycle glyph.
- Never a status dot beside it (ruling 2026-09-28).

## Accessibility

- Decorative (`aria-hidden`) when the text beside it names the agent and its
  state, which is the normal case. Given a label it is `role="img"`.
- The state is never carried by the character or its motion alone: the words
  beside it say working, done, failed or stopped.
- Reduced motion is honoured in the stylesheet: the class that animates is the
  class that carries the guard.
