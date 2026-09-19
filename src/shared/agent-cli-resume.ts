import type { PluginCapabilities, PluginRegistryListEntry } from './plugin-manifest'

// The two plugin-manifest capabilities that decide conversation-resume
// behavior, declared per CLI in resources/plugins/<id>/plugin.json. The
// predicates below are pure functions of these booleans, so any CLI that
// declares the capability resumes with zero code edits — there is no per-CLI
// allowlist to maintain (forgetting one silently lost the user's conversation,
// the Z.AI resume bug). Renderer call sites resolve a cli to these caps via
// `resumeCapabilitiesForCli` (pluginsSlice) against the projected catalog; the
// main process resolves them from the registry and stamps them onto the
// agent-terminal sync payload.
export type ResumeCapabilities = Pick<PluginCapabilities, 'resumeSession' | 'sessionIdFromCaller'>

// Whether a CLI can resume a recorded conversation after its process is gone
// (app restart, freeze-the-view reap). Mirrors
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

// Resolve a CLI's conversation-resume capabilities from the projected plugin
// catalog. cli id == plugin id (pluginIdForCli is identity), so a direct id
// match is the lookup. Returns undefined when the CLI is absent from the catalog
// (unknown or not yet loaded); the resume predicates then read false. This is
// the pure half of the manifest-driven resume path — reducers/components
// pass the resolved caps to agentCliSupportsConversationResume /
// agentCliUsesStableSessionIdForResume instead of a hardcoded cli-id allowlist.
// Moved verbatim from `store/slices/pluginsSlice.ts` (which re-exports it) so
// main-process consumers can resolve caps from the same catalog shape.
export function resumeCapabilitiesForCli(
  cli: string | undefined,
  catalog: readonly PluginRegistryListEntry[],
): ResumeCapabilities | undefined {
  if (!cli) return undefined
  const entry = catalog.find((candidate) => candidate.id === cli)
  return entry ? { resumeSession: entry.resumeSession, sessionIdFromCaller: entry.sessionIdFromCaller } : undefined
}
