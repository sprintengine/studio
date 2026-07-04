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
  BacklogHighlightColor,
  BacklogItem,
  BacklogItemLink,
  BacklogItemStatus,
  BacklogRisk,
} from '../../utils/backlog'
import { CRITICALITY_LABEL, DIFFICULTY_WORD, RISK_LABEL } from '../../utils/backlogTriage'
import { BACKLOG_STATUS_LABEL } from './BacklogRow'
import { BacklogItemSearchPicker } from './BacklogItemSearchPicker'

// Row-level Backlog actions, owned by the panel (the handlers persist through
// the backlog IPC and re-scan). The context menu and the detail pane dispatch
// through this one vocabulary so the two surfaces cannot drift.
export type DifficultyChoice = BacklogDifficulty | 'unset'
export type CriticalityChoice = BacklogCriticality | 'unset'
export type RiskChoice = BacklogRisk | 'unset'

// One assignable epic for the "Move to epic" affordances: the epic file's slug
// (the updateBacklogEpic target) plus its display title.
export type BacklogEpicChoice = { slug: string; title: string; displayId?: string }

// One candidate prerequisite for the "Depends on…" affordances: an item's id
// (to exclude self), its slug (the dependsOn target, = filename stem), and its
// display title. The full candidate set is shared; each surface drops the
// current item by id.
export type BacklogDependencyChoice = { id: string; slug: string; title: string; displayId?: string }

export type BacklogContextItemAction = {
  id: string
  label: string
  disabled: boolean
  run: () => void
}

// Toggle one prerequisite slug in an item's `dependsOn` set (add if absent,
// remove if present), preserving order. Both the context menu and the detail
// editor route through this so the two surfaces compute the next set identically.
export function toggleDependencySlug(current: readonly string[] | undefined, slug: string): string[] {
  const set = current ?? []
  return set.includes(slug) ? set.filter((existing) => existing !== slug) : [...set, slug]
}

export type BacklogActions = {
  createFolder: () => void
  createPlan: () => void
  openInEditor: (item: BacklogItem) => void
  revealInFiles: (item: BacklogItem) => void
  rename: (item: BacklogItem) => void
  archive: (item: BacklogItem) => void
  // Archive an epic and roll up its children (each archived, then the epic) so
  // the Archived lens shows the epic as a single grouped unit.
  archiveEpic: (item: BacklogItem) => void
  remove: (item: BacklogItem) => void
  // Remove only the association. The linked sprint/agent continues to exist,
  // and lifecycle remains independently controlled by setStatus.
  removeLink: (item: BacklogItem, link: BacklogItemLink) => void
  setStatus: (item: BacklogItem, status: BacklogItemStatus) => void
  setDifficulty: (item: BacklogItem, value: DifficultyChoice) => void
  setCriticality: (item: BacklogItem, value: CriticalityChoice) => void
  setRisk: (item: BacklogItem, value: RiskChoice) => void
  // Assign the item to an epic (slug) or clear its `epic:` frontmatter (null).
  setEpic: (item: BacklogItem, slug: string | null) => void
  // Rewrite the item's full `dependsOn:` slug list (null clears the line). The
  // menu and detail editor compute the next set with toggleDependencySlug.
  setDependencies: (item: BacklogItem, slugs: string[] | null) => void
  // Prompt for a title, create `backlog/epics/<slug>.md`, then assign the item.
  createEpic: (item: BacklogItem) => void
  // Set (or clear) an epic's identity colour — writes the epic file's `color:`
  // frontmatter. Epic-only; ignored for leaf items by the surfaces that call it.
  setEpicColor: (item: BacklogItem, color: BacklogHighlightColor | null) => void
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
  epicChoices,
  dependencyChoices,
  itemActions,
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
  // Existing epics this item can be moved into (excludes the item itself).
  epicChoices: ReadonlyArray<BacklogEpicChoice>
  // Items this one can declare as prerequisites (self filtered out below).
  dependencyChoices: ReadonlyArray<BacklogDependencyChoice>
  // Module-contributed actions resolved for this exact row. This keeps Run a
  // Sprint/Open Sprint on the same eligibility and execution path as detail.
  itemActions: ReadonlyArray<BacklogContextItemAction>
  agentTargets: Array<AgentState & { cliSessionId: string }>
  agentSessions: TerminalSessionSnapshot[] | null
  onFlyoutOpen: () => void
  onSendToAgent: (item: BacklogItem, sessionId: string) => void
  onClose: () => void
}): JSX.Element {
  const starred = item.highlight?.starred === true
  const currentColor = item.highlight?.color ?? null
  const archived = item.status === 'archived'
  // Prerequisite editing: the item's current `dependsOn` slugs (for the checks)
  // and the candidate items it may depend on (every other non-epic item).
  const dependsOn = item.dependsOn ?? []
  const dependencyCandidates = dependencyChoices.filter((candidate) => candidate.id !== item.id)

  return (
    <ContextMenu
      x={x}
      y={y}
      ariaLabel={`Backlog item actions: ${item.title}`}
      onClose={onClose}
      surfaceClassName="min-w-[240px]"
    >
      {itemActions.map((itemAction) => (
        <MenuItem
          key={itemAction.id}
          disabled={itemAction.disabled}
          onClick={() => {
            itemAction.run()
            onClose()
          }}
        >
          {itemAction.label}
        </MenuItem>
      ))}
      {itemActions.length > 0 ? <MenuDivider /> : null}
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
      {/* Epic membership is the child's `epic:` frontmatter; an epic can't nest
          inside another epic, so the affordance is hidden on epic rows. */}
      {!item.isEpic ? (
        <MenuFlyoutItem label="Move to epic" ariaLabel="Move to epic" surfaceClassName="min-w-[19rem]">
          <BacklogItemSearchPicker
            options={epicChoices.map((epic) => ({
              id: epic.slug,
              value: epic.slug,
              title: epic.title,
              displayId: epic.displayId,
              searchText: epic.slug,
            }))}
            selectedValues={item.epic ? [item.epic] : []}
            ariaLabel="Search epics"
            placeholder="Search epic ID or name…"
            noOptionsMessage="No epics yet."
            onSelect={(epic) => {
              actions.setEpic(item, epic.value)
              onClose()
            }}
          />
          <MenuDivider />
          <MenuItem
            onClick={() => {
              actions.createEpic(item)
              onClose()
            }}
          >
            New epic…
          </MenuItem>
          {item.epic ? (
            <MenuItem
              onClick={() => {
                actions.setEpic(item, null)
                onClose()
              }}
            >
              Remove from epic
            </MenuItem>
          ) : null}
        </MenuFlyoutItem>
      ) : null}
      {/* Prerequisites are the dependent-side `dependsOn:` frontmatter. The
          flyout is a multi-select: each row toggles one slug and the menu stays
          open (like the highlight swatches) so several can be set in a row;
          checks reflect the current set. Hidden on epics, mirroring Move to
          epic. */}
      {!item.isEpic ? (
        <MenuFlyoutItem label="Depends on…" ariaLabel="Set prerequisites" surfaceClassName="min-w-[19rem]">
          <BacklogItemSearchPicker
            options={dependencyCandidates.map((candidate) => ({
              id: candidate.id,
              value: candidate.slug,
              title: candidate.title,
              displayId: candidate.displayId,
              searchText: candidate.slug,
            }))}
            selectedValues={dependsOn}
            ariaLabel="Search prerequisite items"
            noOptionsMessage="No other items."
            multiple
            onSelect={(candidate) => {
              const next = toggleDependencySlug(dependsOn, candidate.value)
              actions.setDependencies(item, next.length > 0 ? next : null)
            }}
          />
          {dependsOn.length > 0 ? (
            <>
              <MenuDivider />
              <MenuItem
                onClick={() => {
                  actions.setDependencies(item, null)
                  onClose()
                }}
              >
                Clear prerequisites
              </MenuItem>
            </>
          ) : null}
        </MenuFlyoutItem>
      ) : null}
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
        item.isEpic ? (
          // Archiving an epic rolls up its children (archive each, then the epic)
          // so the Archived lens shows the epic as one unit, not N loose rows.
          <MenuItem
            onClick={() => {
              actions.archiveEpic(item)
              onClose()
            }}
          >
            Archive epic
          </MenuItem>
        ) : (
          <MenuItem
            onClick={() => {
              actions.archive(item)
              onClose()
            }}
          >
            Archive
          </MenuItem>
        )
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
