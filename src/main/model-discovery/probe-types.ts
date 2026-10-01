// The shapes the probe registry and its probes share, apart so the Agent SDK
// probe and the registry that lists it do not import each other.
import type { DiscoveredCliModel, DiscoveredCliModelCatalog } from '../../shared/cli-model-catalog'
import type { ExecutionHostId } from '../../shared/execution-host'

export type ArgvRunOutcome = { code: number; stdout: string; stderr: string; timedOut: boolean }

// What a probe gets to work with: the binary detection resolved (an absolute
// path when it found one, else the command name), the machine it runs on, and a runner
// that goes through the same host-shell plumbing as detection.
export type CliModelProbeContext = {
  cli: string
  displayName: string
  binary: string
  // Absent is this machine; a WSL distribution names itself.
  hostId?: ExecutionHostId
  timeoutMs: number
  runArgv: (args: string[]) => Promise<ArgvRunOutcome>
}

export type CliModelProbe = {
  source: DiscoveredCliModelCatalog['source']
  run: (context: CliModelProbeContext) => Promise<DiscoveredCliModel[]>
}

// Thrown with a sentence fit for the Settings line.
export class CliModelProbeError extends Error {}
