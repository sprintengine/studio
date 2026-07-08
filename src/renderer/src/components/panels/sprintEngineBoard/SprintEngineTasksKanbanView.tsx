import type { MouseEvent } from 'react'
import { BoardLane, LifecycleGlyph, TaskCard, Tooltip, type Tone } from '../../ui'
import { SprintEngineRoleIcon } from '../../AppIcons'
import type { SprintEngineState, SprintEngineTask, SprintEngineTaskBoardColumn } from '../../../types/workspace'
import {
  getSprintEngineKanbanEmptyMessage,
  getSprintEngineRoleAccent,
  getSprintEngineRoleLabel,
  getSprintEngineTaskBoardColumn,
  taskBoardColumnToLifecycle,
} from '../../../utils/sprintengine'

export type SprintEngineTasksKanbanColumn = {
  key: SprintEngineTaskBoardColumn
  label: string
  cards: SprintEngineState['tasks']
}

type Props = {
  sprintEngineState: SprintEngineState
  boardColumns: SprintEngineTasksKanbanColumn[]
  selectedTaskId: string | null
  onSelectTask: (taskId: string) => void
  onTaskContextMenu?: (event: MouseEvent, task: SprintEngineTask) => void
  recentlyMovedTaskIds: ReadonlySet<string>
}

export function SprintEngineTasksKanbanView({
  sprintEngineState,
  boardColumns,
  selectedTaskId,
  onSelectTask,
  onTaskContextMenu,
  recentlyMovedTaskIds,
}: Props) {
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="flex min-w-0 flex-1 gap-[3px] overflow-x-auto px-1.5 py-2">
        {sprintEngineState.tasks.length === 0 ? (
          <div className="flex h-full min-h-[320px] w-full items-center justify-center p-6 text-center">
            <div className="max-w-xl">
              <div className="text-[13px] font-semibold text-[color:var(--text-strong)]">
                Waiting for the architect plan
              </div>
              <p className="mt-2 text-[12px] leading-5 text-[color:var(--text-muted)]">
                The board will populate as the architect adds tasks through the Sprint Engine tool.
              </p>
            </div>
          </div>
        ) : null}
        {sprintEngineState.tasks.length > 0
          ? boardColumns.map((column) => (
            <BoardLane
              key={column.key}
              surface
              // Readable floor for the lanes. They flex to fill the panel and
              // shrink to this width, then the row scrolls — set at the point
              // where a card title still wraps to ~3-4 words per line rather
              // than one word per line. Below ~180px the cards become unreadable
              // (a maximized window fits the 6-lane set; 9 gate lanes or a narrow
              // panel scroll past the floor, which is the intended cutoff).
              minWidth={180}
              label={column.label}
              // The lane header carries the column's lifecycle glyph once, so the
              // cards below stay clean. Header glyphs never animate — the live
              // spinner belongs to the actively-running card, not the column.
              glyph={<LifecycleGlyph state={taskBoardColumnToLifecycle(column.key)} live={false} />}
              count={column.cards.length}
              flipKey={column.cards.map((card) => card.id).join(',')}
            >
              {column.cards.map((task) => {
                const boardColumn = getSprintEngineTaskBoardColumn(task, sprintEngineState.tasks)
                const cardTone: Tone =
                  task.status === 'done'
                    ? 'good'
                    : task.status === 'needs_input'
                      ? 'warn'
                      : task.status === 'in_progress' || boardColumn === 'ready' || boardColumn === 'review'
                        ? 'accent'
                        : 'neutral'
                const taskSelected = selectedTaskId === task.id
                const justMoved = recentlyMovedTaskIds.has(task.id)
                const needsInput = sprintEngineNeedsInputCardSummary(task)
                // The lane header already states the column's status (its
                // lifecycle glyph), so the card carries no leading mark — it would
                // just repeat the column and eat horizontal space.
                return (
                  <TaskCard
                    key={task.id}
                    variant="card"
                    // Thin lanes (minWidth 180) would truncate descriptive
                    // architect titles — let them wrap to full height instead.
                    clampTitle={false}
                    tone={cardTone}
                    leading={null}
                    identifier={task.id}
                    title={task.title}
                    supporting={
                      needsInput ? (
                        <>
                          <span className="font-medium text-[color:var(--text-default)]">
                            {needsInput.headline}
                          </span>
                          {needsInput.question ? <span> · {needsInput.question}</span> : null}
                        </>
                      ) : null
                    }
                    selected={taskSelected}
                    onSelect={() => onSelectTask(task.id)}
                    onContextMenu={onTaskContextMenu ? (event) => onTaskContextMenu(event, task) : undefined}
                    flipKey={task.id}
                    ariaLabel={
                      needsInput
                        ? `${task.id} ${task.title}. ${needsInput.headline}${needsInput.question ? `: ${needsInput.question}` : ''}`
                        : undefined
                    }
                    justMovedClassName={justMoved ? 'card-just-moved-gold' : undefined}
                    trailing={
                      // The task's execution model/cli (MC-1448) stays metadata
                      // only — surfaced in the inspector, never as card chrome
                      // (a per-card model chip crowded every column).
                      <span className="flex items-center gap-1.5">
                        <Tooltip content={getSprintEngineRoleLabel(task.role)}>
                          <span
                            // design-tokens-allow: role glyph is the one place per the redesign where role tones are retained.
                            style={{ color: getSprintEngineRoleAccent(task.role) }}
                            aria-label={`Role: ${getSprintEngineRoleLabel(task.role)}`}
                            role="img"
                          >
                            <SprintEngineRoleIcon role={task.role} className="icon-sm" />
                          </span>
                        </Tooltip>
                      </span>
                    }
                  />
                )
              })}

              {column.cards.length === 0 ? (
                <li className="m-1 rounded-[5px] px-2 py-3 text-[11px] leading-5 text-[color:var(--text-disabled)]">
                  {getSprintEngineKanbanEmptyMessage(column.key)}
                </li>
              ) : null}
            </BoardLane>
          ))
          : null}
      </div>
    </div>
  )
}

// The card's job in the Needs Input lane is "whose blocker is this?" — so it
// leads with the actor route (your input vs the architect's), which is the one
// bit that tells a human scanning the lane which cards are theirs to act on.
// The question follows as muted detail; the reason and reporter live in the
// inspector. Returns the display headline plus the raw question so the card can
// tier them and build an accessible label.
function sprintEngineNeedsInputCardSummary(
  task: SprintEngineTask,
): { headline: string; question: string | null } | null {
  if (task.status !== 'needs_input') return null
  const kind = task.needsInput?.kind?.trim()
  const headline =
    kind === 'user'
      ? 'Needs your input'
      : kind === 'architect'
        ? 'Needs architect input'
        : 'Needs input'
  const question = task.needsInput?.question?.trim() || null
  return { headline, question }
}
