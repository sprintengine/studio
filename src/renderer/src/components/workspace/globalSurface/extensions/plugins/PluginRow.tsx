// One plugin in a source listing: a list row whose whole body opens the
// detail pane. Four things at rest — name, description, what it ships, and a
// state word only when there is state — per the row ceiling.

import React from 'react'

import { Badge } from '../../../../ui/Badge'
import { FOCUS_RING_INSET_CLASS } from '../../../../ui/tokens'
import type { PluginListItem } from './pluginsSurfaceModel'

export function PluginRow({
  item,
  selected,
  onOpen,
}: {
  item: PluginListItem
  selected: boolean
  onOpen: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-current={selected ? 'true' : undefined}
      className={`flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left transition-colors ${FOCUS_RING_INSET_CLASS} ${
        selected
          ? 'bg-[color:var(--bg-selected)] shadow-[inset_0_0_0_2px_var(--accent-primary)]'
          : 'hover:bg-[color:var(--bg-hover)]'
      }`}
    >
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-body font-medium text-[color:var(--text-strong)]">{item.name}</span>
        {item.description ? (
          <span className="truncate text-meta text-[color:var(--text-muted)]">{item.description}</span>
        ) : null}
      </span>
      <span className="flex shrink-0 items-center gap-2">
        {item.install.kind === 'installed' ? <Badge tone="good">Installed</Badge> : null}
        {item.install.kind === 'update-available' ? <Badge tone="warn">Update</Badge> : null}
        <span className="font-mono text-meta tabular-nums text-[color:var(--text-subtle)]">{item.components}</span>
      </span>
    </button>
  )
}
