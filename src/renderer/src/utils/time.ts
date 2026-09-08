// Shared time formatters. ISO-string inputs from agent-managed state files
// (Sprint Engine, automations, reviews) get rendered as either relative
// (`5m ago`) or absolute (`MM/DD/YYYY, HH:MM:SS`) text. Lower-level
// numeric-only helpers live in `relativeTime.ts`.

export function formatRelativeTime(iso: string | null | undefined): string {
  if (!iso) return ''
  const time = new Date(iso).getTime()
  if (Number.isNaN(time)) return ''
  const diff = Date.now() - time
  const minutes = Math.round(diff / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days}d ago`
  const months = Math.round(days / 30)
  if (months < 12) return `${months}mo ago`
  return `${Math.round(months / 12)}y ago`
}

export function formatTimestamp(value: string | null): string {
  if (!value) return 'Not started'
  return new Date(value).toLocaleString()
}
