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
export function resolveNotificationActions(input: {
  notification: AppNotification
  providers: ReadonlyArray<RegisteredNotificationActionProvider>
  revealWorkspace: (workspaceId: string) => void
  workspaceExists: (workspaceId: string) => boolean
}): ResolvedNotificationAction[] {
  const { notification, providers, revealWorkspace, workspaceExists } = input
  const workspaceId = notification.workspaceId
  const context: NotificationActionContext = { notification, revealWorkspace }
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
