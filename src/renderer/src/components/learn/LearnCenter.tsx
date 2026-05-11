import React, { useMemo, useState } from 'react'
import { useWorkspaceStore } from '../../store/workspaceStore'
import {
  LEARNING_CATEGORY_LABELS,
  type LearningAction,
  type LearningCategory,
  type LearningItem,
} from '../../content/learning/types'
import { searchLearningItems } from '../../content/learning/selectors'
import { resolveProjectKnowledgeConfig } from '../../utils/projectKnowledge'

type LearnCenterProps = {
  onSettingsTab?: (tabId: string) => void
}

type CategoryFilter = LearningCategory | 'all'

const CATEGORY_FILTERS: ReadonlyArray<{ id: CategoryFilter; label: string }> = [
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
  const projectKnowledgeRoots = useWorkspaceStore((s) => s.appSettings.projectKnowledgeRoots ?? {})
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

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="block min-w-0 flex-1">
          <span className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.12em] text-[#9a9aa2]">
            Search
          </span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter tips by title or summary"
            className="h-9 w-full rounded-md border border-[#303139] bg-[#0d0e11] px-3 text-[13px] text-[#ececee] outline-none transition-colors placeholder:text-[#5a5a63] focus:border-[#5c7cff]/70"
          />
        </label>
        <div className="flex shrink-0 items-center gap-2 self-end">
          <label className="flex items-center gap-2 text-[12px] text-[#9a9aa2]">
            <input
              type="checkbox"
              checked={learning?.showTipsOnStartup ?? true}
              onChange={(event) => setLearningShowTipsOnStartup(event.target.checked)}
              className="h-3.5 w-3.5 rounded border-[#303139] bg-[#0d0e11] text-[#5c7cff] focus:ring-1 focus:ring-[#5c7cff]/60"
            />
            Show on startup
          </label>
          <button
            type="button"
            onClick={() => resetLearningProgress()}
            className="rounded-md border border-[#303139] bg-[#0d0e11] px-2.5 py-1 text-[12px] font-semibold text-[#d7d7dc] transition-colors hover:bg-[#17181d]"
          >
            Reset progress
          </button>
        </div>
      </div>

      <div role="tablist" aria-label="Learning categories" className="flex flex-wrap gap-1.5">
        {CATEGORY_FILTERS.map((filter) => {
          const active = filter.id === category
          return (
            <button
              key={filter.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setCategory(filter.id)}
              className={`rounded-md px-2.5 py-1 text-[12px] font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[#5c7cff]/60 ${
                active
                  ? 'border border-[#5c7cff]/35 bg-[#100f1c] text-[#b8ccff]'
                  : 'border border-[#24252b] bg-[#0d0e11] text-[#9a9aa2] hover:bg-[#17181d] hover:text-[#d7d7dc]'
              }`}
            >
              {filter.label}
            </button>
          )
        })}
      </div>

      <div className="text-[11px] uppercase tracking-[0.14em] text-[#5a5a63] tabular-nums">
        {items.length} {items.length === 1 ? 'tip' : 'tips'} · {completedCount} marked done
      </div>

      {items.length === 0 ? (
        <div className="rounded-md border border-[#24252b] bg-[#0d0e11] px-4 py-6 text-center text-[12px] text-[#9a9aa2]">
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
  return (
    <li
      className={`rounded-md border bg-[#0d0e11] px-3.5 py-3 transition-colors ${
        completed ? 'border-[#5c7cff]/35' : 'border-[#16171c] hover:bg-[#111216]'
      }`}
    >
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h4 className="truncate text-[13px] font-semibold text-[#ececee]">{item.title}</h4>
            <span className="rounded-full border border-[#24252b] bg-[#0a0b0e] px-1.5 py-px text-[10px] font-semibold uppercase tracking-[0.12em] text-[#9a9aa2]">
              {LEARNING_CATEGORY_LABELS[item.category]}
            </span>
          </div>
          <p className="mt-1 text-[12px] leading-5 text-[#9a9aa2]">{item.summary}</p>
          {item.body ? (
            <p className="mt-2 text-[12px] leading-5 text-[#7a7a82]">{item.body}</p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {item.action ? (
            <button
              type="button"
              onClick={() => onAction(item.action!)}
              className="rounded-md border border-[#303139] bg-[#0d0e11] px-2.5 py-1 text-[12px] font-semibold text-[#d7d7dc] transition-colors hover:bg-[#17181d]"
            >
              {item.action.label}
            </button>
          ) : null}
          <label className="flex items-center gap-1.5 text-[12px] text-[#9a9aa2]">
            <input
              type="checkbox"
              checked={completed}
              onChange={(event) => onToggleComplete(event.target.checked)}
              className="h-3.5 w-3.5 rounded border-[#303139] bg-[#0d0e11] text-[#5c7cff] focus:ring-1 focus:ring-[#5c7cff]/60"
            />
            Done
          </label>
        </div>
      </div>
    </li>
  )
}
