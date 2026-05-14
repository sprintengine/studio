import React, { useId, useMemo, useState } from 'react'
import { useWorkspaceStore } from '../../store/workspaceStore'
import {
  LEARNING_CATEGORY_LABELS,
  type LearningAction,
  type LearningCategory,
  type LearningItem,
} from '../../content/learning/types'
import { searchLearningItems } from '../../content/learning/selectors'
import { resolveProjectKnowledgeConfig } from '../../utils/projectKnowledge'
import { GhostButton, Switch, Tabs, type TabItem } from '../ui'

type LearnCenterProps = {
  onSettingsTab?: (tabId: string) => void
}

const EMPTY_PROJECT_KNOWLEDGE_ROOTS: Record<string, string | null> = {}

type CategoryFilter = LearningCategory | 'all'

const CATEGORY_FILTERS: ReadonlyArray<TabItem<CategoryFilter>> = [
  { id: 'all', label: 'All' },
  { id: 'workspace', label: LEARNING_CATEGORY_LABELS.workspace },
  { id: 'agents', label: LEARNING_CATEGORY_LABELS.agents },
  { id: 'sprintengine', label: LEARNING_CATEGORY_LABELS.sprintengine },
  { id: 'switchboard', label: LEARNING_CATEGORY_LABELS.switchboard },
  { id: 'knowledge', label: LEARNING_CATEGORY_LABELS.knowledge },
  { id: 'local-safety', label: LEARNING_CATEGORY_LABELS['local-safety'] },
]

export default function LearnCenter({ onSettingsTab }: LearnCenterProps) {
  const activeWorkspace = useWorkspaceStore((s) =>
    s.workspaces.find((workspace) => workspace.id === s.activeWorkspaceId) ?? null
  )
  const projectKnowledgeRoots = useWorkspaceStore((s) => s.appSettings.projectKnowledgeRoots ?? EMPTY_PROJECT_KNOWLEDGE_ROOTS)
  const learning = useWorkspaceStore((s) => s.appSettings.learning)
  const setLearningShowTipsOnStartup = useWorkspaceStore((s) => s.setLearningShowTipsOnStartup)
  const markLearningLessonCompleted = useWorkspaceStore((s) => s.markLearningLessonCompleted)
  const resetLearningProgress = useWorkspaceStore((s) => s.resetLearningProgress)

  const knowledgeConfig = resolveProjectKnowledgeConfig(
    activeWorkspace?.folderPath,
    projectKnowledgeRoots,
    activeWorkspace?.memory?.relativeRoot
  )

  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<CategoryFilter>('all')
  const searchInputId = useId()
  const startupSwitchId = useId()

  const context = useMemo(
    () => ({
      activeWorkspace,
      hasAnyTerminal: false,
      hasKnowledgeRoot: Boolean(knowledgeConfig?.relativeRoot),
    }),
    [activeWorkspace, knowledgeConfig?.relativeRoot]
  )

  const items = useMemo(
    () => searchLearningItems({ query, category, context }),
    [query, category, context]
  )

  const completedSet = useMemo(
    () => new Set(learning?.completedLessonIds ?? []),
    [learning?.completedLessonIds]
  )
  const completedCount = items.reduce((count, item) => count + (completedSet.has(item.id) ? 1 : 0), 0)

  const runAction = (action: LearningAction) => {
    switch (action.kind) {
      case 'open-settings-tab':
        if (action.args?.tab && onSettingsTab) onSettingsTab(action.args.tab)
        return
      case 'open-url':
        if (action.args?.url) window.open(action.args.url, '_blank', 'noopener,noreferrer')
        return
      case 'open-learn-center':
        return
    }
  }

  const showOnStartup = learning?.showTipsOnStartup ?? true

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <label
            htmlFor={searchInputId}
            className="text-[12px] font-medium text-[color:var(--text-default)]"
          >
            Search
          </label>
          <input
            id={searchInputId}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter tips by title or summary"
            className="h-9 w-full rounded-md border border-[color:var(--border-default)] bg-[color:var(--bg-surface)] px-3 text-[13px] text-[color:var(--text-strong)] outline-none transition-colors placeholder:text-[color:var(--text-disabled)] focus:border-[color:var(--border-focus)]"
          />
        </div>
        <div className="flex shrink-0 items-center gap-3 self-end">
          <div className="flex items-center gap-2">
            <Switch
              id={startupSwitchId}
              checked={showOnStartup}
              onChange={setLearningShowTipsOnStartup}
              ariaLabelledBy={`${startupSwitchId}-label`}
            />
            <label
              id={`${startupSwitchId}-label`}
              htmlFor={startupSwitchId}
              className="text-[12px] text-[color:var(--text-muted)]"
            >
              Show on startup
            </label>
          </div>
          <GhostButton onClick={() => resetLearningProgress()}>Reset progress</GhostButton>
        </div>
      </div>

      <Tabs<CategoryFilter>
        ariaLabel="Learning categories"
        items={CATEGORY_FILTERS as TabItem<CategoryFilter>[]}
        value={category}
        onChange={setCategory}
        idPrefix="learn-center-category"
      />

      <div className="text-[12px] text-[color:var(--text-muted)] tabular-nums">
        {items.length} {items.length === 1 ? 'tip' : 'tips'} · {completedCount} marked done
      </div>

      {items.length === 0 ? (
        <div className="rounded-md border border-[color:var(--border-default)] bg-[color:var(--bg-surface)] px-4 py-6 text-center text-[12px] text-[color:var(--text-muted)]">
          {query.trim()
            ? `No tips match "${query.trim()}" in ${category === 'all' ? 'any category' : LEARNING_CATEGORY_LABELS[category as LearningCategory]}.`
            : 'No tips available for this category yet.'}
        </div>
      ) : (
        <ul className="space-y-2">
          {items.map((item) => (
            <LearningRow
              key={item.id}
              item={item}
              completed={completedSet.has(item.id)}
              onToggleComplete={(next) => markLearningLessonCompleted(item.id, next)}
              onAction={runAction}
            />
          ))}
        </ul>
      )}
    </div>
  )
}

type LearningRowProps = {
  item: LearningItem
  completed: boolean
  onToggleComplete: (next: boolean) => void
  onAction: (action: LearningAction) => void
}

function LearningRow({ item, completed, onToggleComplete, onAction }: LearningRowProps) {
  const switchId = useId()
  return (
    <li
      className={`rounded-md border bg-[color:var(--bg-surface)] px-3.5 py-3 transition-colors ${
        completed
          ? 'border-[color:var(--accent-primary-soft-strong)]'
          : 'border-[color:var(--border-default)] hover:bg-[color:var(--bg-surface-raised)]'
      }`}
    >
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h4 className="truncate text-[13px] font-semibold text-[color:var(--text-strong)]">
              {item.title}
            </h4>
            <span className="rounded-full border border-[color:var(--border-default)] bg-[color:var(--bg-app)] px-1.5 py-px text-[11px] font-medium text-[color:var(--text-muted)]">
              {LEARNING_CATEGORY_LABELS[item.category]}
            </span>
          </div>
          <p className="mt-1 text-[12px] leading-5 text-[color:var(--text-muted)]">{item.summary}</p>
          {item.body ? (
            <p className="mt-2 text-[12px] leading-5 text-[color:var(--text-subtle)]">{item.body}</p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-3">
          {item.action ? (
            <GhostButton onClick={() => onAction(item.action!)}>{item.action.label}</GhostButton>
          ) : null}
          <div className="flex items-center gap-2">
            <Switch
              id={switchId}
              checked={completed}
              onChange={onToggleComplete}
              ariaLabelledBy={`${switchId}-label`}
            />
            <label
              id={`${switchId}-label`}
              htmlFor={switchId}
              className="text-[12px] text-[color:var(--text-muted)]"
            >
              Done
            </label>
          </div>
        </div>
      </div>
    </li>
  )
}
