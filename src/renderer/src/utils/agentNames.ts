// Agent naming moved to `src/shared/agent-names.ts` when the main-process
// AgentLaunchService took over launch composition (MC-2159): main names the
// agents it launches, and it must draw from the same pool with the same
// collision rule the UI uses or a headless launch would mint a duplicate name.
// Pure string/array logic, so it moved rather than being duplicated.
export * from '../../../shared/agent-names'
