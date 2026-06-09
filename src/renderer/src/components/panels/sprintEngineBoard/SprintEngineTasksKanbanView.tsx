import { BoardLane, LifecycleGlyph, TaskCard, Tooltip, type Tone } from '../../ui'
import { SprintEngineRoleIcon } from '../../AppIcons'
import type { SprintEngineState, SprintEngineTaskBoardColumn } from '../../../types/workspace'
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
  recentlyMovedTaskIds: ReadonlySet<string>
}

export function SprintEngineTasksKanbanView({
  sprintEngineState,
  boardColumns,
  selectedTaskId,
  onSelectTask,
  recentlyMovedTaskIds,
}: Props) {
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="flex min-w-0 flex-1 gap-1.5 overflow-x-auto px-1.5 py-2">
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
                      : task.status === 'in_progress'
                        || boardColumn === 'ready'
                        || boardColumn === 'changes_requested'
                        || boardColumn === 'review'
                        || boardColumn === 'testing'
                        || boardColumn === 'product'
                        ? 'accent'
                        : 'neutral'
                const taskSelected = selectedTaskId === task.id
                const justMoved = recentlyMovedTaskIds.has(task.id)
                // The lane header already states the column's status (its
                // lifecycle glyph), so the card carries no leading mark — it would
                // just repeat the column and eat horizontal space.
                return (
                  <TaskCard
                    key={task.id}
                    variant="card"
                    tone={cardTone}
                    leading={null}
                    identifier={task.id}
                    title={task.title}
                    selected={taskSelected}
                    onSelect={() => onSelectTask(task.id)}
                    flipKey={task.id}
                    justMovedClassName={justMoved ? 'card-just-moved-gold' : undefined}
                    trailing={
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
