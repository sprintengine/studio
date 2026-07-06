import type { CreationMode, ModeCardModel } from './types'

interface ModeCardProps {
  model: ModeCardModel
  active: boolean
  disabled?: boolean
  onSelect: (mode: CreationMode) => void
}

// One accent for the whole picker: the selected card carries the single product
// accent (ring + check badge) and every other card is a quiet raised surface.
// Per-type accent colors were retired so the view holds one accent, as the
// density bar requires. The card stays presentation-only; icon identity comes
// from the model, so any registered (or shell-owned) type renders without a
// per-id style branch.
export function ModeCard({ model, active, disabled = false, onSelect }: ModeCardProps) {
  const Icon = model.icon

  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      disabled={disabled}
      onClick={() => onSelect(model.id)}
      className={`
        relative flex min-h-[112px] w-full flex-col items-start gap-2.5 rounded-md border p-3 text-left
        transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent-primary)]
        disabled:cursor-not-allowed disabled:opacity-55
        ${active
          ? 'border-[color:var(--accent-primary)] bg-[color:var(--bg-active)] shadow-[inset_0_0_0_1px_var(--accent-primary)]'
          : 'border-[color:var(--border-default)] bg-[color:var(--bg-surface-raised)] hover:border-[color:var(--border-strong)]'}
      `}
    >
      <span
        className={`flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-sm ${
          active
            ? 'bg-[color:var(--accent-primary-soft)] text-[color:var(--accent-primary-hover)]'
            : 'bg-[color:var(--bg-hover)] text-[color:var(--text-default)]'
        }`}
      >
        <Icon className="h-4 w-4" />
      </span>
      <span className="text-[13px] font-semibold leading-4 text-[color:var(--text-strong)]">
        {model.label}
      </span>
      <span className="text-[12px] leading-4 text-[color:var(--text-muted)]">
        {model.description}
      </span>
      {active ? (
        <span
          aria-hidden="true"
          className="absolute right-2.5 top-2.5 flex h-[15px] w-[15px] items-center justify-center rounded-full bg-[color:var(--accent-primary)] text-[color:var(--text-on-accent)]"
        >
          <svg viewBox="0 0 16 16" fill="none" className="h-[9px] w-[9px]">
            <path
              d="M4 8.5L6.5 11L12 5"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
      ) : null}
    </button>
  )
}
