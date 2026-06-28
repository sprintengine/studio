import {
  ContextMenu,
  MenuDivider,
  MenuFlyoutItem,
  MenuItem,
  MenuSwatchRow,
  StarGlyph,
  type SelectItem,
} from '../ui'
import CliIcon from '../CliIcon'
import type { AgentState } from '../../types/workspace'
import type {
  BacklogCriticality,
  BacklogDifficulty,
  BacklogHighlight,
  BacklogItem,
  BacklogItemStatus,
  BacklogRisk,
} from '../../utils/backlog'
import { CRITICALITY_LABEL, DIFFICULTY_WORD, RISK_LABEL } from '../../utils/backlogTriage'
import { BACKLOG_STATUS_LABEL } from './BacklogRow'

// Row-level Backlog actions, owned by the panel (the handlers persist through
// the backlog IPC and re-scan). The context menu and the detail pane dispatch
// through this one vocabulary so the two surfaces cannot drift.
export type DifficultyChoice = BacklogDifficulty | 'unset'
export type CriticalityChoice = BacklogCriticality | 'unset'
export type RiskChoice = BacklogRisk | 'unset'

export type BacklogActions = {
  createFolder: () => void
  createPlan: () => void
  openInEditor: (item: BacklogItem) => void
  revealInFiles: (item: BacklogItem) => void
  rename: (item: BacklogItem) => void
  archive: (item: BacklogItem) => void
  remove: (item: BacklogItem) => void
  setStatus: (item: BacklogItem, status: BacklogItemStatus) => void
  setDifficulty: (item: BacklogItem, value: DifficultyChoice) => void
  setCriticality: (item: BacklogItem, value: CriticalityChoice) => void
  setRisk: (item: BacklogItem, value: RiskChoice) => void
  setHighlight: (item: BacklogItem, highlight: BacklogHighlight) => void
}

// Shared size/priority choice lists (detail-pane Selects, create dialog, and
// the context-menu submenus). The cleared state leads so clearing is one click.
export const DIFFICULTY_EDIT_ITEMS: SelectItem<DifficultyChoice>[] = [
  { value: 'unset', label: 'Unestimated' },
  { value: 'xs', label: `XS · ${DIFFICULTY_WORD.xs.toLowerCase()}` },
  { value: 's', label: `S · ${DIFFICULTY_WORD.s.toLowerCase()}` },
  { value: 'm', label: `M · ${DIFFICULTY_WORD.m.toLowerCase()}` },
  { value: 'l', label: `L · ${DIFFICULTY_WORD.l.toLowerCase()}` },
  { value: 'xl', label: `XL · ${DIFFICULTY_WORD.xl.toLowerCase()}` },
]

export const CRITICALITY_EDIT_ITEMS: SelectItem<CriticalityChoice>[] = [
  { value: 'unset', label: 'No priority' },
  { value: 'low', label: CRITICALITY_LABEL.low },
  { value: 'normal', label: CRITICALITY_LABEL.normal },
  { value: 'high', label: CRITICALITY_LABEL.high },
  { value: 'critical', label: CRITICALITY_LABEL.critical },
]

// Risk = likelihood the work goes sideways, distinct from effort and impact.
// Cleared leads (one-click reset), same idiom as size/priority.
export const RISK_EDIT_ITEMS: SelectItem<RiskChoice>[] = [
  { value: 'unset', label: 'No risk set' },
  { value: 'low', label: RISK_LABEL.low },
  { value: 'normal', label: RISK_LABEL.normal },
  { value: 'high', label: RISK_LABEL.high },
]

// Status submenu choices: lifecycle states the user sets directly. Archived is
// deliberately absent — archiving is a file move owned by the top-level
// Archive action, not a status flip.
const STATUS_MENU_CHOICES: BacklogItemStatus[] = [
  'idea',
  'ready',
  'in_progress',
  'needs_input',
  'completed',
]

// Leading slot for submenu choice rows: a check on the current value, an
// equal-width spacer on the rest so labels align into one column.
function MenuCheckGlyph({ visible }: { visible: boolean }): JSX.Element {
  if (!visible) return <span className="icon-xs shrink-0" aria-hidden="true" />
  return (
    <svg viewBox="0 0 16 16" fill="none" className="icon-xs shrink-0" aria-hidden="true">
      <path d="M3.5 8.5L6.5 11.5L12.5 5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

// Right-click menu for a Backlog list row. Every mutation routes through the
// same BacklogActions handlers as the detail pane — the menu adds no mutation
// paths. One-shot actions close the menu; the Star checkbox and highlight
// swatches keep it open (sidebar idiom) and re-render from the re-scanned item.
export function BacklogItemContextMenu({
  x,
  y,
  item,
  actions,
  agentTargets,
  agentSessions,
  onFlyoutOpen,
  onSendToAgent,
  onClose,
}: {
  x: number
  y: number
  item: BacklogItem
  actions: BacklogActions
  agentTargets: Array<AgentState & { cliSessionId: string }>
  agentSessions: TerminalSessionSnapshot[] | null
  onFlyoutOpen: () => void
  onSendToAgent: (item: BacklogItem, sessionId: string) => void
  onClose: () => void
}): JSX.Element {
  const starred = item.highlight?.starred === true
  const currentColor = item.highlight?.color ?? null
  const archived = item.status === 'archived'

  return (
    <ContextMenu
      x={x}
      y={y}
      ariaLabel={`Backlog item actions: ${item.title}`}
      onClose={onClose}
      surfaceClassName="min-w-[240px]"
    >
      <MenuFlyoutItem
        label="Send to agent"
        ariaLabel="Send to agent"
        surfaceClassName="min-w-[200px]"
        onOpenChange={(open) => {
          if (open) onFlyoutOpen()
        }}
      >
        {agentTargets.length === 0 ? (
          <MenuItem disabled onClick={() => {}}>
            No running agents
          </MenuItem>
        ) : (
          agentTargets.map((agent) => {
            const session = agentSessions?.find(
              (candidate) => candidate.sessionId === agent.cliSessionId,
            )
            // Unknown liveness (list not fetched / fetch failed) keeps the row
            // enabled — the send core re-verifies before writing, so a dead
            // session still fails loudly instead of being mislabeled here.
            const dead = agentSessions !== null && session?.processAlive !== true
            return (
              <MenuItem
                key={agent.id}
                disabled={dead}
                icon={
                  agent.cli ? (
                    <CliIcon cli={agent.cli} className="icon-sm shrink-0 text-[color:var(--text-muted)]" />
                  ) : undefined
                }
                onClick={() => {
                  onSendToAgent(item, agent.cliSessionId)
                  onClose()
                }}
              >
                {agent.name}
              </MenuItem>
            )
          })
        )}
      </MenuFlyoutItem>
      <MenuDivider />
      <MenuItem
        checked={starred}
        onClick={() => actions.setHighlight(item, { starred: !starred, color: currentColor })}
        icon={
          <StarGlyph
            filled={starred}
            stroked
            className={`icon-sm shrink-0 ${starred ? 'text-[color:var(--tone-warn)]' : 'text-[color:var(--text-disabled)]'}`}
          />
        }
      >
        {starred ? 'Unstar' : 'Star'}
      </MenuItem>
      <MenuSwatchRow
        label="Highlight color"
        value={currentColor}
        onPick={(color) => actions.setHighlight(item, { starred, color })}
        onClear={() => actions.setHighlight(item, { starred, color: null })}
      />
      <MenuDivider />
      <MenuFlyoutItem label="Status" ariaLabel="Set status" surfaceClassName="min-w-[180px]">
        {STATUS_MENU_CHOICES.map((status) => (
          <MenuItem
            key={status}
            checked={item.status === status}
            icon={<MenuCheckGlyph visible={item.status === status} />}
            onClick={() => {
              actions.setStatus(item, status)
              onClose()
            }}
          >
            {BACKLOG_STATUS_LABEL[status]}
          </MenuItem>
        ))}
      </MenuFlyoutItem>
      <MenuFlyoutItem label="Priority" ariaLabel="Set priority" surfaceClassName="min-w-[180px]">
        {CRITICALITY_EDIT_ITEMS.map(({ value, label }) => (
          <MenuItem
            key={value}
            checked={(item.criticality ?? 'unset') === value}
            icon={<MenuCheckGlyph visible={(item.criticality ?? 'unset') === value} />}
            onClick={() => {
              actions.setCriticality(item, value)
              onClose()
            }}
          >
            {label}
          </MenuItem>
        ))}
      </MenuFlyoutItem>
      <MenuFlyoutItem label="Size" ariaLabel="Set size" surfaceClassName="min-w-[180px]">
        {DIFFICULTY_EDIT_ITEMS.map(({ value, label }) => (
          <MenuItem
            key={value}
            checked={(item.difficulty ?? 'unset') === value}
            icon={<MenuCheckGlyph visible={(item.difficulty ?? 'unset') === value} />}
            onClick={() => {
              actions.setDifficulty(item, value)
              onClose()
            }}
          >
            {label}
          </MenuItem>
        ))}
      </MenuFlyoutItem>
      <MenuFlyoutItem label="Risk" ariaLabel="Set risk" surfaceClassName="min-w-[180px]">
        {RISK_EDIT_ITEMS.map(({ value, label }) => (
          <MenuItem
            key={value}
            checked={(item.risk ?? 'unset') === value}
            icon={<MenuCheckGlyph visible={(item.risk ?? 'unset') === value} />}
            onClick={() => {
              actions.setRisk(item, value)
              onClose()
            }}
          >
            {label}
          </MenuItem>
        ))}
      </MenuFlyoutItem>
      <MenuDivider />
      <MenuItem
        onClick={() => {
          actions.openInEditor(item)
          onClose()
        }}
      >
        Open in editor
      </MenuItem>
      <MenuItem
        onClick={() => {
          actions.revealInFiles(item)
          onClose()
        }}
      >
        Reveal in Files
      </MenuItem>
      <MenuItem
        onClick={() => {
          actions.rename(item)
          onClose()
        }}
      >
        Rename…
      </MenuItem>
      {!archived ? (
        <MenuItem
          onClick={() => {
            actions.archive(item)
            onClose()
          }}
        >
          Archive
        </MenuItem>
      ) : null}
      <MenuItem
        variant="danger"
        onClick={() => {
          actions.remove(item)
          onClose()
        }}
      >
        Delete…
      </MenuItem>
    </ContextMenu>
  )
}
