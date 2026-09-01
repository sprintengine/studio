import { MODULE_BRIDGE_INVOKE_CHANNEL, } from '../../shared/modules/bridge';
import { MODULE_EVENTS_CHANNEL, validateModuleEventTopic, } from '../../shared/modules/events';
import { MODULE_NOTIFICATIONS_EVENT_CHANNEL, validateModuleNotifyInput, } from '../../shared/modules/notifications';
export function createServiceToken(key) {
    return { key };
}
// Flood bounds: a module may emit at most this many notifications per window;
// an emission identical to the module's previous one inside the window is
// dropped as a repeat. Both protect the channel from a misbehaving module.
const NOTIFICATION_RATE_WINDOW_MS = 10_000;
const NOTIFICATION_RATE_MAX_PER_WINDOW = 20;
const NOTIFICATION_BUFFER_LIMIT = 50;
export function createMainKernel(ipcMain, options = {}) {
    const channels = new Map();
    // name -> owning module + registration; insertion order is the gateway's
    // listing order, mirroring the channel map's ownership discipline.
    const mcpTools = new Map();
    const services = new Map();
    let startupHooks = [];
    let shutdownBeginHooks = [];
    let shutdownHooks = [];
    const sidecarEntries = new Map();
    const now = options.now ?? Date.now;
    const recent = [];
    const floodStateByModule = new Map();
    let started = false;
    // The notifications and module-events channels belong to the host kernel;
    // reserving them here makes a module's attempt to claim either a
    // registration error.
    channels.set(MODULE_NOTIFICATIONS_EVENT_CHANNEL, { owner: '@host' });
    channels.set(MODULE_EVENTS_CHANNEL, { owner: '@host' });
    // The renderer→module-main bridge dispatcher. Routes an invoke to a channel
    // a third-party module registered via registerIpc, applying the four
    // bridgeability rules; every refusal is structured data (see bridge.ts).
    // This is defense in depth for a contract, not a security boundary — the
    // renderer-side host already validates the module-id prefix before IPC.
    // Registered through the kernel's own registerIpc so the dispatcher channel
    // shares every other channel's ownership tracking and lifecycle.
    async function dispatchBridgeInvoke(event, request) {
        const channel = typeof request?.channel === 'string'
            ? request.channel
            : '';
        const payload = request?.payload;
        const entry = channels.get(channel);
        if (!entry?.handler) {
            return {
                ok: false,
                code: 'unknown_channel',
                message: `No module has registered the IPC channel "${channel}".`,
            };
        }
        if (!channel.startsWith(`${entry.owner}:`)) {
            return {
                ok: false,
                code: 'not_bridgeable',
                message: `Channel "${channel}" is not bridgeable: bridged channels must be prefixed with their owning module's id ("${entry.owner}:").`,
            };
        }
        const manifest = options.resolveModuleManifest?.(entry.owner);
        if (manifest?.source !== 'third-party') {
            return {
                ok: false,
                code: 'not_bridgeable',
                message: `Channel "${channel}" is not bridgeable: the bridge routes only to channels owned by third-party modules.`,
            };
        }
        if (!manifest.permissions?.includes('ipc:invoke')) {
            return {
                ok: false,
                code: 'permission_missing',
                message: `Module "${entry.owner}" does not declare the "ipc:invoke" permission, so its channels cannot be bridged.`,
            };
        }
        return { ok: true, result: await entry.handler(event, payload) };
    }
    hostFor('@host').registerIpc(MODULE_BRIDGE_INVOKE_CHANNEL, dispatchBridgeInvoke);
    function emitNotification(sourceModuleId, input) {
        const validated = validateModuleNotifyInput(input);
        if (!validated.ok) {
            throw new Error(`Module "${sourceModuleId}" ${validated.message}`);
        }
        const emittedAt = now();
        if (!passesFloodBound(sourceModuleId, validated.severity, validated.title, validated.body, emittedAt))
            return;
        const notification = {
            sourceModuleId,
            severity: validated.severity,
            title: validated.title,
            body: validated.body,
            emittedAt,
        };
        recent.push(notification);
        if (recent.length > NOTIFICATION_BUFFER_LIMIT)
            recent.splice(0, recent.length - NOTIFICATION_BUFFER_LIMIT);
        options.deliverNotification?.(notification);
    }
    function emitModuleEvent(sourceModuleId, topic, payload) {
        const validated = validateModuleEventTopic(topic);
        if (!validated.ok) {
            throw new Error(`Module "${sourceModuleId}" ${validated.message}`);
        }
        // Deliberately unbuffered and unbounded: a dropped event makes a
        // subscriber wrong, where a dropped notification only costs a message.
        options.deliverModuleEvent?.({
            sourceModuleId,
            topic: validated.topic,
            ...(payload === undefined ? {} : { payload }),
            emittedAt: now(),
        });
    }
    function passesFloodBound(moduleId, severity, title, body, emittedAt) {
        const state = floodStateByModule.get(moduleId) ?? { emittedAt: [], lastKey: '', lastAt: 0, warnedDropAt: 0 };
        floodStateByModule.set(moduleId, state);
        const windowStart = emittedAt - NOTIFICATION_RATE_WINDOW_MS;
        state.emittedAt = state.emittedAt.filter((at) => at > windowStart);
        const key = JSON.stringify([severity, title, body ?? '']);
        const isRepeat = key === state.lastKey && state.lastAt > windowStart;
        const isOverRate = state.emittedAt.length >= NOTIFICATION_RATE_MAX_PER_WINDOW;
        if (isRepeat || isOverRate) {
            if (state.warnedDropAt <= windowStart) {
                state.warnedDropAt = emittedAt;
                console.warn(`[modules] dropping notifications from "${moduleId}" (${isOverRate ? 'rate cap reached' : 'identical repeat'}).`);
            }
            return false;
        }
        state.emittedAt.push(emittedAt);
        state.lastKey = key;
        state.lastAt = emittedAt;
        return true;
    }
    async function startSidecar(entry) {
        const lifecycle = entry.lifecycle;
        if (!lifecycle) {
            throw new Error(`Sidecar "${entry.spec.id}" was registered without a lifecycle and cannot be started.`);
        }
        if (entry.state === 'running')
            return;
        if (entry.pendingStart)
            return entry.pendingStart;
        entry.state = 'starting';
        entry.error = undefined;
        entry.pendingStart = (async () => {
            try {
                await lifecycle.start();
                entry.state = 'running';
            }
            catch (err) {
                entry.state = 'failed';
                entry.error = err instanceof Error ? err.message : String(err);
                emitNotification(entry.moduleId, {
                    severity: 'error',
                    title: `Sidecar "${entry.spec.id}" failed to start`,
                    body: entry.error,
                });
                throw err;
            }
            finally {
                entry.pendingStart = undefined;
            }
        })();
        return entry.pendingStart;
    }
    async function stopSidecar(entry) {
        if (!entry.lifecycle)
            return;
        if (entry.pendingStart) {
            try {
                await entry.pendingStart;
            }
            catch {
                if (sidecarState(entry) !== 'running')
                    return;
            }
        }
        const current = sidecarState(entry);
        if (current !== 'starting' && current !== 'running')
            return;
        try {
            await entry.lifecycle.stop();
            entry.state = 'stopped';
            entry.error = undefined;
        }
        catch (err) {
            entry.state = 'failed';
            entry.error = err instanceof Error ? err.message : String(err);
            throw err;
        }
    }
    function sidecarState(entry) {
        return entry.lifecycle?.status?.().state ?? entry.state;
    }
    function sidecarStatusOf(entry) {
        const delegated = entry.lifecycle?.status?.();
        return {
            id: entry.spec.id,
            moduleId: entry.moduleId,
            kind: entry.spec.kind,
            description: entry.spec.description,
            state: delegated?.state ?? entry.state,
            error: delegated ? delegated.error : entry.error,
        };
    }
    function hostFor(moduleId) {
        return {
            moduleId,
            ipcMain,
            registerIpc(channel, handler) {
                const existing = channels.get(channel);
                if (existing) {
                    throw new Error(`IPC channel "${channel}" is already registered by module "${existing.owner}".`);
                }
                channels.set(channel, { owner: moduleId, handler });
                ipcMain.handle(channel, handler);
            },
            registerMcpTools(tools) {
                // Validate the whole batch before landing any of it: a module whose
                // registerMain fails on a collision must not leave half its tools
                // behind on the always-serving gateway.
                const batch = new Set();
                for (const tool of tools) {
                    const existing = mcpTools.get(tool.name);
                    if (existing) {
                        throw new Error(`MCP tool "${tool.name}" is already registered by module "${existing.owner}".`);
                    }
                    if (batch.has(tool.name)) {
                        throw new Error(`MCP tool "${tool.name}" is registered twice by module "${moduleId}".`);
                    }
                    batch.add(tool.name);
                }
                for (const tool of tools) {
                    mcpTools.set(tool.name, { owner: moduleId, registration: tool });
                }
            },
            provideService(token, factory) {
                if (services.has(token.key)) {
                    throw new Error(`Service "${token.key}" is already provided; module "${moduleId}" tried to provide it again.`);
                }
                const instance = factory(this);
                services.set(token.key, { moduleId, value: instance });
                return instance;
            },
            getService(token) {
                return services.get(token.key)?.value;
            },
            requireService(token) {
                if (!services.has(token.key)) {
                    throw new Error(`Module "${moduleId}" requires service "${token.key}", which no enabled module provides.`);
                }
                return services.get(token.key).value;
            },
            onStartup(hook) {
                startupHooks.push({ moduleId, hook });
            },
            onShutdownBegin(hook) {
                shutdownBeginHooks.push({ moduleId, hook });
            },
            onShutdown(hook) {
                shutdownHooks.push({ moduleId, hook });
            },
            registerSidecar(spec, lifecycle) {
                const existing = sidecarEntries.get(spec.id);
                if (existing) {
                    throw new Error(`Sidecar "${spec.id}" is already registered by module "${existing.moduleId}".`);
                }
                const entry = {
                    spec,
                    moduleId,
                    lifecycle,
                    state: lifecycle ? 'stopped' : 'declared',
                };
                sidecarEntries.set(spec.id, entry);
                if (lifecycle) {
                    // Compose with the hook pipeline: spawn keeps registration order
                    // among this module's other startup hooks, and runShutdown's reverse
                    // order stops sidecars last-started-first.
                    if (spec.startOn !== 'demand') {
                        startupHooks.push({ moduleId, hook: () => startSidecar(entry) });
                    }
                    shutdownHooks.push({ moduleId, hook: () => stopSidecar(entry) });
                }
                return {
                    start: () => startSidecar(entry),
                    stop: () => stopSidecar(entry),
                    status: () => sidecarStatusOf(entry),
                };
            },
            notify(input) {
                emitNotification(moduleId, input);
            },
            emit(topic, payload) {
                emitModuleEvent(moduleId, topic, payload);
            },
        };
    }
    async function runHooks(hooks, failureLabel) {
        for (const { hook } of hooks) {
            try {
                await hook();
            }
            catch (err) {
                console.warn(`[modules] ${failureLabel} hook failed:`, err);
            }
        }
    }
    async function unregisterModule(moduleId) {
        await runHooks(shutdownBeginHooks.filter((entry) => entry.moduleId === moduleId), `shutdown-begin for module "${moduleId}"`);
        await runHooks([...shutdownHooks].reverse().filter((entry) => entry.moduleId === moduleId), `shutdown for module "${moduleId}"`);
        startupHooks = startupHooks.filter((entry) => entry.moduleId !== moduleId);
        shutdownBeginHooks = shutdownBeginHooks.filter((entry) => entry.moduleId !== moduleId);
        shutdownHooks = shutdownHooks.filter((entry) => entry.moduleId !== moduleId);
        for (const [sidecarId, entry] of [...sidecarEntries]) {
            if (entry.moduleId === moduleId)
                sidecarEntries.delete(sidecarId);
        }
        for (const [channel, entry] of [...channels]) {
            if (entry.owner !== moduleId)
                continue;
            channels.delete(channel);
            ipcMain.removeHandler(channel);
        }
        for (const [toolName, entry] of [...mcpTools]) {
            if (entry.owner === moduleId)
                mcpTools.delete(toolName);
        }
        for (const [serviceKey, entry] of [...services]) {
            if (entry.moduleId === moduleId)
                services.delete(serviceKey);
        }
    }
    return {
        hostFor,
        ownedChannels: () => new Map([...channels].map(([channel, entry]) => [channel, entry.owner])),
        mcpToolRegistrations: () => [...mcpTools.values()].map(({ owner, registration }) => ({
            moduleId: owner,
            moduleDisplayName: options.resolveModuleManifest?.(owner)?.displayName ?? owner,
            registration,
        })),
        startupHooks: () => startupHooks.map((entry) => entry.hook),
        shutdownBeginHooks: () => shutdownBeginHooks.map((entry) => entry.hook),
        shutdownHooks: () => shutdownHooks.map((entry) => entry.hook),
        sidecars: () => [...sidecarEntries.values()].map((entry) => entry.spec),
        sidecarStatuses: () => [...sidecarEntries.values()].map(sidecarStatusOf),
        emitNotification,
        recentNotifications: () => recent,
        emitModuleEvent,
        async runStartup() {
            started = true;
            await runHooks(startupHooks, 'startup');
        },
        async runStartupForModule(moduleId) {
            await runHooks(startupHooks.filter((entry) => entry.moduleId === moduleId), `startup for module "${moduleId}"`);
        },
        async runShutdownBegin() {
            await runHooks(shutdownBeginHooks, 'shutdown-begin');
        },
        async runShutdown() {
            await runHooks([...shutdownHooks].reverse(), 'shutdown');
            started = false;
        },
        unregisterModule,
        isStarted: () => started,
    };
}
