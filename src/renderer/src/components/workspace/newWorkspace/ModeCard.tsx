import { WorkspaceTypeIcon } from '../../AppIcons'
import type { CreationMode } from './types'

type ModeStyle = {
  border: string
  bg: string
  topAccent: string
  label: string
  iconColor: string
}

const MODE_STYLES: Record<CreationMode, ModeStyle> = {
  standard: {
    border: 'border-[color:var(--color-6)]',
    bg: 'bg-[color:var(--bg-hover)]',
    topAccent: 'bg-[color:var(--text-strong)]',
    label: 'text-[color:var(--text-strong)]',
    iconColor: 'text-[color:var(--text-strong)]',
  },
  switchboard: {
    border: 'border-[color:var(--bg-surface-raised)]',
    bg: 'bg-[color:var(--bg-surface-raised)]',
    topAccent: 'bg-[color:var(--tool-switchboard)]',
    label: 'text-[color:var(--tool-switchboard)]',
    iconColor: 'text-[color:var(--tool-switchboard)]',
  },
  sprintengine: {
    border: 'border-[color:var(--tone-warn-soft)]',
    bg: 'bg-[color:var(--tone-warn-soft)]',
    topAccent: 'bg-[color:var(--tone-warn)]',
    label: 'text-[color:var(--tone-warn)]',
    iconColor: 'text-[color:var(--tone-warn)]',
  },
  multiloop: {
    border: 'border-[color:var(--accent-primary-soft-strong)]',
    bg: 'bg-[color:var(--accent-primary-soft)]',
    topAccent: 'bg-[color:var(--accent-primary)]',
    label: 'text-[color:var(--text-strong)]',
    iconColor: 'text-[color:var(--accent-primary)]',
  },
  'guided-brief': {
    border: 'border-[color:var(--accent-primary-soft-strong)]',
    bg: 'bg-[color:var(--accent-primary-soft)]',
    topAccent: 'bg-[color:var(--accent-primary)]',
    label: 'text-[color:var(--text-strong)]',
    iconColor: 'text-[color:var(--accent-primary)]',
  },
}

const MODE_COPY: Record<CreationMode, { title: string; body: string }> = {
  standard: {
    title: 'Standard',
    body: 'IDE layout with editor, terminals, and file explorer for direct work.',
  },
  switchboard: {
    title: 'Switchboard',
    body: 'Triage board and Watchtower review, fed by agent-created inbox tasks.',
  },
  sprintengine: {
    title: 'Sprint Engine',
    body: 'Specialist roster, architect plan, kanban, and evidence trail.',
  },
  multiloop: {
    title: 'Multiloop',
    body: 'Roadmap, milestones, decisions, and evidence for long-running work.',
  },
  'guided-brief': {
    title: 'Guided brief',
    body: 'Answer questions. We produce a brief, screens, and a build handoff before any code starts.',
  },
}

function GuidedBriefIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M5 6.25C5 5.42 5.67 4.75 6.5 4.75H17.5C18.33 4.75 19 5.42 19 6.25V13.75C19 14.58 18.33 15.25 17.5 15.25H10.75L7.5 18.5V15.25H6.5C5.67 15.25 5 14.58 5 13.75V6.25Z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
      <path d="M9 9.25H15M9 12H13" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}

interface ModeCardProps {
  mode: CreationMode
  active: boolean
  disabled?: boolean
  onSelect: (mode: CreationMode) => void
}

export function ModeCard({ mode, active, disabled = false, onSelect }: ModeCardProps) {
  const styles = MODE_STYLES[mode]
  const copy = MODE_COPY[mode]

  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      disabled={disabled}
      onClick={() => onSelect(mode)}
      className={`
        relative flex h-[120px] w-full flex-col items-start gap-2 overflow-hidden rounded-md border p-3 text-left
        transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent-primary)]
        disabled:cursor-not-allowed disabled:opacity-55
        ${active
          ? `${styles.border} ${styles.bg}`
          : 'border-[color:var(--bg-selected)] bg-[color:var(--bg-surface)] hover:border-[color:var(--color-5)] hover:bg-[color:var(--bg-surface-raised)]'}
      `}
    >
      <span
        aria-hidden="true"
        className={`absolute inset-x-0 top-0 h-[3px] ${active ? styles.topAccent : 'bg-transparent'}`}
      />
      <span className="flex items-center gap-2">
        {mode === 'guided-brief' ? (
          <GuidedBriefIcon
            className={`h-4 w-4 shrink-0 ${active ? styles.iconColor : 'text-[color:var(--text-muted)]'}`}
          />
        ) : (
          <WorkspaceTypeIcon
            mode={mode}
            className={`h-4 w-4 shrink-0 ${active ? styles.iconColor : 'text-[color:var(--text-muted)]'}`}
          />
        )}
        <span
          className={`text-[13px] font-semibold leading-4 ${
            active ? styles.label : 'text-[color:var(--text-strong)]'
          }`}
        >
          {copy.title}
        </span>
      </span>
      <span className="text-[12px] leading-4 text-[color:var(--text-muted)]">
        {copy.body}
      </span>
    </button>
  )
}
