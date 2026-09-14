# Sprint Engine Runtime State Policy

Sprint Engine run stores live under `<sidecar>/sprintengine/<team>/`, where
`<sidecar>` is the workspace's app-owned directory: `.sprintengine`, or
`.multi-code` in a workspace made before the 2026-09-08 rename. Nothing migrates
between the two names, so both are covered wherever this policy names a path.

A run store is local runtime state. New ones are ignored by default so agent
dispatch, projection, locks, metrics, and task movement do not pollute normal
source diffs.

Existing tracked run-store files are intentionally not deleted by this policy
change, including the ones already committed under the old name. Removing or
migrating historical tracked state is a separate repository-history cleanup
decision and should be reviewed outside a narrow implementation task.

Curated fixtures or durable evidence may live under these explicit paths:

- `<sidecar>/sprintengine/fixtures/`
- `<sidecar>/sprintengine/evidence/`
- `<sidecar>/sprintengine/README.md`

`.gitignore` allowlists all three under both sidecar names, so the rule holds
whichever directory a checkout has.

Use those paths only for reviewed, reusable inputs or evidence. Do not store
live `run.yaml`, task folders, artifact folders, `events.jsonl`,
`dispatch.jsonl`, `projection.json`, metrics, runner files, or locks as curated
fixtures unless a test or documentation path explicitly owns that snapshot.

Runtime mutation still belongs behind Sprint Engine tooling and the managed MCP
server. Agents must not hand-edit run-store files. One recorded exception:
`metrics/token-usage.jsonl` is appended by the Electron main process
(`src/main/sprintengine-token-sampling.ts`) — token usage is observable only
from the terminal runtime, never by the engine; the file is app-owned
telemetry the engine neither reads nor validates, and agents remain barred
from writing it. Manual cleanup is different:
the app's generic file-manager delete action may remove
`<sidecar>/sprintengine/<team>/` folders when an operator wants to clear local
runtime state.
