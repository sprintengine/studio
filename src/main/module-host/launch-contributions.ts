import type {
  LaunchContribution,
  LaunchContributionHostContextSection,
  LaunchContributionMcpServer,
  LaunchContributionRequest,
  LaunchContributionResult,
} from '../../shared/modules/launch-contributions'

export type {
  LaunchContribution,
  LaunchContributionHostContextSection,
  LaunchContributionMcpServer,
  LaunchContributionRequest,
  LaunchContributionResult,
} from '../../shared/modules/launch-contributions'

export type LaunchContributionFailure = {
  moduleId: string
  message: string
}

export type MergedLaunchContribution = {
  env: Record<string, string>
  pathEntries: string[]
  shellFunctions: string[]
  mcpServers: LaunchContributionMcpServer[]
  hostContext: LaunchContributionHostContextSection[]
  session: { managed: boolean; reapExempt: boolean }
  identityKeys: string[]
  failures: LaunchContributionFailure[]
}

type LaunchContributionEntry = {
  moduleId: string
  contribute: LaunchContribution
}

const entries: LaunchContributionEntry[] = []

export const EMPTY_LAUNCH_CONTRIBUTION: MergedLaunchContribution = {
  env: {},
  pathEntries: [],
  shellFunctions: [],
  mcpServers: [],
  hostContext: [],
  session: { managed: false, reapExempt: false },
  identityKeys: [],
  failures: [],
}

export function addLaunchContribution(moduleId: string, contribute: LaunchContribution): void {
  entries.push({ moduleId, contribute })
}

export function removeLaunchContributionsForModule(moduleId: string): void {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index]?.moduleId === moduleId) entries.splice(index, 1)
  }
}

export function resetLaunchContributionsForTest(): void {
  entries.length = 0
}

export function registeredLaunchContributionCount(): number {
  return entries.length
}

/**
 * Run every registered contribution in registration order and merge. A throw is
 * recorded against its module and skipped — it must never fail the launch.
 */
let failureReporter: ((failure: LaunchContributionFailure) => void) | null = null

export function setLaunchContributionFailureReporter(
  reporter: ((failure: LaunchContributionFailure) => void) | null,
): void {
  failureReporter = reporter
}

export function collectLaunchContributions(
  request: LaunchContributionRequest,
  onFailure?: (failure: LaunchContributionFailure) => void,
): MergedLaunchContribution {
  const merged: MergedLaunchContribution = {
    env: {},
    pathEntries: [],
    shellFunctions: [],
    mcpServers: [],
    hostContext: [],
    session: { managed: false, reapExempt: false },
    identityKeys: [],
    failures: [],
  }
  for (const entry of entries) {
    let result: LaunchContributionResult
    try {
      result = entry.contribute(request)
    } catch (error) {
      const failure = {
        moduleId: entry.moduleId,
        message: error instanceof Error ? error.message : String(error),
      }
      merged.failures.push(failure)
      onFailure?.(failure)
      failureReporter?.(failure)
      continue
    }
    mergeContribution(merged, result)
  }
  return merged
}

function mergeContribution(merged: MergedLaunchContribution, result: LaunchContributionResult): void {
  if (result.env) Object.assign(merged.env, result.env)
  if (result.pathEntries) merged.pathEntries.push(...result.pathEntries)
  if (result.shellFunctions) merged.shellFunctions.push(...result.shellFunctions)
  if (result.mcpServers) merged.mcpServers.push(...result.mcpServers)
  if (result.hostContext) merged.hostContext.push(...result.hostContext)
  if (result.session?.managed) merged.session.managed = true
  if (result.session?.reapExempt) merged.session.reapExempt = true
  if (result.identityKeys) {
    for (const key of result.identityKeys) {
      if (!merged.identityKeys.includes(key)) merged.identityKeys.push(key)
    }
  }
}
