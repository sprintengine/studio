import type { FileAction, FileActionContext, FileActionEntry, RendererHost } from './renderer-host'
import type { FuturePlanWorkspaceSource, SprintEngineSourceBundleItem, SprintEngineSourcePlanKind } from '../types/workspace'
import { showToast } from '../store/toastStore'
import { slugifySprintEngineName } from '../utils/sprintengineStateFile'
import {
  inferSourcePlanKind,
  markdownTitle,
  planBasename,
  toTitleName,
  workspaceRelativePath,
} from '../../../shared/source-paths'

function usableFile(entry: FileActionEntry): boolean {
  return !entry.isDir && !entry.gitDeleted
}

function isMarkdownFile(entry: FileActionEntry): boolean {
  return usableFile(entry) && /\.md$/i.test(entry.name)
}

function isHtmlFile(entry: FileActionEntry): boolean {
  return usableFile(entry) && /\.html?$/i.test(entry.name)
}

function isPotentialSourceBundleFile(entry: FileActionEntry): boolean {
  return usableFile(entry) && /\.(md|html?)$/i.test(entry.name)
}

function sourceBundleRelativePath(workspaceRoot: string, entry: FileActionEntry): string | null {
  if (!isPotentialSourceBundleFile(entry)) return null
  const relativePath = workspaceRelativePath(workspaceRoot, entry.path)
  if (!relativePath) return null
  const normalized = relativePath.replace(/\\/g, '/').replace(/^\/+/, '')
  if (!normalized.startsWith('backlog/')) return null
  return normalized
}

function isSourceBundleFile(workspaceRoot: string, entry: FileActionEntry): boolean {
  return Boolean(sourceBundleRelativePath(workspaceRoot, entry))
}

function markdownSourceRelativePath(workspaceRoot: string, entry: FileActionEntry): string | null {
  if (!isMarkdownFile(entry)) return null
  const relativePath = workspaceRelativePath(workspaceRoot, entry.path)
  if (!relativePath) return null
  return relativePath.replace(/\\/g, '/').replace(/^\/+/, '')
}

function canUsePathCommands(entries: readonly FileActionEntry[]): boolean {
  return entries.length > 0 && entries.every((entry) => !entry.gitDeleted)
}

export function isSingleMarkdownPlanSelection(context: FileActionContext): boolean {
  const [entry] = context.entries
  return Boolean(
    canUsePathCommands(context.entries)
    && context.entries.length === 1
    && entry
    && markdownSourceRelativePath(context.workspaceRoot, entry),
  )
}

export function isSourceBundleSelection(context: FileActionContext): boolean {
  if (!canUsePathCommands(context.entries)) return false
  if (!context.entries.every((entry) => isPotentialSourceBundleFile(entry))) return false
  const singleHtml = context.entries.length === 1 && Boolean(context.entries[0] && isHtmlFile(context.entries[0]))
  return context.entries.length > 1 || singleHtml
}

export function isSourceBundleOutsideBacklog(context: FileActionContext): boolean {
  return isSourceBundleSelection(context)
    && context.entries.some((entry) => isPotentialSourceBundleFile(entry) && !isSourceBundleFile(context.workspaceRoot, entry))
}

function reportFileActionError(error: unknown, fallback: string): void {
  showToast({
    tone: 'error',
    title: 'File action failed',
    description: error instanceof Error ? error.message : fallback,
  })
}

async function startPlanFromEntry(
  context: FileActionContext,
  sourcePlanKind: SprintEngineSourcePlanKind,
): Promise<void> {
  const entry = context.entries[0]
  const sourceRelativePath = entry ? markdownSourceRelativePath(context.workspaceRoot, entry) : null
  if (!entry || !sourceRelativePath || !context.startSourcePlan) return

  const basename = planBasename(entry.name)
  const fallbackGoal = toTitleName(basename)

  try {
    const sourceContent = await window.api.readfile(entry.path)
    const source: FuturePlanWorkspaceSource = {
      folderPath: context.workspaceRoot,
      sourcePath: entry.path,
      sourceRelativePath,
      sourceContent,
      sourcePlanKind,
      teamName: slugifySprintEngineName(basename),
      goal: markdownTitle(sourceContent) ?? fallbackGoal,
    }
    context.startSourcePlan(source)
  } catch (error) {
    reportFileActionError(error, 'Could not read the selected markdown file.')
  }
}

async function startPlanFromBundle(context: FileActionContext): Promise<void> {
  if (!context.startSourcePlan) return
  const sourceEntries = context.entries.filter((entry) => isSourceBundleFile(context.workspaceRoot, entry))
  if (sourceEntries.length === 0) return

  try {
    const sourceBundle: SprintEngineSourceBundleItem[] = await Promise.all(sourceEntries.map(async (sourceEntry) => {
      const sourceContent = await window.api.readfile(sourceEntry.path)
      const sourceRelativePath = sourceBundleRelativePath(context.workspaceRoot, sourceEntry)
      if (!sourceRelativePath) throw new Error(`Unsupported source file: ${sourceEntry.name}`)
      return {
        kind: isHtmlFile(sourceEntry) ? 'html_mockup' : inferSourcePlanKind(sourceRelativePath, sourceContent),
        sourcePath: sourceEntry.path,
        sourceRelativePath,
        sourceContent,
      }
    }))
    const primary = sourceBundle.find((item) => item.kind === 'architect_plan')
      ?? sourceBundle.find((item) => item.kind === 'product_plan')
      ?? sourceBundle[0]
    if (!primary) return
    const basename = planBasename(primary.sourceRelativePath.split('/').pop() ?? 'source-bundle')
    const firstMarkdown = sourceBundle.find((item) => /\.md$/i.test(item.sourceRelativePath))
    context.startSourcePlan({
      folderPath: context.workspaceRoot,
      sourcePath: primary.sourcePath,
      sourceRelativePath: primary.sourceRelativePath,
      sourceContent: primary.sourceContent,
      sourcePlanKind: primary.kind === 'product_plan' || primary.kind === 'architect_plan' ? primary.kind : 'unknown',
      sourceBundle,
      teamName: slugifySprintEngineName(basename),
      goal: (firstMarkdown ? markdownTitle(firstMarkdown.sourceContent) : null) ?? toTitleName(basename),
    })
  } catch (error) {
    reportFileActionError(error, 'Could not read the selected source files.')
  }
}

const productPlanAction: FileAction = {
  id: 'sprint-engine.run-from-product-plan',
  label: 'Product plan…',
  order: 10,
  isVisible: isSingleMarkdownPlanSelection,
  run: (context) => startPlanFromEntry(context, 'product_plan'),
}

const implementationPlanAction: FileAction = {
  id: 'sprint-engine.run-from-implementation-plan',
  label: 'Implementation plan…',
  order: 20,
  isVisible: isSingleMarkdownPlanSelection,
  run: (context) => startPlanFromEntry(context, 'architect_plan'),
}

const genericHandoffAction: FileAction = {
  id: 'sprint-engine.run-from-generic-handoff',
  label: 'Generic handoff…',
  order: 30,
  isVisible: isSingleMarkdownPlanSelection,
  run: (context) => startPlanFromEntry(context, 'unknown'),
}

const sourceBundleAction: FileAction = {
  id: 'sprint-engine.run-from-source-bundle',
  label: 'Run a sprint from source…',
  order: 40,
  isVisible: isSourceBundleSelection,
  getState: (context) => (isSourceBundleOutsideBacklog(context) ? 'disabled' : 'enabled'),
  getLabel: (context) => {
    if (isSourceBundleOutsideBacklog(context)) return 'Source bundles must be under backlog/'
    return context.entries.length === 1
      ? 'Run a sprint from source…'
      : `Run a sprint from ${context.entries.length} sources…`
  },
  run: startPlanFromBundle,
}

export function registerSprintEngineFileActions(host: RendererHost): void {
  host.registerFileAction(productPlanAction)
  host.registerFileAction(implementationPlanAction)
  host.registerFileAction(genericHandoffAction)
  host.registerFileAction(sourceBundleAction)
}
