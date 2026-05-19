import React from 'react'
import { Tabs, type TabItem } from '../ui'
import {
  selectSwitchboardView,
  useSwitchboardViewStore,
  type SwitchboardWorkspaceView,
} from '../../store/switchboardViewStore'
import WatchtowerPanel from './WatchtowerPanel'
import SwitchboardBoardPanel from './SwitchboardBoardPanel'

function WatchtowerNavIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M2 8C3.5 5 5.5 3.5 8 3.5C10.5 3.5 12.5 5 14 8C12.5 11 10.5 12.5 8 12.5C5.5 12.5 3.5 11 2 8Z"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinejoin="round"
      />
      <circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1.25" />
    </svg>
  )
}

function SwitchboardNavIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="2.5" y="3" width="11" height="10" rx="1.2" stroke="currentColor" strokeWidth="1.25" />
      <line x1="2.5" y1="6.25" x2="13.5" y2="6.25" stroke="currentColor" strokeWidth="1.25" />
      <line x1="6.5" y1="6.25" x2="6.5" y2="13" stroke="currentColor" strokeWidth="1.25" />
      <line x1="10.25" y1="6.25" x2="10.25" y2="13" stroke="currentColor" strokeWidth="1.25" />
    </svg>
  )
}

const SUB_NAV_ITEMS: TabItem<SwitchboardWorkspaceView>[] = [
  { id: 'watchtower', label: 'Watchtower', icon: WatchtowerNavIcon },
  { id: 'switchboard', label: 'Switchboard', icon: SwitchboardNavIcon },
]

export default function SwitchboardWorkspacePanel({ workspaceId }: { workspaceId: string }) {
  const activeView = useSwitchboardViewStore((state) => selectSwitchboardView(state, workspaceId))
  const setView = useSwitchboardViewStore((state) => state.setView)

  return (
    <div className="flex h-full min-h-0 flex-col bg-[color:var(--bg-app)]">
      <div className="shrink-0 border-b border-[color:var(--border-default)] bg-[color:var(--bg-surface)]">
        <Tabs<SwitchboardWorkspaceView>
          ariaLabel="Switchboard workspace view"
          items={SUB_NAV_ITEMS}
          value={activeView}
          onChange={(view) => setView(workspaceId, view)}
          idPrefix="switchboard-workspace-view"
          className="px-3"
          borderless
        />
      </div>

      {/* Both panels stay mounted so internal state (filters, scroll, drawer */}
      {/* open/close, IPC subscriptions) survives view switches. The inactive */}
      {/* one is hidden via display:none so it doesn't compete for layout. */}
      <div
        role="tabpanel"
        id="switchboard-workspace-view-panel-watchtower"
        aria-labelledby="switchboard-workspace-view-tab-watchtower"
        className={`min-h-0 flex-1 ${activeView === 'watchtower' ? '' : 'hidden'}`}
      >
        <WatchtowerPanel workspaceId={workspaceId} />
      </div>
      <div
        role="tabpanel"
        id="switchboard-workspace-view-panel-switchboard"
        aria-labelledby="switchboard-workspace-view-tab-switchboard"
        className={`min-h-0 flex-1 ${activeView === 'switchboard' ? '' : 'hidden'}`}
      >
        <SwitchboardBoardPanel workspaceId={workspaceId} />
      </div>
    </div>
  )
}
