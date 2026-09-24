import type { JSX } from 'react'
import { ProviderStateId } from './ProviderRow'
import { cliProviderStateWords, type CliProviderState } from './cliProviderState'

// The rendered state line for an agent CLI, one implementation for every host.
// Words from `cliProviderStateWords`, identifiers mono, and nothing else: a
// state line that starts explaining what a CLI is has become a caption.
//
// "Ready" alone would be a weaker line than the surface can carry — which
// binary a provider resolved to is the fact a user comes to this list for, and
// it is invisible everywhere else. So the resolved path rides the line as its
// identifier, and a CLI on another machine of this computer (a WSL
// distribution: a different runtime, same binary name) names that machine
// rather than leaving it to be inferred from the platform.
export function CliProviderStateLine({
  state,
  binary,
  machineLabel,
  probeError,
}: {
  state: CliProviderState
  binary: string
  /** The machine the CLI was found on, when it is not this one ("WSL: Ubuntu"). */
  machineLabel?: string | null
  probeError?: string | null
}): JSX.Element {
  const words = cliProviderStateWords(state, { binary, probeError })
  return (
    <>
      {words}
      {state.resolvedPath ? (
        <>
          {' — '}
          <ProviderStateId>{state.resolvedPath}</ProviderStateId>
        </>
      ) : null}
      {state.installed && machineLabel ? ` · ${machineLabel}` : null}
    </>
  )
}
