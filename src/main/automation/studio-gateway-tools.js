import { SPRINTENGINE_MUTATING_TOOL_NAMES, SPRINTENGINE_TOOL_DEFINITIONS, } from '../../shared/sprintengineToolNames.generated';
import { TAILNET_MUTATION_TOOL_NAMES } from './tailnet/tailnet-tools';
import { isMcpToolResult, isRecord, toolError, } from '../../shared/modules/mcp-tools';
const APP_MUTATION_TOOLS = new Set([
    'agent.launch',
    'automation.create',
    'automation.run',
    'backlog.assign',
    'backlog.repair',
    'backlog.update',
    'backlog.work',
    'horizon.add_step',
    'horizon.approve',
    'horizon.configure',
    'horizon.create',
    'horizon.merge',
    'horizon.pause',
    'horizon.remove_step',
    'horizon.reorder',
    'horizon.resume',
    'horizon.skip',
    'sprint.artifact.approve',
    'sprint.artifact.request_changes',
    'sprint.cancel',
    'sprint.create',
    'sprint.pr.create',
    'sprint.pr.status',
    'sprint.resume',
    'sprint.set_mode',
    'sprint.task.comment',
    'sprint.task.create',
    'sprint.task.resolve_input',
    'sprint.task.set_status',
    'sprint.task.update',
    // Configuring who may drive this machine. Classified as mutations so every
    // one of them is audited — minting a pairing code is the most consequential
    // write on this surface. The tailnet listener never serves them at all
    // (`isLocalOnlyGatewayTool`), so unlike every other entry here their scope
    // mapping is never consulted.
    ...TAILNET_MUTATION_TOOL_NAMES,
    // Opening a terminal on this machine (MC-2166). Classified here and nowhere
    // else: the tailnet scope mapping reads this same classification, so being a
    // mutation is what makes `terminal.create` require `terminal:control` rather
    // than the watch-only `terminal:observe` — and what makes every attempt,
    // including a refused one, land in the audit with the device that made it.
    'terminal.create',
    'workspace.create',
    // The mobile companion's command envelope over the gateway
    // (tailnet-mobile-transport). A mutation for both of its consequences: a
    // paired phone needs `workspace:operate` to drive it, and every dispatch —
    // including a refused one — lands in the audit with the device identity.
    // `workspace.snapshot` deliberately is NOT here: it is the phone's read
    // model and maps to `workspace:read` like every other read.
    'workspace.mobile_command',
    // The one review tool that writes: it persists brief.json. The three review
    // reads (list/get-changeset/get-brief) are not mutations.
    'review_submit_brief',
]);
const RUN_MUTATION_TOOLS = new Set(SPRINTENGINE_MUTATING_TOOL_NAMES);
// Builds the gateway's per-request tool resolver. Core tools (the app tools
// plus the canonical Sprint Engine run tools) are merged once, failing fast at
// construction on a duplicate. Module-contributed tools are read from the host
// kernel on EVERY call — the gateway is constructed before modules load, and
// availability must follow module enablement live (MC-1855) — and each one is
// gated on its owner's enablement: a disabled module's tools stay listed and
// answer an actionable enable error instead of running (MC-1805 re-homed).
export function createStudioGatewayTools(options) {
    const coreNames = new Set();
    const requireUnique = (name) => {
        if (coreNames.has(name)) {
            throw new Error(`Duplicate SprintEngine Studio MCP tool registration: ${name}`);
        }
        coreNames.add(name);
    };
    for (const registration of options.appTools)
        requireUnique(registration.name);
    const runTools = SPRINTENGINE_TOOL_DEFINITIONS.map((definition) => ({
        name: definition.name,
        description: definition.description,
        inputSchema: definition.inputSchema,
        handler: (args, context) => callRunTool(options.sprintEngineMcpHub, definition.name, args, context ?? { metadata: { kind: 'external-local' } }),
    }));
    for (const registration of runTools)
        requireUnique(registration.name);
    // The resolver runs per request; a persistent shadowing module would emit the
    // same collision warning on every tools/list without this once-guard.
    const warnedCollisions = new Set();
    return () => {
        const merged = [...options.appTools];
        const names = new Set(coreNames);
        for (const contribution of options.resolveModuleTools()) {
            const { registration } = contribution;
            // Module-vs-module collisions are already rejected at registration by
            // the kernel; this guards a module shadowing a CORE tool name, which the
            // kernel cannot know. First (core) wins so the gateway keeps serving.
            if (names.has(registration.name)) {
                const collisionKey = `${contribution.moduleId}:${registration.name}`;
                if (!warnedCollisions.has(collisionKey)) {
                    warnedCollisions.add(collisionKey);
                    options.warn?.(`MCP tool "${registration.name}" from module "${contribution.moduleId}" collides with a core gateway tool and is not served.`);
                }
                continue;
            }
            names.add(registration.name);
            merged.push(gateOnModuleEnablement(contribution, options.isModuleEnabled));
        }
        merged.push(...runTools);
        return merged;
    };
}
// The user's module switch reaches the MCP surface (MC-1805 owner ruling): the
// tool keeps being advertised so an agent learns the capability exists, and a
// call while the owner is disabled answers one plain, actionable sentence as a
// normal MCP tool result — never a protocol error, never the orphaned handler.
function gateOnModuleEnablement(contribution, isModuleEnabled) {
    const { moduleId, moduleDisplayName, registration } = contribution;
    return {
        ...registration,
        handler: async (args, context) => isModuleEnabled(moduleId)
            ? registration.handler(args, context)
            : toolError(`${moduleId}_module_disabled`, `The ${moduleDisplayName} module is disabled. Enable it in Settings → Modules to use ${moduleId} tools.`),
    };
}
export function isStudioGatewayMutation(toolName) {
    return APP_MUTATION_TOOLS.has(toolName) || RUN_MUTATION_TOOLS.has(toolName);
}
async function callRunTool(hub, toolName, args, context) {
    const runId = context.metadata.sprintRunId;
    if (!runId) {
        return toolError('no_active_sprint', 'This MCP connection has no active Sprint Engine run. Launch or enter a sprint in SprintEngine Studio, then use that sprint agent connection.');
    }
    try {
        const result = await hub.callRunTool({ runId, toolName, arguments: args });
        if (isMcpToolResult(result))
            return result;
        return {
            content: [{ type: 'text', text: JSON.stringify(result) }],
            structuredContent: isRecord(result) ? result : { result },
        };
    }
    catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        const code = /module is disabled|module is unavailable/i.test(text)
            ? 'sprintengine_module_disabled'
            : /not registered|not ready/i.test(text)
                ? 'no_active_sprint'
                : 'sprintengine_proxy_error';
        return toolError(code, text);
    }
}
