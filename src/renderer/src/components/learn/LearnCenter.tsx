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
import { GhostButton, IconButton, InboxSearchInput, Switch, Tabs, Tooltip, type TabItem } from '../ui'
import { ResetIcon } from '../AppIcons'

type LearnCenterProps = {
  onSettingsTab?: (tabId: string) => void
}

const EMPTY_PROJECT_KNOWLEDGE_ROOTS: Record<string, string | null> = {}

type CategoryFilter = LearningCategory | 'all'

const CATEGORY_FILTERS: ReadonlyArray<TabItem<CategoryFilter>> = [
  { id: 'all', label: 'All' },
  { id: 'workspace', label: LEARNING_CATEGORY_LABELS.workspace },
  { id: 'agents', label: LEARNING_CATEGORY_LABELS.agents },
  { id: 'guided-brief', label: LEARNING_CATEGORY_LABELS['guided-brief'] },
  { id: 'sprintengine', label: LEARNING_CATEGORY_LABELS.sprintengine },
  { id: 'switchboard', label: LEARNING_CATEGORY_LABELS.switchboard },
  { id: 'git', label: LEARNING_CATEGORY_LABELS.git },
  { id: 'knowledge', label: LEARNING_CATEGORY_LABELS.knowledge },
  { id: 'settings', label: LEARNING_CATEGORY_LABELS.settings },
  { id: 'mobile', label: LEARNING_CATEGORY_LABELS.mobile },
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
      <div className="flex flex-wrap items-center justify-between gap-3">
        {/* The kit's list-search field, as every sibling settings tab uses. This
            hand-rolled an `h-8` box (28px — not a step on the 26/30/34 ramp) on
            the settings well ground, next to tabs drawing the real one
            (MC-2114). The wrapper caps the measure the retired `w-64` set. */}
        <div className="flex w-64 max-w-full">
          <InboxSearchInput
            value={query}
            onChange={setQuery}
            ariaLabel="Search tips"
            placeholder="Search tips"
          />
        </div>
        <div className="flex shrink-0 items-center gap-3">
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
              className="text-meta text-[color:var(--text-muted)]"
            >
              Show on startup
            </label>
          </div>
          <Tooltip content="Reset progress">
            <IconButton aria-label="Reset learning progress" onClick={() => resetLearningProgress()}>
              <ResetIcon className="icon-sm" />
            </IconButton>
          </Tooltip>
        </div>
      </div>

      <Tabs<CategoryFilter>
        ariaLabel="Learning categories"
        items={CATEGORY_FILTERS as TabItem<CategoryFilter>[]}
        value={category}
        onChange={setCategory}
        idPrefix="learn-center-category"
        className="flex-wrap gap-y-1"
      />

      <div className="text-meta text-[color:var(--text-muted)] tabular-nums">
        {items.length} {items.length === 1 ? 'tip' : 'tips'} · {completedCount} marked done
      </div>

      {items.length === 0 ? (
        <p className="py-4 text-meta leading-5 text-[color:var(--text-muted)]">
          {query.trim()
            ? `No tips match "${query.trim()}".`
            : 'No tips here yet.'}
        </p>
      ) : (
        <ul className="divide-y divide-[color:var(--border-subtle)]">
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
    <li className="py-3">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <h4
              className={`truncate text-body font-medium ${
                completed ? 'text-[color:var(--text-muted)]' : 'text-[color:var(--text-strong)]'
              }`}
            >
              {item.title}
            </h4>
            <span className="shrink-0 text-micro text-[color:var(--text-subtle)]">
              {LEARNING_CATEGORY_LABELS[item.category]}
            </span>
          </div>
          <p className="mt-1 text-meta leading-5 text-[color:var(--text-muted)]">{item.summary}</p>
          {item.body ? (
            <p className="mt-2 text-meta leading-5 text-[color:var(--text-subtle)]">{item.body}</p>
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
              className="text-meta text-[color:var(--text-muted)]"
            >
              Done
            </label>
          </div>
        </div>
      </div>
    </li>
  )
}
