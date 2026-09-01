import { isTailnetScope, TAILNET_SCOPES, TAILNET_STRUCTURED_SCOPES, } from '../../../shared/tailnet';
import { toolError, toolSuccess } from '../../../shared/modules/mcp-tools';
/** The `tailnet.*` tools that change state, for `isStudioGatewayMutation`. */
export const TAILNET_MUTATION_TOOL_NAMES = [
    'tailnet.set_enabled',
    'tailnet.offer_pairing',
    'tailnet.cancel_pairing',
    'tailnet.revoke_device',
];
export function createTailnetTools(options) {
    const unavailable = toolError('tailnet_unavailable', 'Tailnet remote control is not wired up in this process yet. Retry once the app has finished starting.');
    const front = () => options.resolveTailnet();
    const status = {
        name: 'tailnet.status',
        description: 'Read tailnet remote control on this machine: whether it is enabled, whether the listener is actually running '
            + 'and on what endpoint, this machine\'s Tailscale address, the paired devices, and the outstanding pairing offer '
            + '(its scopes and expiry — never the code itself). Served only over the local socket.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        handler: async () => {
            const service = front();
            if (!service)
                return unavailable;
            return toolSuccess({ status: service.getTailnetStatus() });
        },
    };
    const setEnabled = {
        name: 'tailnet.set_enabled',
        description: 'Turn tailnet remote control on or off on this machine. Turning it on starts the listener only if Tailscale is '
            + 'up — with no tailnet interface the setting persists and the call reports why nothing is listening. Turning it '
            + 'off stops the listener and drops any outstanding pairing offer; already-paired devices keep their tokens '
            + '(use tailnet.revoke_device for those). Served only over the local socket.',
        inputSchema: {
            type: 'object',
            properties: { enabled: { type: 'boolean', description: 'True to start the listener, false to stop it.' } },
            required: ['enabled'],
            additionalProperties: false,
        },
        handler: async (args) => {
            const service = front();
            if (!service)
                return unavailable;
            if (typeof args.enabled !== 'boolean') {
                return toolError('invalid_enabled', '"enabled" must be true or false.');
            }
            const next = await service.setTailnetEnabled(args.enabled);
            // Asked to enable and nothing is listening is a failed request, not a
            // quiet partial success — the setting persisted, and the answer says so
            // alongside the reason so the caller does not go on to mint a code.
            if (args.enabled && !next.running) {
                return toolError('tailnet_listener_not_running', `The setting is saved, but nothing is listening. ${next.lastError ?? 'The listener did not start.'}`);
            }
            return toolSuccess({ status: next });
        },
    };
    const offerPairing = {
        name: 'tailnet.offer_pairing',
        description: 'Mint a one-time pairing code for another machine to redeem, valid for 30 days. Returns the code and the '
            + 'multicode-tailnet:// pairing URL ONCE — neither is re-readable afterwards, and neither is ever returned by '
            + 'tailnet.status. Replaces any outstanding offer, including one a person is part-way through using in Settings. '
            + 'The code does not survive an app restart. Served only over the local socket.',
        inputSchema: {
            type: 'object',
            properties: {
                scopes: {
                    type: 'array',
                    items: { type: 'string', enum: [...TAILNET_SCOPES] },
                    description: 'Scopes to grant the device that redeems this code. Defaults to the structured-command set '
                        + `(${TAILNET_STRUCTURED_SCOPES.join(', ')}). The terminal tier means arbitrary shell on this machine and `
                        + 'is only ever granted by naming it here.',
                },
            },
            additionalProperties: false,
        },
        handler: async (args) => {
            const service = front();
            if (!service)
                return unavailable;
            const scopes = args.scopes === undefined ? undefined : readScopes(args.scopes);
            if (typeof scopes === 'string')
                return toolError('invalid_scopes', scopes);
            // The same rule the Settings panel enforces: a pairing code is a URL
            // pointing at a listener, so minting one while nothing is listening
            // produces a credential that cannot be redeemed anywhere.
            const current = service.getTailnetStatus();
            if (!current.running) {
                return toolError('tailnet_not_running', current.enabled
                    ? `Tailnet remote control is enabled but not listening, so a pairing code would point at nothing. ${current.lastError ?? 'Check that Tailscale is up.'}`
                    : 'Tailnet remote control is off. Turn it on with tailnet.set_enabled first — a pairing code is a link to a listener.');
            }
            const offer = service.offerTailnetPairing(scopes ? { scopes } : undefined);
            return toolSuccess({
                pairing: offer,
                // Stated rather than left to be inferred from the timestamp: this is the
                // one call whose result stops being obtainable the moment it returns.
                note: 'The code and pairing URL are shown once. They are not recoverable from tailnet.status, and an app restart invalidates an unredeemed offer.',
            });
        },
    };
    const cancelPairing = {
        name: 'tailnet.cancel_pairing',
        description: 'Withdraw the outstanding pairing offer so the code can no longer be redeemed. Devices already paired are '
            + 'unaffected. Succeeds whether or not an offer was outstanding. Served only over the local socket.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        handler: async () => {
            const service = front();
            if (!service)
                return unavailable;
            return toolSuccess({ status: service.cancelTailnetPairing() });
        },
    };
    const revokeDevice = {
        name: 'tailnet.revoke_device',
        description: 'Revoke a paired device by id (from tailnet.status). Its token stops working on the very next request and any '
            + 'live terminal stream it holds is closed immediately. Served only over the local socket.',
        inputSchema: {
            type: 'object',
            properties: { deviceId: { type: 'string', description: 'Device id from tailnet.status.' } },
            required: ['deviceId'],
            additionalProperties: false,
        },
        handler: async (args) => {
            const service = front();
            if (!service)
                return unavailable;
            const deviceId = typeof args.deviceId === 'string' ? args.deviceId.trim() : '';
            if (!deviceId)
                return toolError('invalid_device_id', '"deviceId" must be a non-empty string from tailnet.status.');
            const before = service.getTailnetStatus();
            if (!before.devices.some((device) => device.id === deviceId)) {
                // Reported rather than absorbed: revokeDevice is idempotent by design,
                // so a silent success on a typo'd id would read as "that device is gone".
                return toolError('unknown_device', `No device "${deviceId}" is paired with this machine.`);
            }
            return toolSuccess({ status: service.revokeTailnetDevice(deviceId) });
        },
    };
    const listPeers = {
        name: 'tailnet.list_peers',
        description: 'List the machines on this tailnet, as Tailscale itself reports them, and which of them answer as a '
            + 'SprintEngine Studio. Never a network scan. Works with this machine\'s own listener off — finding somewhere to '
            + 'connect to does not require having opened your own door. Served only over the local socket.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        handler: async () => {
            const service = front();
            if (!service)
                return unavailable;
            return toolSuccess({ peers: await service.listTailnetPeers() });
        },
    };
    return [status, setEnabled, offerPairing, cancelPairing, revokeDevice, listPeers];
}
/**
 * Read a requested scope list, or return the sentence explaining the refusal.
 *
 * `normalizeTailnetScopes` drops what it does not recognise, which is right for
 * reading a stored device and wrong here: a caller that misspells a scope would
 * silently get the default grant instead of the one it asked for.
 */
function readScopes(value) {
    if (!Array.isArray(value))
        return '"scopes" must be an array of scope strings.';
    const unknown = value.filter((entry) => !isTailnetScope(entry));
    if (unknown.length > 0) {
        return `Unknown scope(s): ${unknown.map((entry) => JSON.stringify(entry)).join(', ')}. Valid scopes are: ${TAILNET_SCOPES.join(', ')}.`;
    }
    if (value.length === 0)
        return '"scopes" cannot be empty. Omit it for the default structured-command set.';
    return value;
}
