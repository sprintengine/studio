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
    border: 'border-[#3a3b42]',
    bg: 'bg-[#17181d]',
    topAccent: 'bg-[#ececee]',
    label: 'text-[#ececee]',
    iconColor: 'text-[#ececee]',
  },
  switchboard: {
    border: 'border-[#3b2f63]',
    bg: 'bg-[#100c1e]',
    topAccent: 'bg-[#7c5cf2]',
    label: 'text-[#cdbcff]',
    iconColor: 'text-[#a78bfa]',
  },
  sprintengine: {
    border: 'border-[#3a3426]',
    bg: 'bg-[#151106]',
    topAccent: 'bg-[#ffbf2f]',
    label: 'text-[#ffe0a3]',
    iconColor: 'text-[#ffbf2f]',
  },
  multiloop: {
    border: 'border-[#26304d]',
    bg: 'bg-[#111b30]',
    topAccent: 'bg-[#5c7cff]',
    label: 'text-[#d4ddff]',
    iconColor: 'text-[#5c7cff]',
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
        transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[#5c7cff]/60
        disabled:cursor-not-allowed disabled:opacity-55
        ${active
          ? `${styles.border} ${styles.bg}`
          : 'border-[#24252b] bg-[#0d0e11] hover:border-[#303139] hover:bg-[#111216]'}
      `}
    >
      <span
        aria-hidden="true"
        className={`absolute inset-x-0 top-0 h-[3px] ${active ? styles.topAccent : 'bg-transparent'}`}
      />
      <span className="flex items-center gap-2">
        <WorkspaceTypeIcon
          mode={mode}
          className={`h-4 w-4 shrink-0 ${active ? styles.iconColor : 'text-[#9a9aa2]'}`}
        />
        <span
          className={`text-[13px] font-semibold leading-4 ${
            active ? styles.label : 'text-[#ececee]'
          }`}
        >
          {copy.title}
        </span>
      </span>
      <span className="text-[12px] leading-4 text-[#9a9aa2]">
        {copy.body}
      </span>
    </button>
  )
}
