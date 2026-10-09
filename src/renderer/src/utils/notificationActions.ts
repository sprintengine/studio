import type { AppNotification } from '../types/workspace'
import type {
  NotificationAction,
  NotificationActionContext,
  RegisteredNotificationActionProvider,
} from '../modules/renderer-host'

// The shape a notification row consumes (id + label + a fire-and-forget run).
// Structurally identical to NotificationsPopover's NotificationRowAction, kept
// here so this pure helper does not import the component graph.
export type ResolvedNotificationAction = {
  id: string
  label: string
  run: () => void | Promise<void>
}

// Resolve the actions a notification row should offer.
//
// A module provider that owns the notification's `source` can return deep-focus
// actions (e.g. open a module's own record, or open the global Automations
// screen at a specific run). Provider actions are offered whether or not the
// notification names a workspace — a provider may deep-link to an app-level
// screen that has no backing workspace at all (Automations). Only the generic
// workspace-reveal fallback needs a `workspaceId`: a source with no provider
// match falls back to "Open → reveal that workspace", but only while that
// workspace still exists — a notification outlives the workspace it names, and
// an Open that goes nowhere is worse than none. A notification with neither a
// provider action nor a live workspace gets no actions.
//
// `providers` must already be filtered by module enablement by the caller, so a
// disabled module contributes nothing — exactly like Backlog item actions. Pure
// (no React, store, or module-host access) so the gating is unit-testable.
//
// A capability module's own `notify` row (source `module`) is resolved
// differently, because its identity is the host's stamp rather than a source
// tag anyone could claim: its Open is the door it named as `surfaceTarget`
// (only ever one of that module's own surfaces — `openModuleSurface` refuses
// any other), and the only provider that may add to it is the one the SAME
// module registered under its own id. It never falls back to a workspace
// reveal: a module row names no workspace.
export function resolveNotificationActions(input: {
  notification: AppNotification
  providers: ReadonlyArray<RegisteredNotificationActionProvider>
  revealWorkspace: (workspaceId: string) => void
  workspaceExists: (workspaceId: string) => boolean
  /**
   * The opener for a module row's door, or null when the target is not that
   * module's own surface (or the module is off). The kernel's
   * `moduleSurfaceTargetOpener`. Absent, module rows get provider actions only.
   */
  openModuleSurface?: (moduleId: string, target: { surfaceId: string; viewId?: string }) => (() => void) | null
}): ResolvedNotificationAction[] {
  const { notification, providers, revealWorkspace, workspaceExists } = input
  const workspaceId = notification.workspaceId
  const context: NotificationActionContext = { notification, revealWorkspace }
  if (notification.source === 'module') return resolveModuleRowActions(input, context)
  const providerActions = providers
    .filter((provider) => provider.source === notification.source)
    .flatMap((provider) => provider.resolveActions(context))
    .filter((action) => (action.isVisible ? action.isVisible(context) : true))
  const actions: NotificationAction[] =
    providerActions.length > 0
      ? providerActions
      : workspaceId && workspaceExists(workspaceId)
        ? [
            {
              id: 'reveal-workspace',
              label: 'Open',
              run: (ctx: NotificationActionContext) => ctx.revealWorkspace(workspaceId),
            },
          ]
        : []
  return actions.map((action) => ({
    id: action.id,
    label: action.label,
    run: () => action.run(context),
  }))
}

function resolveModuleRowActions(
  input: Parameters<typeof resolveNotificationActions>[0],
  context: NotificationActionContext,
): ResolvedNotificationAction[] {
  const { notification, providers, openModuleSurface } = input
  const moduleId = notification.sourceModule?.id
  if (!moduleId) return []
  const actions: ResolvedNotificationAction[] = []
  const target = notification.surfaceTarget
  const open = target ? (openModuleSurface?.(moduleId, target) ?? null) : null
  if (open) actions.push({ id: 'open-module-surface', label: 'Open', run: open })
  for (const provider of providers) {
    if (provider.moduleId !== moduleId || provider.source !== moduleId) continue
    for (const action of provider.resolveActions(context)) {
      if (action.isVisible && !action.isVisible(context)) continue
      actions.push({ id: action.id, label: action.label, run: () => action.run(context) })
    }
  }
  return actions
}
