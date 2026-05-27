import type {
  SwitchboardImportItem,
  SwitchboardImportItemResult,
  SwitchboardImportProvider,
  SwitchboardImportResult,
  SwitchboardImportSummary,
} from '../shared/switchboard'
import { importSwitchboardItem } from './switchboard-operations'

export function normalizeImportLabels(labels: unknown): string[] {
  if (!Array.isArray(labels)) return []
  return [...new Set(labels.map((label) => String(label).trim()).filter(Boolean))]
}

export function normalizeSwitchboardImportItem(input: {
  provider: SwitchboardImportProvider
  externalId?: unknown
  externalKey?: unknown
  externalUrl?: unknown
  identifier?: unknown
  title?: unknown
  description?: unknown
  labels?: unknown
  priority?: unknown
  updatedAt?: unknown
}): SwitchboardImportItem {
  return {
    provider: input.provider,
    externalId: typeof input.externalId === 'string' && input.externalId.trim() ? input.externalId.trim() : null,
    externalKey: typeof input.externalKey === 'string' && input.externalKey.trim() ? input.externalKey.trim() : null,
    externalUrl: typeof input.externalUrl === 'string' && input.externalUrl.trim() ? input.externalUrl.trim() : null,
    identifier: typeof input.identifier === 'string' && input.identifier.trim()
      ? input.identifier.trim()
      : null,
    title: typeof input.title === 'string' ? input.title.trim() : '',
    description: typeof input.description === 'string' ? input.description : '',
    labels: normalizeImportLabels(input.labels),
    priority: typeof input.priority === 'number' ? input.priority : null,
    updatedAt: typeof input.updatedAt === 'string' && input.updatedAt.trim() ? input.updatedAt.trim() : null,
  }
}

export function summarizeImportItems(items: SwitchboardImportItemResult[]): SwitchboardImportSummary {
  return {
    created: items.filter((item) => item.status === 'created').length,
    updated: items.filter((item) => item.status === 'updated').length,
    skipped: items.filter((item) => item.status === 'skipped').length,
    errors: items.filter((item) => item.status === 'error').length,
  }
}

export async function importSwitchboardItems(
  workspaceRoot: string,
  provider: SwitchboardImportProvider,
  items: SwitchboardImportItem[]
): Promise<SwitchboardImportResult> {
  const results: SwitchboardImportItemResult[] = []
  for (const item of items) {
    results.push(await importSwitchboardItem(workspaceRoot, item))
  }
  return {
    ok: true,
    provider,
    summary: summarizeImportItems(results),
    items: results,
    unavailable: false,
  }
}
