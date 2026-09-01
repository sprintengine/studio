import { parseSpawnAgentConfig, runSpawnAgentAction } from './spawn-agent';
export function createRunSkillLoopActionProvider() {
    return {
        kind: 'run-skill-loop',
        configSchema: {
            type: 'object',
            required: ['prompt'],
            properties: {
                folderPath: { type: 'string', minLength: 1 },
                workspaceId: { type: 'string', minLength: 1 },
                cli: { type: 'string', minLength: 1 },
                name: { type: 'string', minLength: 1 },
                prompt: { type: 'string', minLength: 1 },
                skill: { type: 'string', minLength: 1 },
                includeTriggerContext: { type: 'boolean' },
                requiredIntegrations: {
                    type: 'array',
                    items: { type: 'string', minLength: 1 },
                },
            },
        },
        requiredIntegrations: [],
        run: async () => {
            throw new Error('run-skill-loop provider must be run through runSkillLoopAction.');
        },
    };
}
export async function runSkillLoopAction(config, runtime) {
    const parsed = parseRunSkillLoopConfig(config);
    const loopPrompt = [
        `/loop ${parsed.skill ?? 'skill'}`,
        '',
        parsed.prompt,
    ].join('\n');
    return runSpawnAgentAction({
        ...parsed,
        name: parsed.name ?? `${runtime.definition.name} loop`,
        prompt: loopPrompt,
    }, runtime);
}
function parseRunSkillLoopConfig(config) {
    const parsed = parseSpawnAgentConfig(config);
    return {
        ...parsed,
        skill: isRecord(config) && typeof config.skill === 'string' && config.skill.trim()
            ? config.skill.trim()
            : undefined,
    };
}
function isRecord(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
