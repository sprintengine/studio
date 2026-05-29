import MulticodeSpinner from '../brand/MulticodeSpinner'

// Branded fallback for lazy (`React.lazy` + `Suspense`) surfaces — the Settings
// overlay, the new-workspace wizard, and the first-run onboarding workspace step.
// Centers the brand spinner and fills its container. The `.suspense-fallback`
// class delays the fade-in (see index.css) so a fast chunk load never flashes.
export function SuspenseFallback({ label = 'Loading' }: { label?: string }) {
  return (
    <div
      role="status"
      aria-busy="true"
      className="suspense-fallback flex h-full w-full flex-1 items-center justify-center"
    >
      <MulticodeSpinner className="h-8 w-8" label={label} />
    </div>
  )
}
