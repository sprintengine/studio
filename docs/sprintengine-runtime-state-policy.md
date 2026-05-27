# Sprint Engine Runtime State Policy

Sprint Engine run stores under `.multi-code/sprintengine/<team>/` are local
runtime state. New run stores are ignored by default so agent dispatch,
projection, locks, metrics, and task movement do not pollute normal source
diffs.

Existing tracked `.multi-code/sprintengine/**` files are intentionally not
deleted by this policy change. Removing or migrating historical tracked state is
a separate repository-history cleanup decision and should be reviewed outside a
narrow implementation task.

Curated fixtures or durable evidence may live under these explicit paths:

- `.multi-code/sprintengine/fixtures/`
- `.multi-code/sprintengine/evidence/`
- `.multi-code/sprintengine/README.md`

Use those paths only for reviewed, reusable inputs or evidence. Do not store
live `run.yaml`, task folders, artifact folders, `events.jsonl`,
`dispatch.jsonl`, `projection.json`, metrics, runner files, or locks as curated
fixtures unless a test or documentation path explicitly owns that snapshot.

Runtime mutation still belongs behind Sprint Engine tooling and the managed MCP
server. Agents must not hand-edit run-store files.
