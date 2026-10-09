import type { ModuleToastSink } from '../../modules/renderer-host'
import type { ShowToastInput } from '../../store/toastStore'

// A capability module's `RendererHost.toast`, as a toast in this window's one
// region (design-system/components/toast: the action row's fourth consumer).
// The module's words are the title; its name is always the description's
// lead, stamped by the host rather than written by the module, so a toast can
// never read as the app's own. At most one action, never primary — the
// module's toast is a report with a way onward, not a question — and pressing
// it takes the toast down first, as the background-chat toast's Open does.
export function createModuleToastSink(ports: {
  show: (input: ShowToastInput) => string
  dismiss: (id: string) => void
}): ModuleToastSink {
  return ({ tone, message, detail, action, moduleId, moduleName }) => {
    let id = ''
    id = ports.show({
      tone,
      title: message,
      description: detail ? `${moduleName} · ${detail}` : moduleName,
      ...(action
        ? {
            actions: [
              {
                id: `module-action:${moduleId}`,
                label: action.label,
                run: () => {
                  ports.dismiss(id)
                  void action.run()
                },
              },
            ],
          }
        : {}),
    })
    return () => ports.dismiss(id)
  }
}
