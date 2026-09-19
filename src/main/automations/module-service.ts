import type {
  AutomationDefinition,
  AutomationRun,
  AutomationsRunEvent,
  ModuleAutomationsError,
  ModuleAutomationsResult,
} from '../../shared/automations/contracts'
import type { WorkspaceSyncSnapshot } from '../../shared/workspace-sync'
import {
  createDefinitionWriteCore,
  parseDefinitionDraft,
  parseDefinitionPatch,
  validateKnownWorkspaceRoot,
  type DefinitionPrecondition,
  type DefinitionWriteDeps,
  type DefinitionWriteResult,
} from './definition-write'
import { isRecord } from '../../shared/records'

// The module-scoped Automations service: the app-side registry behind the
// SDK's `getAutomationsService(host)` helper (token
// 'automations.module-service'). Every method takes the calling module's id
// first; the SDK helper closes over `host.moduleId`, mirroring the provider
// registry's scoping pattern. Ownership rules:
//   - create stamps `ownerModuleId` from the scoped module (a draft claiming a
//     different module is refused);
//   - update/delete/listRuns refuse records the module does not own — an
//     unowned (user-created) record is `not_owner` too. The ownership check on
//     update/delete runs as a write-core precondition against the same read
//     the write uses, so a concurrent delete-and-recreate cannot slip a write
//     past a stale check;
//   - list returns only owned records;
//   - onRunEvent delivers only events whose automation the module owns.
// Permission note (epic decision): `automations.manage` is install-time
// disclosure; this service does not runtime-check it.

export type ModuleAutomationsRegistry = {
  create(
    moduleId: string,
    input: { workspaceRoot: string; draft: unknown },
  ): Promise<ModuleAutomationsResult<{ automation: AutomationDefinition }>>
  update(
    moduleId: string,
    input: { workspaceRoot: string; automationId: string; patch: unknown },
  ): Promise<ModuleAutomationsResult<{ automation: AutomationDefinition }>>
  delete(
    moduleId: string,
    input: { workspaceRoot: string; automationId: string },
  ): Promise<ModuleAutomationsResult<object>>
  list(
    moduleId: string,
    input: { workspaceRoot: string },
  ): Promise<ModuleAutomationsResult<{ automations: AutomationDefinition[] }>>
  listRuns(
    moduleId: string,
    input: { workspaceRoot: string; automationId: string },
  ): Promise<ModuleAutomationsResult<{ runs: AutomationRun[] }>>
  onRunEvent(moduleId: string, listener: (event: AutomationsRunEvent) => void): () => void
  /**
   * Engine-side fan-out entry: notify subscribers owning the event's
   * automation. The definition arrives from the engine's emit site (which
   * always has it), so ownership is never re-derived from the event's
   * workspaceId — that can name the run-hosting workspace, not the one whose
   * store holds the definition.
   */
  deliverRunEvent(event: AutomationsRunEvent, definition: AutomationDefinition): void
  /** Drop all subscribers (automations module teardown). */
  dispose(): void
}

export type ModuleAutomationsRegistryDeps = DefinitionWriteDeps & {
  /** Same snapshot the IPC front door validates workspace roots against. */
  getWorkspaceSyncSnapshot?: () => WorkspaceSyncSnapshot
}

// Write-core failure codes → the module-facing vocabulary. Draft/config
// problems are the caller's to fix; store misses are not_found; workspace-root
// validation failures are the caller naming a folder the app does not have
// open.
function moduleErrorCode(code: string): ModuleAutomationsError {
  if (code === 'missing') return 'not_found'
  if (code === 'not_owner') return 'not_owner'
  if (
    code === 'invalid_input' ||
    code === 'unknown_trigger' ||
    code === 'unknown_action' ||
    code === 'invalid_schedule' ||
    code === 'invalid_trigger_config' ||
    code === 'provider_blocked' ||
    code === 'next_run_unavailable'
  ) {
    return 'invalid_draft'
  }
  return 'store_error'
}

function refuse<T>(code: ModuleAutomationsError, message: string): ModuleAutomationsResult<T> {
  return { ok: false, code, message }
}

function refuseFrom<T>(failure: { code: string; message: string }): ModuleAutomationsResult<T> {
  return refuse(moduleErrorCode(failure.code), failure.message)
}

export function createModuleAutomationsRegistry(deps: ModuleAutomationsRegistryDeps): ModuleAutomationsRegistry {
  const writeCore = createDefinitionWriteCore(deps)
  const subscribers = new Set<{ moduleId: string; listener: (event: AutomationsRunEvent) => void }>()

  // Post-write hook failures (webhook receiver refresh) never fail a module
  // write: the record is already persisted, and failing here wedges callers in
  // retry loops against 'already_exists'. Log and move on; schedule-triggered
  // automations do not involve the receiver at all.
  function unwrapWrite<T>(result: DefinitionWriteResult<T>): ModuleAutomationsResult<{ value: T }> {
    if (!result.ok) return refuseFrom(result)
    if (result.postWriteFailure) {
      console.warn(
        `[automations] module write succeeded but the post-write refresh failed: ${result.postWriteFailure.message}`,
      )
    }
    return { ok: true, value: result.value }
  }

  function knownWorkspaceRoot(workspaceRoot: unknown): ModuleAutomationsResult<{ root: string }> {
    if (typeof workspaceRoot !== 'string' || workspaceRoot.trim() === '') {
      return refuse('invalid_workspace', 'workspaceRoot is required.')
    }
    // Every validation failure here is about the root, whatever the shared
    // validator's internal code says (invalid_input, workspace_root_untrusted…).
    const validated = validateKnownWorkspaceRoot(workspaceRoot.trim(), deps.getWorkspaceSyncSnapshot)
    if (!validated.ok) return refuse('invalid_workspace', validated.message)
    return { ok: true, root: validated.value }
  }

  function ownedBy(moduleId: string, automationId: string): DefinitionPrecondition {
    return (existing) =>
      existing.ownerModuleId === moduleId
        ? { ok: true }
        : {
            ok: false,
            code: 'not_owner',
            message: `Automation "${automationId}" is not owned by module "${moduleId}".`,
          }
  }

  return {
    async create(moduleId, input) {
      const root = knownWorkspaceRoot(input.workspaceRoot)
      if (!root.ok) return root
      // The parse strips any caller-supplied owner, so check the claim on the
      // raw draft first: echoing your own id is tolerated, claiming another
      // module's identity is refused rather than silently rewritten.
      const claimedOwner = isRecord(input.draft) ? input.draft.ownerModuleId : undefined
      if (claimedOwner !== undefined && claimedOwner !== moduleId) {
        return refuse(
          'invalid_draft',
          `Draft ownerModuleId "${String(claimedOwner)}" does not match the calling module "${moduleId}"; omit it — ownership is stamped by the host.`,
        )
      }
      const draft = parseDefinitionDraft(input.draft)
      if (!draft.ok) return refuseFrom(draft)
      const created = unwrapWrite(await writeCore.create(root.root, { ...draft.value, ownerModuleId: moduleId }))
      if (!created.ok) return created
      return { ok: true, automation: created.value }
    },

    async update(moduleId, input) {
      const root = knownWorkspaceRoot(input.workspaceRoot)
      if (!root.ok) return root
      const patch = parseDefinitionPatch(input.patch)
      if (!patch.ok) return refuseFrom(patch)
      const written = unwrapWrite(
        await writeCore.update(root.root, input.automationId, patch.value, ownedBy(moduleId, input.automationId)),
      )
      if (!written.ok) return written
      return { ok: true, automation: written.value }
    },

    async delete(moduleId, input) {
      const root = knownWorkspaceRoot(input.workspaceRoot)
      if (!root.ok) return root
      const deleted = unwrapWrite(
        await writeCore.remove(root.root, input.automationId, ownedBy(moduleId, input.automationId)),
      )
      if (!deleted.ok) return deleted
      return { ok: true }
    },

    async list(moduleId, input) {
      const root = knownWorkspaceRoot(input.workspaceRoot)
      if (!root.ok) return root
      const definitions = await deps.createStore(root.root).listDefinitions()
      if (!definitions.ok) {
        const first = definitions.errors[0]
        return refuse('store_error', first ? `${first.path}: ${first.message}` : 'Automations store is unreadable.')
      }
      return {
        ok: true,
        automations: definitions.values.filter((definition) => definition.ownerModuleId === moduleId),
      }
    },

    async listRuns(moduleId, input) {
      const root = knownWorkspaceRoot(input.workspaceRoot)
      if (!root.ok) return root
      const existing = await writeCore.get(root.root, input.automationId)
      if (!existing.ok) return refuseFrom(existing)
      const owned = ownedBy(moduleId, input.automationId)(existing.value)
      if (!owned.ok) return refuseFrom(owned)
      const runs = await deps.createStore(root.root).listRuns(input.automationId)
      if (!runs.ok) {
        const first = runs.errors[0]
        return refuse('store_error', first ? `${first.path}: ${first.message}` : 'Run history is unreadable.')
      }
      return { ok: true, runs: runs.values }
    },

    onRunEvent(moduleId, listener) {
      const entry = { moduleId, listener }
      subscribers.add(entry)
      return () => subscribers.delete(entry)
    },

    deliverRunEvent(event, definition) {
      const ownerModuleId = definition.ownerModuleId
      if (!ownerModuleId) return
      for (const entry of subscribers) {
        if (entry.moduleId !== ownerModuleId) continue
        try {
          entry.listener(event)
        } catch {
          // Subscriber delivery is best-effort; run records stay authoritative.
        }
      }
    },

    dispose() {
      subscribers.clear()
    },
  }
}
