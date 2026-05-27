import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { InboxSearchInput, Section, SidePane } from '../../ui'
import { isEditableTarget } from '../../../utils/keyboard'
import { getSprintEngineArtifactDependencyBlockers } from '../../../utils/sprintengine'
import type { SprintEngineArtifact, SprintEngineState } from '../../../types/workspace'
import {
  getSprintEngineInboxArtifacts,
  sprintEngineInboxEmptyMessage,
} from '../sprintEngineInspector'
import { SprintEngineInboxRow, SprintEngineBlockedByRow } from '../SprintEngineInspectorPanel'
import { SprintEngineEmptyDetail } from './SprintEngineEmptyDetail'

// Inbox tab: list + detail. The artifact queue sits in the primary content
// column on the left; the inspector fills the remaining width when something
// is selected, and a quiet empty state when not. This matches Watchtower's
// two-pane chrome — the roster lives on its own tab now, so the right pane
// never has to compete for width with a third column. The "Inbox · N"
// header and search live inside the list pane so the active tab carries
// its own identity (the panel-wide hero shows run status, not list state).
export function SprintEngineInboxView({
  sprintEngineState,
  reviewArtifacts,
  runPhase,
  selectedArtifactId,
  onSelectArtifact,
  onSelectTask,
  inspectorContent,
  inspectorExpanded,
}: {
  sprintEngineState: SprintEngineState
  reviewArtifacts: SprintEngineArtifact[]
  runPhase: string
  selectedArtifactId: string | null
  onSelectArtifact: (artifactId: string | null) => void
  onSelectTask: (taskId: string) => void
  inspectorContent: React.ReactNode
  inspectorExpanded: boolean
}) {
  const tasksById = useMemo(
    () => Object.fromEntries(sprintEngineState.tasks.map((task) => [task.id, task])),
    [sprintEngineState.tasks]
  )
  const inboxArtifacts = useMemo(
    () => getSprintEngineInboxArtifacts(reviewArtifacts),
    [reviewArtifacts]
  )
  const [search, setSearch] = useState('')
  const visibleArtifacts = useMemo(() => {
    const query = search.trim().toLowerCase()
    if (!query) return inboxArtifacts
    return inboxArtifacts.filter((artifact) => {
      const task = tasksById[artifact.taskId]
      const haystack = [
        artifact.id,
        artifact.title,
        artifact.kind,
        artifact.createdBy,
        task?.id,
        task?.title,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
      return haystack.includes(query)
    })
  }, [inboxArtifacts, search, tasksById])
  const blockedByArtifacts = useMemo(() => (
    sprintEngineState.tasks
      .map((task) => ({
        task,
        blockers: getSprintEngineArtifactDependencyBlockers(task, sprintEngineState.tasks, reviewArtifacts),
      }))
      .filter(({ blockers }) => blockers.length > 0)
  ), [reviewArtifacts, sprintEngineState.tasks])

  const inboxEmptyMessage = sprintEngineInboxEmptyMessage(runPhase)
  const filteringActive = search.trim().length > 0
  const emptyMessage =
    filteringActive && inboxArtifacts.length > 0
      ? 'No inbox artifacts match the current search.'
      : inboxEmptyMessage

  // Drop a selection when the search has filtered it out so the inspector
  // never shows an artifact that isn't visible in the list.
  useEffect(() => {
    if (selectedArtifactId && !visibleArtifacts.some((artifact) => artifact.id === selectedArtifactId)) {
      onSelectArtifact(null)
    }
  }, [selectedArtifactId, visibleArtifacts, onSelectArtifact])
  const handleInboxKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (isEditableTarget(event.target)) return
      if (visibleArtifacts.length === 0) return
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        const currentIndex = selectedArtifactId
          ? visibleArtifacts.findIndex((artifact) => artifact.id === selectedArtifactId)
          : -1
        const delta = event.key === 'ArrowDown' ? 1 : -1
        let nextIndex: number
        if (currentIndex === -1) {
          nextIndex = event.key === 'ArrowDown' ? 0 : visibleArtifacts.length - 1
        } else {
          nextIndex = (currentIndex + delta + visibleArtifacts.length) % visibleArtifacts.length
        }
        onSelectArtifact(visibleArtifacts[nextIndex].id)
        return
      }
      if (event.key === 'Home') {
        event.preventDefault()
        onSelectArtifact(visibleArtifacts[0].id)
        return
      }
      if (event.key === 'End') {
        event.preventDefault()
        onSelectArtifact(visibleArtifacts[visibleArtifacts.length - 1].id)
        return
      }
      if (event.key === 'Escape' && selectedArtifactId) {
        event.preventDefault()
        onSelectArtifact(null)
      }
    },
    [visibleArtifacts, onSelectArtifact, selectedArtifactId]
  )

  const hasInspector = inspectorContent !== null && inspectorContent !== undefined

  return (
    <div className="flex min-h-0 flex-1 min-w-0">
      {inspectorExpanded ? null : (
        <SidePane as="section" side="left" width="lg" ariaLabel="Inbox">
          <div className="flex shrink-0 items-center gap-2 border-b border-[color:var(--border-default)] px-3 py-2">
            <InboxSearchInput
              value={search}
              onChange={setSearch}
              ariaLabel="Search inbox artifacts"
            />
          </div>
          <div className="flex flex-1 flex-col overflow-auto">
            <div
              tabIndex={0}
              onKeyDown={handleInboxKeyDown}
              className="focus:outline-none"
              role="region"
              aria-label="Inbox artifacts (use arrow keys)"
            >
              {visibleArtifacts.length === 0 ? (
                <div className="px-3 py-6 text-[12px] leading-5 text-[color:var(--text-muted)]">
                  {emptyMessage}
                </div>
              ) : (
                <ul>
                  {visibleArtifacts.map((artifact) => (
                    <li key={artifact.id}>
                      <SprintEngineInboxRow
                        artifact={artifact}
                        task={tasksById[artifact.taskId]}
                        selected={selectedArtifactId === artifact.id}
                        onSelect={() => onSelectArtifact(artifact.id)}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {blockedByArtifacts.length > 0 ? (
              <div role="region" aria-label="Tasks blocked by review">
                <Section
                  title="Blocked by review"
                  count={blockedByArtifacts.length}
                  level={3}
                  inset={false}
                  className="border-t border-[color:var(--border-default)]"
                >
                  <ul>
                    {blockedByArtifacts.map(({ task, blockers }) => (
                      <li key={task.id}>
                        <SprintEngineBlockedByRow
                          task={task}
                          blockers={blockers}
                          selected={false}
                          onSelect={() => onSelectTask(task.id)}
                        />
                      </li>
                    ))}
                  </ul>
                </Section>
              </div>
            ) : null}
          </div>
        </SidePane>
      )}

      {hasInspector ? (
        <section
          className="flex min-w-0 flex-1 flex-col"
          aria-label="Selected item detail"
        >
          {inspectorContent}
        </section>
      ) : (
        <SprintEngineEmptyDetail
          message={
            inboxArtifacts.length > 0
              ? 'Pick an artifact on the left to review evidence, approve, or request changes.'
              : 'Nothing is queued for review. New artifacts land here as workers finish and reviewers gate them.'
          }
        />
      )}
    </div>
  )
}
