import type {
  AutomationDefinition,
  AutomationsInstanceEntry,
  AutomationsInstanceIndex,
  AutomationsInstanceProblem,
} from '../../shared/automations/contracts'
import type { AutomationsStore, AutomationStoreProblem } from './store'

// A known project root the index scans. `folderPath` is the project root (the
// automations store lives at `<folderPath>/.multi-code/automations/`);
// `workspaceId` is a representative open workspace rooted there.
export type AutomationsInstanceProjectFolder = {
  workspaceId: string
  folderPath: string
}

export type AutomationsInstanceIndexPorts = {
  projectFolders: AutomationsInstanceProjectFolder[]
  createStore: (workspaceRoot: string) => AutomationsStore
  /**
   * Applied to every definition before it leaves the process — the IPC handler
   * passes the same webhook-secret redaction the single-project list channel
   * uses, so an enumerated definition never carries a secret. Absent ⇒ identity.
   */
  mapDefinition?: (definition: AutomationDefinition) => AutomationDefinition
}

// Enumerate every automation across every known project root with the live state
// the Automations surface rail draws. A root whose definitions cannot be read is
// recorded as a problem and skipped (never masking the roots that DO read); a
// single automation whose run history is unreadable still lists (definition +
// null last run) with its own problem recorded — the definition existing is not
// in doubt, only its runs. Roots and definitions come out in a stable order
// (project-folder order, then definition id) so the rail render is deterministic.
export async function buildAutomationsInstanceIndex(
  ports: AutomationsInstanceIndexPorts,
): Promise<AutomationsInstanceIndex> {
  const mapDefinition = ports.mapDefinition ?? ((definition) => definition)
  const entries: AutomationsInstanceEntry[] = []
  const problems: AutomationsInstanceProblem[] = []

  for (const folder of ports.projectFolders) {
    const store = ports.createStore(folder.folderPath)
    const definitions = await store.listDefinitions()
    if (!definitions.ok) {
      problems.push({ workspaceRoot: folder.folderPath, message: firstProblemMessage(definitions.errors) })
      continue
    }

    for (const definition of definitions.values) {
      const runs = await store.listRuns(definition.id)
      if (!runs.ok) {
        problems.push({ workspaceRoot: folder.folderPath, message: firstProblemMessage(runs.errors) })
        entries.push({
          workspaceRoot: folder.folderPath,
          workspaceId: folder.workspaceId,
          definition: mapDefinition(definition),
          lastRun: null,
          isRunningNow: false,
        })
        continue
      }

      // listRuns returns newest-first, so [0] is the last run and a run in the
      // running state (agent-backed runs stay `running` until finalize) sorts to
      // the front — but check the whole (bounded) history for `running` so a
      // stray ordering never hides an in-flight run.
      entries.push({
        workspaceRoot: folder.folderPath,
        workspaceId: folder.workspaceId,
        definition: mapDefinition(definition),
        lastRun: runs.values[0] ?? null,
        isRunningNow: runs.values.some((run) => run.status === 'running'),
      })
    }
  }

  return { entries, problems }
}

function firstProblemMessage(errors: AutomationStoreProblem[]): string {
  const [first] = errors
  if (!first) return 'Automations store operation failed.'
  if (errors.length === 1) return first.message
  return `${errors.length} automations store files are malformed or unreadable.`
}
