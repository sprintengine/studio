import type { SwitchboardTaskRecord } from '../../../shared/switchboard'
import type { WatchtowerReviewSectorId } from '../types/workspace'
import { WATCHTOWER_REVIEW_SECTORS } from './watchtowerReview'

const SECTOR_SLUG_TO_ID: Map<string, WatchtowerReviewSectorId> = new Map(
  WATCHTOWER_REVIEW_SECTORS.map((sector) => [sector.id.replace(/_/g, '-'), sector.id])
)

export type InboxCreatedRangeId = 'today' | 'two_days' | 'week' | 'month'

export type InboxCreatedRange = {
  id: InboxCreatedRangeId
  label: string
  days: number
}

export const INBOX_CREATED_RANGES: InboxCreatedRange[] = [
  { id: 'today', label: 'Today', days: 1 },
  { id: 'two_days', label: 'Last 2 days', days: 2 },
  { id: 'week', label: 'Last 7 days', days: 7 },
  { id: 'month', label: 'Last 30 days', days: 30 },
]

const CREATED_RANGE_BY_ID = new Map(INBOX_CREATED_RANGES.map((range) => [range.id, range]))

export function getInboxCreatedRange(id: InboxCreatedRangeId): InboxCreatedRange {
  return CREATED_RANGE_BY_ID.get(id) ?? INBOX_CREATED_RANGES[0]
}

export type InboxFilters = {
  sectors: WatchtowerReviewSectorId[]
  createdRange: InboxCreatedRangeId | null
  search: string
}

export const EMPTY_INBOX_FILTERS: InboxFilters = {
  sectors: [],
  createdRange: null,
  search: '',
}

export function hasActiveInboxFilters(filters: InboxFilters): boolean {
  return filters.sectors.length > 0 || filters.createdRange !== null || filters.search.trim().length > 0
}

export function filterInboxTasks(
  tasks: SwitchboardTaskRecord[],
  filters: InboxFilters = EMPTY_INBOX_FILTERS,
  now: Date = new Date()
): SwitchboardTaskRecord[] {
  const search = filters.search.trim().toLowerCase()
  const createdAfter = filters.createdRange
    ? now.getTime() - getInboxCreatedRange(filters.createdRange).days * 24 * 60 * 60 * 1000
    : null
  return tasks
    .filter((record) => record.location.folderStatus === 'inbox')
    .filter((record) => (filters.sectors.length === 0 ? true : taskMatchesAnySector(record, filters.sectors)))
    .filter((record) => (createdAfter === null ? true : taskCreatedAtOrAfter(record, createdAfter)))
    .filter((record) => (search.length === 0 ? true : taskMatchesSearch(record, search)))
    .sort(byCreatedDescending)
}

export function taskReviewSectors(record: SwitchboardTaskRecord): WatchtowerReviewSectorId[] {
  const sectors = new Set<WatchtowerReviewSectorId>()
  for (const label of record.task.labels) {
    const id = SECTOR_SLUG_TO_ID.get(label.toLowerCase())
    if (id) sectors.add(id)
  }
  return [...sectors]
}

function taskMatchesAnySector(record: SwitchboardTaskRecord, sectors: WatchtowerReviewSectorId[]): boolean {
  const slugs = new Set(sectors.map((sector) => sector.replace(/_/g, '-').toLowerCase()))
  return record.task.labels.some((label) => slugs.has(label.toLowerCase()))
}

function taskCreatedAtOrAfter(record: SwitchboardTaskRecord, sinceMs: number): boolean {
  const created = Date.parse(record.task.createdAt)
  if (!Number.isFinite(created)) return true
  return created >= sinceMs
}

function taskMatchesSearch(record: SwitchboardTaskRecord, search: string): boolean {
  const haystack = [
    record.task.title,
    record.task.identifier,
    record.task.description,
    record.task.labels.join(' '),
  ]
    .join('\n')
    .toLowerCase()
  return haystack.includes(search)
}

function byCreatedDescending(a: SwitchboardTaskRecord, b: SwitchboardTaskRecord): number {
  const aTime = Date.parse(a.task.createdAt) || 0
  const bTime = Date.parse(b.task.createdAt) || 0
  return bTime - aTime
}
