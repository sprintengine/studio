import type { AgentCli } from './electron-api'

// Which CLIs can resume a recorded conversation after their process is gone
// (app restart, freeze-the-view reap, Sprint Engine idle-retirement). Mirrors
// `capabilities.resumeSession` in resources/plugins/<id>/plugin.json. Kept as
// a static list because these predicates run synchronously inside store
// reducers and sync appliers where the main-process plugin registry is not
// reachable; the manifest-driven generalization is deferred to
// backlog/2026-07-05-manifest-driven-cli-resume-predicates.md.
export function agentCliSupportsConversationResume(cli: AgentCli | undefined): boolean {
  return cli === 'codex' || cli === 'claude-code' || cli === 'zai'
}

// Which CLIs resume with the session id WE mint and pass at launch
// (`--session-id <id>` on launch, `--resume <id>` on relaunch), so our
// terminal key doubles as the resume token. Mirrors
// `capabilities.sessionIdFromCaller`. Z.AI runs the same `claude` binary as
// claude-code (endpoint redirected via launch.env), so it shares this
// stable-session contract; codex mints its own ids and must stay excluded.
export function agentCliUsesStableSessionIdForResume(cli: AgentCli | undefined): boolean {
  return cli === 'claude-code' || cli === 'zai'
}
