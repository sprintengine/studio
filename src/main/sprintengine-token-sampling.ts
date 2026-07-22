import { getPluginById } from './plugin-registry-instance'
import { pluginIdForCli } from './agent-launch-render'
import {
  appendTokenLedgerRecord,
  readSessionTokenUsage,
  type TokenUsageDeps,
} from './sprintengine-token-usage'

// Terminal-runtime glue for the Sprint Engine token ledger (v2): identity
// records when a sprint session's CLI id is captured, cumulative usage samples
// when the session ends or is disposed. Never throws and never blocks a
// terminal lifecycle transition — all errors are swallowed (a lost record
// degrades to unmeasured coverage at report time, which is the truthful
// fallback). Callers that can afford to wait (app shutdown) may await the
// returned promise; everyone else fire-and-forgets.

// Manifest probe shared with the report compute path: a CLI outside the
// built-in adapter map still reads its ~/.claude transcripts when its plugin
// manifest declares the Claude harness (same rule the agent-state reporter
// install uses in terminal-runtime.ts), so future Anthropic-compatible
// runtimes are measured without a hardcoded id list.
export function sprintTokenUsageDeps(): TokenUsageDeps {
  return {
    isClaudeHarnessCli: (cli) => {
      try {
        return getPluginById(pluginIdForCli(cli))?.manifest.skillIntegration?.harnessId === 'claude'
      } catch {
        return false
      }
    },
  }
}

type SprintSessionIdentity = {
  sprintEngineStatePath?: string
  agentId?: string
  sprintEngineRole?: string
  cli?: string
  cliSessionId?: string
}

function sprintTokenLedgerKey(session: SprintSessionIdentity):
  | { statePath: string; agentId: string; cli: string; cliSessionId: string }
  | null {
  if (!session.sprintEngineStatePath || !session.agentId || !session.cli || !session.cliSessionId) {
    return null
  }
  return {
    statePath: session.sprintEngineStatePath,
    agentId: session.agentId,
    cli: session.cli,
    cliSessionId: session.cliSessionId,
  }
}

// Append the session-identity record. Called when the lifecycle hook reports
// (or changes) a sprint session's cliSessionId and on SessionStart — the
// latter covers resume-seeded sessions whose id was already known at spawn,
// so the record lands in THIS run's ledger too. Appending per capture (not
// upserting) is what survives resumes: every id an agent ever used stays in
// the ledger and sums; the reader folds repeats.
//
// MC-1755: the two capture points fire within milliseconds for the same
// identity, which wrote every session row twice. An identical identity is
// appended once per app process — a NEW cliSessionId (resume, respawn) still
// appends, and an app restart re-appending an already-known identity is
// harmless because the reader folds repeats.
const recordedSessionIdentities = new Set<string>()

export function recordSprintSessionForTokenLedger(session: SprintSessionIdentity): void {
  const key = sprintTokenLedgerKey(session)
  if (!key) return
  const identity = `${key.statePath}|${key.agentId}|${key.cli}|${key.cliSessionId}`
  if (recordedSessionIdentities.has(identity)) return
  recordedSessionIdentities.add(identity)
  void appendTokenLedgerRecord(key.statePath, {
    kind: 'session',
    agentId: key.agentId,
    role: session.sprintEngineRole || undefined,
    cli: key.cli,
    cliSessionId: key.cliSessionId,
    at: new Date().toISOString(),
  }).catch(() => {})
}

// Read the session's cumulative usage now and append it as a durable sample.
// Called at terminal disposal (owner teardown, run completion, reap), on
// SessionEnd hook frames, and — awaited — from the app-shutdown teardown loop.
// An unmeasured read is still appended: it records that sampling was
// attempted; the report layer ignores unmeasured samples.
export function sampleSprintSessionTokenUsage(
  session: SprintSessionIdentity,
  reason: 'teardown' | 'session-end',
): Promise<void> {
  const key = sprintTokenLedgerKey(session)
  if (!key) return Promise.resolve()
  return readSessionTokenUsage(key.cli, key.cliSessionId, sprintTokenUsageDeps())
    .then((usage) =>
      appendTokenLedgerRecord(key.statePath, {
        kind: 'sample',
        agentId: key.agentId,
        cli: key.cli,
        cliSessionId: key.cliSessionId,
        measured: usage.measured,
        perModel: usage.perModel,
        sampledAt: usage.sampledAt,
        reason,
      }),
    )
    .catch(() => {})
}
