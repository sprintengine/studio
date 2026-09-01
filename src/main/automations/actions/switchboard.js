export const SWITCHBOARD_AUTOMATION_INTEGRATION_ID = 'module:switchboard';
export const WATCHTOWER_AUTOMATION_INTEGRATION_ID = 'module:watchtower';
export const SWITCHBOARD_RUNNER_TICK_ACTION_KIND = 'switchboard-runner-tick';
export const WATCHTOWER_REVIEW_ACTION_KIND = 'watchtower-review';
export function createSwitchboardAutomationActionProviders(frontDoors) {
    return [
        createSwitchboardRunnerTickActionProvider(frontDoors),
        createWatchtowerReviewActionProvider(frontDoors),
    ];
}
function createSwitchboardRunnerTickActionProvider(frontDoors) {
    return {
        kind: SWITCHBOARD_RUNNER_TICK_ACTION_KIND,
        configSchema: {
            type: 'object',
            properties: {},
        },
        requiredIntegrations: [SWITCHBOARD_AUTOMATION_INTEGRATION_ID],
        run: async (_config, ctx) => {
            ctx.requireIntegration(SWITCHBOARD_AUTOMATION_INTEGRATION_ID);
            const result = await frontDoors.tickRunner({ workspaceRoot: ctx.workspaceRoot });
            if (!result.ok)
                return failedRun(result.message);
            return {
                status: 'completed',
                summary: `Switchboard runner tick completed with ${result.activeExecutions.length} active execution${result.activeExecutions.length === 1 ? '' : 's'}.`,
            };
        },
    };
}
function createWatchtowerReviewActionProvider(frontDoors) {
    return {
        kind: WATCHTOWER_REVIEW_ACTION_KIND,
        configSchema: {
            type: 'object',
            required: ['preset'],
            properties: {
                preset: {
                    type: 'string',
                    minLength: 1,
                    enum: [
                        'lean_code_review',
                        'ui_brand_alignment_review',
                        'performance_focused_review',
                        'security_deep_review',
                        'full_product_review',
                    ],
                },
            },
        },
        requiredIntegrations: [WATCHTOWER_AUTOMATION_INTEGRATION_ID],
        run: async (config, ctx) => {
            ctx.requireIntegration(WATCHTOWER_AUTOMATION_INTEGRATION_ID);
            const parsed = parseWatchtowerReviewConfig(config);
            const result = await frontDoors.startWatchtowerReview({
                workspaceRoot: ctx.workspaceRoot,
                preset: parsed.preset,
            });
            if (!result.ok)
                return failedRun(result.message);
            return {
                status: 'completed',
                summary: `Started Watchtower review ${result.run.runId}.`,
            };
        },
    };
}
function parseWatchtowerReviewConfig(config) {
    if (!isRecord(config))
        throw new Error('watchtower-review config must be an object.');
    const preset = optionalString(config.preset);
    if (!preset)
        throw new Error('watchtower-review config requires a preset.');
    return { preset };
}
function failedRun(message) {
    return {
        status: 'failed',
        summary: message,
    };
}
function optionalString(value) {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}
function isRecord(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
