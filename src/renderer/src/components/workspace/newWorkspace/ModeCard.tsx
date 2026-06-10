import type { CreationMode, ModeCardModel } from './types'

type ModeStyle = {
  border: string
  bg: string
  topAccent: string
  label: string
  iconColor: string
}

// Card accent treatment per known mode. This stays card-local rather than
// deriving from the registry definition's accentToken: the card's active accent
// (e.g. --tone-warn for Sprint Engine) is theme-reactive and diverges from the
// panel-header identity token (--tool-sprintengine) in non-Dark themes, so the
// card keeps its own visual map. Unknown registry ids fall back to the neutral
// 'standard' treatment.
type KnownModeId = 'standard' | 'switchboard' | 'sprintengine' | 'multiloop' | 'guided-brief'

const MODE_STYLES: Record<KnownModeId, ModeStyle> = {
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

interface ModeCardProps {
  model: ModeCardModel
  active: boolean
  disabled?: boolean
  onSelect: (mode: CreationMode) => void
}

export function ModeCard({ model, active, disabled = false, onSelect }: ModeCardProps) {
  const styles = MODE_STYLES[model.id as KnownModeId] ?? MODE_STYLES.standard
  const Icon = model.icon

  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      disabled={disabled}
      onClick={() => onSelect(model.id)}
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
        <Icon
          className={`h-4 w-4 shrink-0 ${active ? styles.iconColor : 'text-[color:var(--text-muted)]'}`}
        />
        <span
          className={`text-[13px] font-semibold leading-4 ${
            active ? styles.label : 'text-[color:var(--text-strong)]'
          }`}
        >
          {model.label}
        </span>
      </span>
      <span className="text-[12px] leading-4 text-[color:var(--text-muted)]">
        {model.description}
      </span>
    </button>
  )
}
