import { basename, folderKey } from './helpers'

type Hint = 'sprintengine' | 'multiloop'

interface RecentFolderRowProps {
  path: string
  active: boolean
  hints: Hint[]
  onSelect: (path: string) => void
}

const HINT_LABEL: Record<Hint, string> = {
  sprintengine: 'Sprint Engine',
  multiloop: 'Multiloop',
}

const HINT_STYLES: Record<Hint, { dot: string; text: string; bg: string; border: string }> = {
  sprintengine: {
    dot: 'bg-[#ffbf2f]',
    text: 'text-[#ffe0a3]',
    bg: 'bg-[#1a1408]',
    border: 'border-[#3a3426]',
  },
  multiloop: {
    dot: 'bg-[#5c7cff]',
    text: 'text-[#d4ddff]',
    bg: 'bg-[#111b30]',
    border: 'border-[#26304d]',
  },
}

export function RecentFolderRow({ path, active, hints, onSelect }: RecentFolderRowProps) {
  const label = basename(path) || path

  return (
    <button
      type="button"
      aria-pressed={active}
      title={path}
      onClick={() => onSelect(path)}
      className={`
        group flex w-full min-w-0 items-center gap-3 rounded px-2 py-1.5 text-left
        transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[#5c7cff]/60
        ${active ? 'bg-[#17181d]' : 'hover:bg-[#111216]'}
      `}
    >
      <span
        aria-hidden="true"
        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded text-[#777780] ${
          active ? 'bg-[#1f2025] text-[#a8a8b0]' : 'bg-[#111216] group-hover:text-[#a8a8b0]'
        }`}
      >
        <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" aria-hidden="true">
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
          className={`block truncate text-[13px] font-medium ${
            active ? 'text-[#ececee]' : 'text-[#d7d7dc]'
          }`}
        >
          {label}
        </span>
        <span className="block truncate font-mono text-[11px] leading-4 text-[#777780]">
          {path}
        </span>
      </span>
      {hints.length > 0 ? (
        <span className="flex shrink-0 items-center gap-1">
          {hints.map((hint) => {
            const styles = HINT_STYLES[hint]
            return (
              <span
                key={hint}
                className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-semibold ${styles.bg} ${styles.border} ${styles.text}`}
              >
                <span className={`h-1.5 w-1.5 rounded-full ${styles.dot}`} aria-hidden="true" />
                {HINT_LABEL[hint]}
              </span>
            )
          })}
        </span>
      ) : null}
    </button>
  )
}

export function isSameFolder(a: string | null, b: string): boolean {
  return Boolean(a) && folderKey(a as string) === folderKey(b)
}
