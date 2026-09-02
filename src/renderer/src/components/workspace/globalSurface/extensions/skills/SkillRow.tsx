// One skill in a source listing: two targets in one row. The checkbox selects
// the skill for a batch install; the row body opens it to be read. They are
// siblings inside a plain container — never a button inside a button, which is
// invalid markup and gives the keyboard one target where the design has two.

import React from 'react'

import { Badge } from '../../../../ui/Badge'
import { Checkbox } from '../../../../ui/Checkbox'
import { FOCUS_RING_INSET_CLASS } from '../../../../ui/tokens'
import { skillGroupLabel, type SkillListItem } from './skillsSurfaceModel'

export function SkillRow({
  item,
  selected,
  onToggleSelect,
  onOpen,
  showGroup,
}: {
  item: SkillListItem
  selected: boolean
  onToggleSelect: () => void
  onOpen: () => void
  /** Search results span groups, so each row states the one it came from. */
  showGroup?: boolean
}): JSX.Element {
  return (
    <div
      // list-row: no border box — rows separate by the container's gap, and
      // the fills carry hover and selection exactly as every other list does.
      className={`flex items-stretch rounded-md transition-colors ${
        selected ? 'bg-[color:var(--bg-selected)]' : 'hover:bg-[color:var(--bg-hover)]'
      }`}
    >
      {/* The kit checkbox: a real `<input>` carries Space, the label
          association and the shared focus treatment, so this row no longer
          draws its own box beside `ui/Checkbox` (MC-2117). The 32px column is
          the hit target the row always had. */}
      <span className="grid w-8 shrink-0 place-items-center">
        <Checkbox checked={selected} onChange={onToggleSelect} ariaLabel={`Select ${item.name}`} />
      </span>
      <button
        type="button"
        onClick={onOpen}
        // Inset ring: the target sits flush inside the row's fill, so an
        // outset ring would collide with the neighbouring rows' fills.
        className={`group/skill-row flex min-w-0 flex-1 items-center gap-2.5 py-1.5 pr-2.5 text-left ${FOCUS_RING_INSET_CLASS}`}
      >
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-body font-medium text-[color:var(--text-strong)]">{item.name}</span>
          {item.description ? (
            <span className="truncate text-meta text-[color:var(--text-muted)]">{item.description}</span>
          ) : null}
        </span>
        {showGroup && item.group ? (
          <span className="shrink-0 font-mono text-meta text-[color:var(--text-subtle)]">
            {skillGroupLabel(item.group)}
          </span>
        ) : null}
        {/* The kit's label badge, said in words: "3 files" needs no tooltip to
            explain a glyph, and nothing here is a native `title=` on a span
            the keyboard could never reach. Decorative: the row is named by the
            skill and its description, and a file count is the one thing on it
            that is density detail rather than meaning — so it is the one chip
            here that can be dropped from the row's name, which on a listing
            this long is worth dropping. */}
        <Badge tone="neutral" decorative className="shrink-0 tabular-nums">
          {`${item.fileCount} file${item.fileCount === 1 ? '' : 's'}`}
        </Badge>
        {item.hasExecutables ? (
          <span className="shrink-0 text-meta text-[color:var(--text-subtle)]">Runs scripts</span>
        ) : null}
        {item.installed ? (
          <span className="shrink-0 text-meta text-[color:var(--text-muted)]">Installed</span>
        ) : null}
        {/* The row body is the target; "Read" names what it does when the
            pointer or the keyboard is on it, and stays out of the way of the
            disclosures otherwise. */}
        <span className="shrink-0 text-meta text-[color:var(--text-muted)] opacity-0 transition-opacity group-hover/skill-row:opacity-100 group-focus-visible/skill-row:opacity-100">
          Read
        </span>
      </button>
    </div>
  )
}
