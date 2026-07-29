// The detail pane's SECOND mode (MC-1923, mockup v2 frame 2): `Add work` swaps
// the same slot to the cross-project backlog you drag from. One back chevron
// returns to the step's details. Never a fourth column.
//
// It renders every project's backlog through the SAME components the Backlog
// surfaces use — InboxSearchInput + BacklogFilterMenu over the shared triage
// logic, epic grouping and BacklogRowContent/BacklogEpicHeaderContent rows — so
// filtering, sorting and status reading here work exactly like the Backlog.
// Source-specific behaviour on top: a row drags into the plan column (or
// click/Enter adds it to the first track), and placed work DIMS rather than
// disappearing, so the author always sees the whole backlog.
//
// `buildLibraryGroupModels` moved here from the since-retired RoadmapEditorPanel
// (MC-1926); it is pure, so the grouping stays unit-testable without a DOM.

import { useMemo, useState } from 'react'

import { InboxSearchInput, TruncatedText, type SelectItem } from '../../ui'
import { FOCUS_RING_CLASS } from '../../ui/tokens'
import { BacklogEpicHeaderContent, BacklogRowContent } from '../../backlog/BacklogRow'
import { BacklogFilterMenu } from '../../backlog/BacklogFilterMenu'
import { authoredRef, type RoadmapProjectItems } from '../../backlog/roadmapAuthoring'
import { epicProgressBySlug, groupItemsByEpic, type BacklogEpicGroup } from '../../../utils/backlogEpics'
import {
  compareBacklogItems,
  matchesBacklogView,
  type BacklogSort,
  type BacklogView,
} from '../../../utils/backlogTriage'
import { isRoadmapContent } from '../../../../../shared/backlog/roadmap'
import type { BacklogItem } from '../../../utils/backlog'

// The lens/sort option lists — the Backlog door's labels, restated over the same
// shared triage behaviour (matchesBacklogView / compareBacklogItems).
const VIEW_ITEMS: SelectItem<BacklogView>[] = [
  { value: 'active', label: 'Active' },
  { value: 'all', label: 'All items' },
  { value: 'epics', label: 'Epics' },
  { value: 'quick_wins', label: 'Quick wins' },
  { value: 'strategic_bets', label: 'Strategic bets' },
  { value: 'defer', label: 'Defer candidates' },
  { value: 'unestimated', label: 'Unestimated' },
  { value: 'completed', label: 'Completed' },
  { value: 'archived', label: 'Archived' },
]

const SORT_ITEMS: SelectItem<BacklogSort>[] = [
  { value: 'best', label: 'Best' },
  { value: 'recent', label: 'Recently updated' },
  { value: 'created', label: 'Recently created' },
  { value: 'status', label: 'Status' },
  { value: 'priority', label: 'Priority' },
  { value: 'largest', label: 'Largest first' },
  { value: 'smallest', label: 'Smallest first' },
]

// One epic (or loose-items) group of a project's backlog, resolved for this
// pane: the shared BacklogEpicGroup plus each row's authored ref + placed flag.
export type LibraryGroupModel = {
  key: string
  group: BacklogEpicGroup
  // The epic header's authored ref (an epic is added as ONE step), null for the
  // loose-items bucket and dangling-slug groups.
  headerRef: string | null
  headerPlanned: boolean
  children: Array<{ item: BacklogItem; ref: string; planned: boolean }>
}

// Build one project's groups: horizon files out, the lens + search applied, epic
// grouping via the shared groupItemsByEpic, children sorted by the shared
// comparator. Pure so it stays unit-testable without a DOM.
export function buildLibraryGroupModels(
  project: RoadmapProjectItems,
  plannedRefs: ReadonlySet<string>,
  query: string,
  view: BacklogView,
  sort: BacklogSort,
): LibraryGroupModel[] {
  const items = project.items.filter((item) => !isRoadmapContent(item.relativePath, item.rawType))
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const matchesQuery = (item: BacklogItem): boolean =>
    terms.every((term) => `${item.title} ${item.displayId ?? ''} ${item.relativePath}`.toLowerCase().includes(term))
  const refOf = (item: BacklogItem): string => authoredRef(project.projectKey, item.relativePath)

  const models: LibraryGroupModel[] = []
  for (const group of groupItemsByEpic(items)) {
    const epic = group.epic
    const headerRef = epic ? refOf(epic) : null
    const headerPlanned = headerRef !== null && plannedRefs.has(headerRef)
    const epicVisible = epic !== null && matchesBacklogView(epic, view)
    const epicMatchesQuery = epic !== null && matchesQuery(epic)
    // A matching epic shows all its (lens-visible) members; otherwise members
    // must match the query themselves.
    let children = group.children.filter((child) => matchesBacklogView(child, view))
    if (terms.length > 0 && !epicMatchesQuery) children = children.filter(matchesQuery)
    children.sort((a, b) => compareBacklogItems(a, b, sort))
    const keepHeader = epicVisible && (terms.length === 0 || epicMatchesQuery || children.length > 0)
    if (!keepHeader && children.length === 0) continue
    models.push({
      key: `${project.projectKey ?? '(home)'}::${group.slug ?? '(none)'}::${group.kind}`,
      group,
      headerRef,
      headerPlanned,
      children: children.map((item) => ({
        item,
        ref: refOf(item),
        // A member of a placed epic rides that step — it dims with its epic.
        planned: plannedRefs.has(refOf(item)) || headerPlanned,
      })),
    })
  }
  // Epic groups order by their epic under the same sort; the loose-items bucket
  // always trails so named work leads the scan.
  models.sort((a, b) => {
    const aNone = a.group.kind === 'none' ? 1 : 0
    const bNone = b.group.kind === 'none' ? 1 : 0
    if (aNone !== bNone) return aNone - bNone
    if (a.group.epic && b.group.epic) return compareBacklogItems(a.group.epic, b.group.epic, sort)
    return a.group.title.localeCompare(b.group.title)
  })
  return models
}

export function HorizonBacklogSource({
  projects,
  plannedRefs,
  canAdd,
  onClose,
  onAdd,
  onDragStart,
  onDragEnd,
}: {
  projects: ReadonlyArray<RoadmapProjectItems>
  /** Refs already in the plan — those rows dim and stop being draggable. */
  plannedRefs: ReadonlySet<string>
  /** False when the plan has no track yet — nothing can be added. */
  canAdd: boolean
  onClose: () => void
  onAdd: (ref: string) => void
  onDragStart: (ref: string) => void
  onDragEnd: () => void
}): JSX.Element {
  const [query, setQuery] = useState('')
  // The default 'active' lens hides completed/archived work — finished epics are
  // not plannable and only clutter the list.
  const [view, setView] = useState<BacklogView>('active')
  const [sort, setSort] = useState<BacklogSort>('best')
  const [collapsedProjects, setCollapsedProjects] = useState<ReadonlySet<string>>(() => new Set())
  const [expandedEpics, setExpandedEpics] = useState<ReadonlySet<string>>(() => new Set())
  const now = useMemo(() => Date.now(), [])

  const toggle = (set: ReadonlySet<string>, key: string): Set<string> => {
    const next = new Set(set)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    return next
  }

  return (
    <section aria-label="Backlog" className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-[color:var(--bg-surface)]">
      <div className="flex shrink-0 items-center gap-2 px-4 pt-3">
        <button
          type="button"
          onClick={onClose}
          aria-label="Back to the step"
          className={`interactive -ml-1 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-[color:var(--text-muted)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)] ${FOCUS_RING_CLASS}`}
        >
          <svg viewBox="0 0 16 16" fill="none" className="icon-xs" aria-hidden="true">
            <path d="M10 4L6 8l4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <h3 className="text-[13px] font-semibold text-[color:var(--text-strong)]">Backlog</h3>
      </div>
      <div className="flex shrink-0 items-center gap-1.5 px-4 py-2.5">
        <InboxSearchInput
          value={query}
          onChange={setQuery}
          placeholder="Search every project…"
          ariaLabel="Search every project’s backlog"
        />
        <BacklogFilterMenu
          view={view}
          sort={sort}
          group="by_epic"
          viewItems={VIEW_ITEMS}
          sortItems={SORT_ITEMS}
          groupItems={[]}
          onViewChange={setView}
          onSortChange={setSort}
          onGroupChange={() => undefined}
          defaultView="active"
          defaultSort="best"
          defaultGroup="by_epic"
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pb-2">
        {projects.map((project) => (
          <SourceProjectSection
            key={project.projectKey ?? '(home)'}
            project={project}
            plannedRefs={plannedRefs}
            query={query}
            view={view}
            sort={sort}
            canAdd={canAdd}
            now={now}
            collapsed={collapsedProjects.has(project.projectKey ?? '(home)')}
            onToggleCollapsed={() =>
              setCollapsedProjects((set) => toggle(set, project.projectKey ?? '(home)'))
            }
            expandedEpics={expandedEpics}
            onToggleEpic={(key) => setExpandedEpics((set) => toggle(set, key))}
            onAdd={onAdd}
            onDragStart={onDragStart}
            onDragEnd={onDragEnd}
          />
        ))}
      </div>

      <p className="shrink-0 border-t border-[color:var(--border-subtle)] px-4 pb-2.5 pt-2 text-[11px] leading-4 text-[color:var(--text-subtle)]">
        Placed work is dimmed. Drag an epic in to deliver all of its items as one step.
      </p>
    </section>
  )
}

function SourceProjectSection({
  project,
  plannedRefs,
  query,
  view,
  sort,
  canAdd,
  now,
  collapsed,
  onToggleCollapsed,
  expandedEpics,
  onToggleEpic,
  onAdd,
  onDragStart,
  onDragEnd,
}: {
  project: RoadmapProjectItems
  plannedRefs: ReadonlySet<string>
  query: string
  view: BacklogView
  sort: BacklogSort
  canAdd: boolean
  now: number
  collapsed: boolean
  onToggleCollapsed: () => void
  expandedEpics: ReadonlySet<string>
  onToggleEpic: (key: string) => void
  onAdd: (ref: string) => void
  onDragStart: (ref: string) => void
  onDragEnd: () => void
}): JSX.Element | null {
  const groups = useMemo(
    () => buildLibraryGroupModels(project, plannedRefs, query, view, sort),
    [project, plannedRefs, query, view, sort],
  )
  const progressBySlug = useMemo(() => epicProgressBySlug([...project.items]), [project.items])
  const rowCount = groups.reduce((sum, model) => sum + model.children.length + (model.headerRef ? 1 : 0), 0)
  // A project with nothing under the current lens/search drops out entirely —
  // never an empty header the author must scroll past.
  if (rowCount === 0) return null
  return (
    <section aria-label={`${project.projectName} backlog`} className="min-w-0">
      <button
        type="button"
        onClick={onToggleCollapsed}
        aria-expanded={!collapsed}
        className={`interactive sticky top-0 z-10 flex h-7 w-full min-w-0 items-center gap-1.5 border-b border-[color:var(--border-subtle)] bg-[color:var(--bg-surface)] px-4 text-left hover:bg-[color:var(--bg-hover)] ${FOCUS_RING_CLASS}`}
      >
        <ChevronGlyph open={!collapsed} />
        <TruncatedText
          as="span"
          text={project.projectName}
          className="min-w-0 flex-1 text-[12px] font-semibold text-[color:var(--text-strong)]"
        />
        <span className="shrink-0 text-[11px] tabular-nums text-[color:var(--text-disabled)]">{rowCount}</span>
      </button>
      {collapsed ? null : (
        <ul className="flex flex-col py-0.5">
          {groups.map((model) => {
            const epicExpanded = expandedEpics.has(model.key)
            return (
              <li key={model.key} className="min-w-0">
                {model.group.kind !== 'none' ? (
                  <SourceEpicHeader
                    model={model}
                    collapsed={!epicExpanded}
                    progress={model.group.slug ? progressBySlug.get(model.group.slug) : undefined}
                    canAdd={canAdd}
                    onToggle={() => onToggleEpic(model.key)}
                    onAdd={onAdd}
                    onDragStart={onDragStart}
                    onDragEnd={onDragEnd}
                  />
                ) : null}
                {model.group.kind === 'none' || epicExpanded ? (
                  <ul className={model.group.kind === 'none' ? '' : 'pb-0.5'}>
                    {model.children.map((child) => (
                      <SourceItemRow
                        key={child.ref}
                        item={child.item}
                        itemRef={child.ref}
                        planned={child.planned}
                        indented={model.group.kind !== 'none'}
                        canAdd={canAdd}
                        now={now}
                        onAdd={onAdd}
                        onDragStart={onDragStart}
                        onDragEnd={onDragEnd}
                      />
                    ))}
                  </ul>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

// An epic group header, made a plan affordance — click/Enter adds the epic as
// ONE step, drag carries it into a track.
function SourceEpicHeader({
  model,
  collapsed,
  progress,
  canAdd,
  onToggle,
  onAdd,
  onDragStart,
  onDragEnd,
}: {
  model: LibraryGroupModel
  collapsed: boolean
  progress: { done: number; total: number } | undefined
  canAdd: boolean
  onToggle: () => void
  onAdd: (ref: string) => void
  onDragStart: (ref: string) => void
  onDragEnd: () => void
}): JSX.Element {
  const addable = model.headerRef !== null && !model.headerPlanned && canAdd
  return (
    <div
      role="button"
      tabIndex={addable ? 0 : -1}
      aria-label={
        model.headerPlanned
          ? `${model.group.title} — already in the plan`
          : `Add the epic ${model.group.title} to the plan as one step`
      }
      aria-disabled={!addable}
      draggable={addable}
      onDragStart={(event) => {
        if (!model.headerRef) return
        // 'copy': the backlog keeps its item. The plan column's drop target
        // matches this effect exactly — a mismatch makes the browser mark the
        // target invalid and never fire `drop`.
        event.dataTransfer.effectAllowed = 'copy'
        event.dataTransfer.setData('text/plain', model.headerRef)
        onDragStart(model.headerRef)
      }}
      onDragEnd={onDragEnd}
      onClick={() => {
        if (addable && model.headerRef) onAdd(model.headerRef)
      }}
      onKeyDown={(event) => {
        if ((event.key === 'Enter' || event.key === ' ') && addable && model.headerRef) {
          event.preventDefault()
          onAdd(model.headerRef)
        } else if (event.key === 'ArrowRight' && collapsed) {
          event.preventDefault()
          onToggle()
        } else if (event.key === 'ArrowLeft' && !collapsed) {
          event.preventDefault()
          onToggle()
        }
      }}
      className={`px-4 py-1 transition-colors ${
        model.headerPlanned ? 'opacity-40' : 'cursor-grab hover:bg-[color:var(--bg-hover)]'
      }`}
    >
      <BacklogEpicHeaderContent
        group={model.group}
        collapsed={collapsed}
        onToggleCollapse={onToggle}
        progress={progress}
      />
    </div>
  )
}

// One addable item row: the shared Backlog row content inside an add button.
function SourceItemRow({
  item,
  itemRef,
  planned,
  indented,
  canAdd,
  now,
  onAdd,
  onDragStart,
  onDragEnd,
}: {
  item: BacklogItem
  itemRef: string
  planned: boolean
  indented: boolean
  canAdd: boolean
  now: number
  onAdd: (ref: string) => void
  onDragStart: (ref: string) => void
  onDragEnd: () => void
}): JSX.Element {
  const addable = !planned && canAdd
  return (
    <li
      draggable={addable}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = 'copy'
        event.dataTransfer.setData('text/plain', itemRef)
        onDragStart(itemRef)
      }}
      onDragEnd={onDragEnd}
      className="min-w-0 list-none"
    >
      <button
        type="button"
        disabled={!addable}
        onClick={() => onAdd(itemRef)}
        aria-label={planned ? `${item.title} — already in the plan` : `Add ${item.title} to the plan`}
        className={`interactive block w-full text-left ${indented ? 'pl-7 pr-4' : 'px-4'} py-1 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[color:var(--border-focus)] ${
          planned ? 'opacity-40' : 'cursor-grab hover:bg-[color:var(--bg-hover)]'
        }`}
      >
        <BacklogRowContent item={item} now={now} plainTitle />
      </button>
    </li>
  )
}

function ChevronGlyph({ open }: { open: boolean }): JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      className={`icon-xs shrink-0 transition-transform ${open ? 'rotate-90' : ''}`}
    >
      <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
