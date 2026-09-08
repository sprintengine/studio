// Display names for the guided-brief specialist agents, by agent id.
//
// Its own module, not `sessionAdapter.ts`: the sidebar names every session row
// through `workspaceManagerHelpers`, which needs exactly this map — and reading
// it from the adapter pulled the whole guided-brief terminal wiring (marker
// parser, interview protocol, session start/stop) into the eager boot chunk for
// four strings. `sessionAdapter` re-exports it, so its own importers are
// unchanged.
export const GUIDED_BRIEF_AGENT_LABELS: Record<string, string> = {
  'guided-brief-strategist': 'Product Strategist',
  'guided-brief-architect': 'Architect',
  'guided-brief-designer': 'Frontend Designer',
  'guided-brief-design-system': 'Design System Designer',
}
