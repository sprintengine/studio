import { useState, type ReactNode } from 'react'
import type { AgentCli } from '../../types/workspace'
import type { AgentCliCatalogOption } from './newWorkspace/cliRuntimeOptions'
import CliIcon from '../CliIcon'
import { SprintEngineWorkspaceTypeIcon } from '../AppIcons'
import { Popover } from '../ui'
import { CreationBackdrop } from '../backdrops/CreationBackdrop'
import { CliInstallCta } from './cliInstallRoute'

interface WorkspaceLauncherProps {
  // Available agent CLIs to offer as the quick-launch grid (the expected
  // default action). Empty when no runtime is configured yet.
  agentClis: AgentCliCatalogOption[]
  onSpawnAgent: (cli: AgentCli) => void
  // Renders the shared spawn picker (SpawnPicker) as Popover content
  // anchored to the row; `close` dismisses the popover. Absent → the row is omitted.
  renderSpecialistPicker?: (close: () => void) => ReactNode
  onStartSprintEngine: () => void
  onNewWorkspace?: () => void
  onClose?: () => void
}

// Shared chrome for the two secondary launch rows. One radius, hairline border,
// no shadow — structure is spacing + hairline per the app's aesthetic.
const MODE_ROW =
  'group flex w-full items-center gap-3 rounded-md border border-[color:var(--border-default)] bg-[color:var(--bg-surface)] px-3 py-3 text-left transition-colors hover:border-[color:var(--border-strong)] hover:bg-[color:var(--bg-hover)] focus-visible:focus-ring'

const ROW_ICON =
  'size-icon-md shrink-0 text-[color:var(--text-muted)] transition-colors group-hover:text-[color:var(--text-default)]'

// The same glyph on a row that cannot run. A second `text-[color:…]` appended to
// ROW_ICON would be dropped by the cascade, so the disabled row uses its own class.
const ROW_ICON_DISABLED = 'size-icon-md shrink-0 text-[color:var(--text-disabled)]'

function ChevronRightIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="m9 6 6 6-6 6" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

// A vetted-role glyph for the specialist entry — a shield with a check, distinct
// from the neutral CLI marks and the Sprint Engine node glyph.
function SpecialistRosterIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 3 4 7v6c0 4 3.5 7 8 8 4.5-1 8-4 8-8V7z" stroke="currentColor" strokeWidth={1.6} strokeLinejoin="round" />
      <path d="m9 12 2 2 4-4" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

// A launch row that cannot run here: same anatomy and place as the live row,
// with its state where the description was. Not a button — there is nothing to
// press — so it is inert to the keyboard as well as the pointer.
function DisabledModeRow({
  icon,
  title,
  state,
}: {
  icon: ReactNode
  title: string
  state: string
}) {
  return (
    <div
      aria-disabled="true"
      className="flex w-full items-center gap-3 rounded-md border border-[color:var(--border-subtle)] bg-[color:var(--bg-surface)] px-3 py-3 text-left"
    >
      {icon}
      <span className="min-w-0">
        <span className="block text-body font-semibold text-[color:var(--text-disabled)]">{title}</span>
        <span className="mt-0.5 block truncate text-meta text-[color:var(--text-muted)]">{state}</span>
      </span>
    </div>
  )
}

// The empty-workspace launcher. Leads with the agent CLI grid (the expected
// default) and demotes the role-shaped and team paths to two quiet rows that
// open the existing specialist picker and Sprint Engine setup respectively.
export default function WorkspaceLauncher({
  agentClis,
  onSpawnAgent,
  renderSpecialistPicker,
  onStartSprintEngine,
  onNewWorkspace,
  onClose,
}: WorkspaceLauncherProps) {
  const [specialistOpen, setSpecialistOpen] = useState(false)
  const hasClis = agentClis.length > 0
  const hasFooter = Boolean(onNewWorkspace || onClose)

  return (
    <div className="absolute inset-0 z-10 isolate flex items-start justify-center overflow-auto bg-[color:var(--bg-app)]">
      <CreationBackdrop surface="workspace" />
      <div className="w-full max-w-[520px] px-6 pb-16 pt-[14vh]">
        <h1 className="text-title font-semibold tracking-[-0.01em] text-[color:var(--text-strong)]">
          Start something here
        </h1>
        {/* State, not helper copy: with nothing installed the machine's answer
            is the reason this surface looks the way it does. */}
        <p className="mt-1 text-body text-[color:var(--text-muted)]">
          {hasClis
            ? 'This workspace is empty. Launch an agent to begin.'
            : 'No agent CLI is installed on this machine.'}
        </p>

        {hasClis ? (
          <div className="mt-5 grid grid-cols-3 gap-2">
            {agentClis.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => onSpawnAgent(option.value)}
                className="group flex h-[46px] items-center gap-2.5 rounded-md border border-[color:var(--border-default)] bg-[color:var(--bg-surface-raised)] px-3 text-left transition-colors hover:border-[color:var(--border-strong)] hover:bg-[color:var(--bg-hover)] focus-visible:focus-ring"
              >
                <CliIcon cli={option.value} className={ROW_ICON} />
                <span className="truncate text-body font-medium text-[color:var(--text-strong)]">
                  {option.label}
                </span>
              </button>
            ))}
          </div>
        ) : (
          // The one route that works here. Nothing else on this surface can
          // launch, so the install is the surface's primary action.
          <CliInstallCta />
        )}

        <div className="mt-3.5 flex flex-col gap-2 border-t border-[color:var(--border-subtle)] pt-3.5">
          {/* Both rows spawn a CLI agent, so with none installed they cannot
              run — they say so where their description was, rather than
              looking live and failing on click. */}
          {!hasClis ? (
            <>
              {renderSpecialistPicker ? (
                <DisabledModeRow
                  icon={<SpecialistRosterIcon className={ROW_ICON_DISABLED} />}
                  title="Specialist agent"
                  state="Needs an agent CLI"
                />
              ) : null}
              <DisabledModeRow
                icon={<SprintEngineWorkspaceTypeIcon className={ROW_ICON_DISABLED} />}
                title="Sprint Engine"
                state="Needs an agent CLI"
              />
            </>
          ) : null}
          {hasClis && renderSpecialistPicker ? (
            <Popover
              open={specialistOpen}
              onOpenChange={setSpecialistOpen}
              ariaLabel="Spawn a specialist agent"
              popupRole="menu"
              placement="bottom-start"
              renderTrigger={({ ref, triggerProps, togglePopover }) => (
                <button ref={ref} type="button" onClick={togglePopover} className={MODE_ROW} {...triggerProps}>
                  <SpecialistRosterIcon className={ROW_ICON} />
                  <span className="min-w-0">
                    <span className="block text-body font-semibold text-[color:var(--text-strong)]">
                      Specialist agent
                    </span>
                    <span className="mt-0.5 block truncate text-meta text-[color:var(--text-muted)]">
                      A role-shaped agent — architect, security, code review, and more.
                    </span>
                  </span>
                  <ChevronRightIcon className="ml-auto h-4 w-4 shrink-0 text-[color:var(--text-subtle)] transition-all group-hover:translate-x-0.5 group-hover:text-[color:var(--text-default)]" />
                </button>
              )}
            >
              {renderSpecialistPicker(() => setSpecialistOpen(false))}
            </Popover>
          ) : null}

          {hasClis ? (
            <button type="button" onClick={onStartSprintEngine} className={MODE_ROW}>
              <SprintEngineWorkspaceTypeIcon className={ROW_ICON} />
              <span className="min-w-0">
                <span className="block text-body font-semibold text-[color:var(--text-strong)]">
                  Sprint Engine
                </span>
                <span className="mt-0.5 block truncate text-meta text-[color:var(--text-muted)]">
                  Launch a coordinated multi-agent team from a goal or backlog item.
                </span>
              </span>
              <ChevronRightIcon className="ml-auto h-4 w-4 shrink-0 text-[color:var(--text-subtle)] transition-all group-hover:translate-x-0.5 group-hover:text-[color:var(--text-default)]" />
            </button>
          ) : null}
        </div>

        {hasFooter ? (
          <div className="mt-6 flex items-center gap-3 text-meta">
            {onNewWorkspace ? (
              <button
                type="button"
                onClick={onNewWorkspace}
                className="text-[color:var(--text-muted)] transition-colors hover:text-[color:var(--text-default)]"
              >
                New workspace
              </button>
            ) : null}
            {onNewWorkspace && onClose ? (
              <span aria-hidden="true" className="text-[color:var(--text-disabled)]">
                ·
              </span>
            ) : null}
            {onClose ? (
              <button
                type="button"
                onClick={onClose}
                className="text-[color:var(--text-muted)] transition-colors hover:text-[color:var(--tone-warn)]"
              >
                Close workspace
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  )
}
