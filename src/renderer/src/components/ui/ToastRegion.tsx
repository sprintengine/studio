import { Toast } from './Toast'
import { useToastStore } from '../../store/toastStore'

// The corner stack the toast spec reserves (design-system/components/toast):
// ONE region per document, fixed bottom-trailing, newest at the bottom,
// `space.sm` apart, at `z.toast`. Every toast producer routes through the
// store behind this — two corners announcing at once is two voices.
//
// The wrapper swallows no clicks (`pointer-events-none`); each toast surface
// reclaims its own, so an empty or animating region never blocks the pane
// under the corner. The region itself draws nothing; the card is the glass
// (Toast.tsx), the one blurred surface the design system allows.
export function ToastRegion() {
  const toasts = useToastStore((state) => state.toasts)
  const dismissToast = useToastStore((state) => state.dismissToast)
  if (toasts.length === 0) return null
  return (
    <div
      className="pointer-events-none fixed bottom-4 right-4 z-[var(--z-toast)] flex w-[340px] flex-col gap-2"
      role="presentation"
    >
      {toasts.map((toast) => (
        <Toast
          key={toast.id}
          tone={toast.tone}
          title={toast.title}
          description={toast.description}
          cli={toast.cli}
          actions={toast.actions}
          autoDismissMs={toast.autoDismissMs}
          onDismiss={() => dismissToast(toast.id)}
          className="pointer-events-auto"
        />
      ))}
    </div>
  )
}
