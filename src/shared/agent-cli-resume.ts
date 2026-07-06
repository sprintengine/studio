import type { PluginCapabilities } from './plugin-manifest'

// The two plugin-manifest capabilities that decide conversation-resume
// behavior, declared per CLI in resources/plugins/<id>/plugin.json. The
// predicates below are pure functions of these booleans, so any CLI that
// declares the capability resumes with zero code edits — there is no per-CLI
// allowlist to maintain (forgetting one silently lost the user's conversation,
// the MC-1464 Z.AI bug). Renderer call sites resolve a cli to these caps via
// `resumeCapabilitiesForCli` (pluginsSlice) against the projected catalog; the
// main process resolves them from the registry and stamps them onto the
// agent-terminal sync payload.
export type ResumeCapabilities = Pick<PluginCapabilities, 'resumeSession' | 'sessionIdFromCaller'>

// Whether a CLI can resume a recorded conversation after its process is gone
// (app restart, freeze-the-view reap, Sprint Engine idle-retirement). Mirrors
// `capabilities.resumeSession`.
export function agentCliSupportsConversationResume(caps: ResumeCapabilities | undefined): boolean {
  return caps?.resumeSession ?? false
}

// Whether a CLI resumes with the session id WE mint and pass at launch
// (`--session-id <id>` on launch, `--resume <id>` on relaunch), so our terminal
// key doubles as the resume token. Mirrors `capabilities.sessionIdFromCaller`.
// CLIs that mint their own id (Codex) must stay false — a bare `resume` (last
// session) is their correct default instead.
export function agentCliUsesStableSessionIdForResume(caps: ResumeCapabilities | undefined): boolean {
  return caps?.sessionIdFromCaller ?? false
}
