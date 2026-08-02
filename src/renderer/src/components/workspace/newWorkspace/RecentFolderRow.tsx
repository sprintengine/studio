// Documented InboxRow extension. The shared `ui/InboxRow` mandates a leading
// `StatusDot`; RecentFolderRow swaps that for the canonical folder glyph so the
// row's leading slot reads as "this is a recent folder" rather than "this has a
// status." The button-row contract (single `<button>` root, no nested
// interactives, panel-aligned hover/selected tokens, Tooltip-wrapped accessible
// name) matches `ui/InboxRow`.
import { basename, folderKey } from './helpers'
import { Tooltip } from '../../ui/Tooltip'

interface RecentFolderRowProps {
  path: string
  active: boolean
  onSelect: (path: string) => void
}

export function RecentFolderRow({ path, active, onSelect }: RecentFolderRowProps) {
  const label = basename(path) || path

  return (
    <Tooltip content={path}>
    <button
      type="button"
      aria-pressed={active}
      aria-label={path}
      onClick={() => onSelect(path)}
      className={`
        group flex w-full min-w-0 items-center gap-3 rounded px-2 py-1.5 text-left
        transition-colors focus-visible:focus-ring
        ${active ? 'bg-[color:var(--bg-hover)]' : 'hover:bg-[color:var(--bg-surface-raised)]'}
      `}
    >
      <span
        aria-hidden="true"
        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded text-[color:var(--text-subtle)] ${
          active ? 'bg-[color:var(--border-default)] text-[color:var(--text-muted)]' : 'bg-[color:var(--bg-surface-raised)] group-hover:text-[color:var(--text-muted)]'
        }`}
      >
        <svg className="icon-md" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="M3.75 7.5C3.75 6.39543 4.64543 5.5 5.75 5.5H9.5L11.5 7.5H18.25C19.3546 7.5 20.25 8.39543 20.25 9.5V16.25C20.25 17.3546 19.3546 18.25 18.25 18.25H5.75C4.64543 18.25 3.75 17.3546 3.75 16.25V7.5Z"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinejoin="round"
          />
        </svg>
      </span>
      <span className="min-w-0 flex-1">
        <span
          className={`block truncate text-body font-medium ${
            active ? 'text-[color:var(--text-strong)]' : 'text-[color:var(--text-default)]'
          }`}
        >
          {label}
        </span>
        <span className="block truncate font-mono text-micro leading-4 text-[color:var(--text-subtle)]">
          {path}
        </span>
      </span>
    </button>
    </Tooltip>
  )
}

export function isSameFolder(a: string | null, b: string): boolean {
  return Boolean(a) && folderKey(a as string) === folderKey(b)
}
