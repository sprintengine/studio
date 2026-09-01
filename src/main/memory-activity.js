import { app, BrowserWindow } from 'electron';
import { existsSync, watch as fsWatch } from 'fs';
import { copyFile, mkdir, readFile, readdir, writeFile, rm } from 'fs/promises';
import { join, resolve, sep } from 'path';
import { open as fsOpen } from 'fs/promises';
const states = new Map();
// =============================================================================
// Path helpers
// =============================================================================
const MULTICODE_HOOK_TAG = 'multicode-knowledge-activity';
const LEGACY_MULTICODE_HOOK_TAG = 'multicode-memory-activity';
const HOOK_SCRIPT_REL = join('.multicode', 'hooks', 'knowledge-activity.mjs');
const TRACE_DIR_REL = join('.multicode', 'knowledge-trace');
const INSTALLED_RECORD_REL = join('.multicode', 'hooks', 'installed.json');
const CLAUDE_LOCAL_SETTINGS_REL = join('.claude', 'settings.local.json');
function workspaceKey(workspaceRoot) {
    return resolve(workspaceRoot);
}
function getBundledHookScriptPath() {
    if (app.isPackaged) {
        const packaged = join(process.resourcesPath, 'hooks', 'claude-knowledge-activity.mjs');
        return existsSync(packaged) ? packaged : null;
    }
    const candidates = [
        join(process.cwd(), 'resources', 'hooks', 'claude-knowledge-activity.mjs'),
        join(app.getAppPath(), 'resources', 'hooks', 'claude-knowledge-activity.mjs'),
        join(__dirname, '..', '..', 'resources', 'hooks', 'claude-knowledge-activity.mjs'),
        join(__dirname, '..', '..', '..', 'resources', 'hooks', 'claude-knowledge-activity.mjs'),
    ];
    return candidates.find((p) => existsSync(p)) ?? null;
}
async function readJsonIfExists(path) {
    try {
        const text = await readFile(path, 'utf8');
        if (!text.trim())
            return {};
        return JSON.parse(text);
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return null;
        throw error;
    }
}
function buildHookCommand(memoryRelativeRoot) {
    // Quote both arguments so paths with spaces survive the shell. Forward
    // slashes work on every platform Node will accept the path.
    const scriptRel = HOOK_SCRIPT_REL.split(sep).join('/');
    const memoryRel = memoryRelativeRoot.split(sep).join('/');
    return `node "${scriptRel}" --knowledge-root "${memoryRel}"`;
}
function ensureMatcherBlock(blocks, matcher) {
    const found = blocks.find((b) => b.matcher === matcher);
    if (found) {
        if (!Array.isArray(found.hooks))
            found.hooks = [];
        return found;
    }
    const next = { matcher, hooks: [] };
    blocks.push(next);
    return next;
}
function isMulticodeEntry(entry) {
    return entry?._multicode === MULTICODE_HOOK_TAG || entry?._multicode === LEGACY_MULTICODE_HOOK_TAG;
}
async function mergeMulticodeHook(settingsPath, hookCommand) {
    const existing = (await readJsonIfExists(settingsPath)) ?? {};
    const settings = { ...existing };
    if (!settings.hooks || typeof settings.hooks !== 'object')
        settings.hooks = {};
    if (!Array.isArray(settings.hooks.PostToolUse))
        settings.hooks.PostToolUse = [];
    const blocks = settings.hooks.PostToolUse;
    const block = ensureMatcherBlock(blocks, 'Read|Edit|Write');
    // Replace any prior multicode entry; preserve all unrelated hooks the user
    // configured themselves.
    const ours = {
        type: 'command',
        command: hookCommand,
        _multicode: MULTICODE_HOOK_TAG,
    };
    const filtered = (block.hooks ?? []).filter((entry) => !isMulticodeEntry(entry));
    filtered.push(ours);
    block.hooks = filtered;
    await mkdir(resolve(settingsPath, '..'), { recursive: true });
    await writeFile(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf8');
}
async function unmergeMulticodeHook(settingsPath) {
    const existing = await readJsonIfExists(settingsPath);
    if (!existing?.hooks?.PostToolUse)
        return;
    const blocks = existing.hooks.PostToolUse;
    for (const block of blocks) {
        if (!Array.isArray(block.hooks))
            continue;
        block.hooks = block.hooks.filter((entry) => !isMulticodeEntry(entry));
    }
    // Drop blocks that became empty so we don't leave dangling matchers.
    existing.hooks.PostToolUse = blocks.filter((b) => Array.isArray(b.hooks) && b.hooks.length > 0);
    if (existing.hooks.PostToolUse.length === 0)
        delete existing.hooks.PostToolUse;
    if (Object.keys(existing.hooks).length === 0)
        delete existing.hooks;
    await writeFile(settingsPath, JSON.stringify(existing, null, 2) + '\n', 'utf8');
}
// =============================================================================
// Install / uninstall
// =============================================================================
export async function installMemoryActivityHook(workspaceRoot, memoryRelativeRoot) {
    if (!workspaceRoot?.trim())
        return { ok: false, message: 'Workspace root is required.' };
    if (!memoryRelativeRoot?.trim()) {
        return { ok: false, message: 'Knowledge folder must be configured before tracking activity.' };
    }
    const sourceScript = getBundledHookScriptPath();
    if (!sourceScript) {
        return { ok: false, message: 'Knowledge activity hook script is missing from this build.' };
    }
    try {
        const hookDir = resolve(workspaceRoot, '.multicode', 'hooks');
        await mkdir(hookDir, { recursive: true });
        const destScript = resolve(workspaceRoot, HOOK_SCRIPT_REL);
        await copyFile(sourceScript, destScript);
        const traceDir = resolve(workspaceRoot, TRACE_DIR_REL);
        await mkdir(traceDir, { recursive: true });
        const settingsPath = resolve(workspaceRoot, CLAUDE_LOCAL_SETTINGS_REL);
        const command = buildHookCommand(memoryRelativeRoot);
        await mergeMulticodeHook(settingsPath, command);
        const installedRecord = {
            installedAt: new Date().toISOString(),
            memoryRelativeRoot,
            hookScript: HOOK_SCRIPT_REL.split(sep).join('/'),
            claudeSettings: CLAUDE_LOCAL_SETTINGS_REL.split(sep).join('/'),
            command,
            tag: MULTICODE_HOOK_TAG,
        };
        await writeFile(resolve(workspaceRoot, INSTALLED_RECORD_REL), JSON.stringify(installedRecord, null, 2) + '\n', 'utf8');
        const state = ensureWorkspaceState(workspaceRoot, memoryRelativeRoot);
        state.isInstalled = true;
        return { ok: true, settingsPath, hookScriptPath: destScript };
    }
    catch (error) {
        return {
            ok: false,
            message: error instanceof Error ? error.message : 'Failed to install knowledge activity hook.',
        };
    }
}
export async function uninstallMemoryActivityHook(workspaceRoot) {
    if (!workspaceRoot?.trim())
        return { ok: false, message: 'Workspace root is required.' };
    try {
        const settingsPath = resolve(workspaceRoot, CLAUDE_LOCAL_SETTINGS_REL);
        if (existsSync(settingsPath))
            await unmergeMulticodeHook(settingsPath);
        const installedRecord = resolve(workspaceRoot, INSTALLED_RECORD_REL);
        if (existsSync(installedRecord))
            await rm(installedRecord, { force: true });
        const state = states.get(workspaceKey(workspaceRoot));
        if (state)
            state.isInstalled = false;
        return { ok: true };
    }
    catch (error) {
        return {
            ok: false,
            message: error instanceof Error ? error.message : 'Failed to uninstall memory activity hook.',
        };
    }
}
export async function isMemoryActivityInstalled(workspaceRoot) {
    if (!workspaceRoot?.trim())
        return false;
    return existsSync(resolve(workspaceRoot, INSTALLED_RECORD_REL));
}
// =============================================================================
// Watcher / synapse accumulator
// =============================================================================
function ensureWorkspaceState(workspaceRoot, memoryRelativeRoot) {
    const key = workspaceKey(workspaceRoot);
    let state = states.get(key);
    if (state) {
        state.memoryRoot = memoryRelativeRoot;
        return state;
    }
    state = {
        workspaceRoot: key,
        memoryRoot: memoryRelativeRoot,
        watcher: null,
        sessions: new Map(),
        synapses: new Map(),
        events: [],
        isInstalled: false,
    };
    states.set(key, state);
    return state;
}
function synapseKey(src, dst) {
    return `${src} ${dst}`;
}
function broadcast(channel, payload) {
    for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed())
            win.webContents.send(channel, payload);
    }
}
async function readJsonlFromOffset(path, offset) {
    let handle = null;
    try {
        handle = await fsOpen(path, 'r');
        const stats = await handle.stat();
        if (stats.size <= offset)
            return { lines: [], nextOffset: stats.size };
        const length = stats.size - offset;
        const buf = Buffer.alloc(length);
        await handle.read(buf, 0, length, offset);
        const text = buf.toString('utf8');
        const newlineEnd = text.lastIndexOf('\n');
        if (newlineEnd < 0)
            return { lines: [], nextOffset: offset };
        const consumable = text.slice(0, newlineEnd);
        const lines = consumable.split('\n').filter((l) => l.trim().length > 0);
        return { lines, nextOffset: offset + Buffer.byteLength(consumable, 'utf8') + 1 };
    }
    catch {
        return { lines: [], nextOffset: offset };
    }
    finally {
        await handle?.close();
    }
}
function processEventLine(state, sessionId, line) {
    let parsed = null;
    try {
        parsed = JSON.parse(line);
    }
    catch {
        return null;
    }
    if (!parsed?.file || typeof parsed.file !== 'string')
        return null;
    const tool = typeof parsed.tool === 'string' ? parsed.tool : 'Unknown';
    const ts = typeof parsed.ts === 'number' ? parsed.ts : Date.now();
    const nodeId = parsed.file;
    const eventSessionId = parsed.sessionId ?? sessionId;
    let session = state.sessions.get(eventSessionId);
    if (!session) {
        session = { lastNodeId: null, fileOffset: 0 };
        state.sessions.set(eventSessionId, session);
    }
    let synapseCount = 0;
    if (session.lastNodeId && session.lastNodeId !== nodeId) {
        const key = synapseKey(session.lastNodeId, nodeId);
        const prior = state.synapses.get(key);
        const next = {
            src: session.lastNodeId,
            dst: nodeId,
            count: (prior?.count ?? 0) + 1,
            lastTs: ts,
        };
        state.synapses.set(key, next);
        synapseCount = next.count;
    }
    const event = {
        workspaceRoot: state.workspaceRoot,
        sessionId: eventSessionId,
        nodeId,
        prevNodeId: session.lastNodeId,
        tool,
        ts,
        synapseCount,
    };
    session.lastNodeId = nodeId;
    state.events.push({ ts });
    return event;
}
async function tailSessionFile(state, fileName, options = { broadcastEvents: true }) {
    if (!fileName.endsWith('.jsonl'))
        return;
    const sessionId = fileName.replace(/\.jsonl$/u, '');
    const filePath = resolve(state.workspaceRoot, TRACE_DIR_REL, fileName);
    if (!existsSync(filePath))
        return;
    let session = state.sessions.get(sessionId);
    if (!session) {
        session = { lastNodeId: null, fileOffset: 0 };
        state.sessions.set(sessionId, session);
    }
    const { lines, nextOffset } = await readJsonlFromOffset(filePath, session.fileOffset);
    session.fileOffset = nextOffset;
    for (const line of lines) {
        const event = processEventLine(state, sessionId, line);
        if (event && options.broadcastEvents)
            broadcast('memory-activity:event', event);
    }
}
async function rebuildFromDisk(state) {
    const traceDir = resolve(state.workspaceRoot, TRACE_DIR_REL);
    if (!existsSync(traceDir))
        return;
    let entries = [];
    try {
        entries = await readdir(traceDir);
    }
    catch {
        return;
    }
    // Replay every existing session so synapse counts match live state, but
    // do NOT re-broadcast history as live pulses — the renderer will request
    // a synapse snapshot once on connect.
    const jsonlFiles = entries.filter((n) => n.endsWith('.jsonl')).sort();
    for (const name of jsonlFiles) {
        await tailSessionFile(state, name, { broadcastEvents: false });
    }
}
export async function startMemoryActivityWatcher(workspaceRoot, memoryRelativeRoot) {
    if (!workspaceRoot?.trim() || !memoryRelativeRoot?.trim())
        return;
    const state = ensureWorkspaceState(workspaceRoot, memoryRelativeRoot);
    if (state.watcher)
        return;
    const traceDir = resolve(workspaceRoot, TRACE_DIR_REL);
    await mkdir(traceDir, { recursive: true });
    await rebuildFromDisk(state);
    broadcastSynapses(state);
    broadcastStatus(state);
    // fs.watch fires for create+modify on every platform we care about (macOS,
    // Linux, Windows). We don't need recursive — the trace dir is flat.
    state.watcher = fsWatch(traceDir, { persistent: false }, (_event, fileName) => {
        if (!fileName)
            return;
        const name = String(fileName);
        void tailSessionFile(state, name).then(() => broadcastStatus(state));
    });
}
export function stopMemoryActivityWatcher(workspaceRoot) {
    const state = states.get(workspaceKey(workspaceRoot));
    if (!state?.watcher)
        return;
    state.watcher.close();
    state.watcher = null;
}
// =============================================================================
// Status / synapse snapshots for the renderer
// =============================================================================
function isToday(ts, now) {
    const a = new Date(ts);
    const b = new Date(now);
    return (a.getFullYear() === b.getFullYear()
        && a.getMonth() === b.getMonth()
        && a.getDate() === b.getDate());
}
export function getMemoryActivityStatus(workspaceRoot) {
    if (!workspaceRoot?.trim()) {
        return {
            workspaceRoot: null,
            isInstalled: false,
            isWatching: false,
            sessionsRecorded: 0,
            totalEvents: 0,
            eventsToday: 0,
            lastEventAt: null,
        };
    }
    const state = states.get(workspaceKey(workspaceRoot));
    if (!state) {
        return {
            workspaceRoot,
            isInstalled: existsSync(resolve(workspaceRoot, INSTALLED_RECORD_REL)),
            isWatching: false,
            sessionsRecorded: 0,
            totalEvents: 0,
            eventsToday: 0,
            lastEventAt: null,
        };
    }
    const now = Date.now();
    const totalEvents = state.events.length;
    const eventsToday = state.events.filter((e) => isToday(e.ts, now)).length;
    const lastEventAt = state.events.length > 0 ? state.events[state.events.length - 1].ts : null;
    return {
        workspaceRoot: state.workspaceRoot,
        isInstalled: state.isInstalled || existsSync(resolve(state.workspaceRoot, INSTALLED_RECORD_REL)),
        isWatching: state.watcher !== null,
        sessionsRecorded: state.sessions.size,
        totalEvents,
        eventsToday,
        lastEventAt,
    };
}
export function getMemoryActivitySynapses(workspaceRoot) {
    const state = states.get(workspaceKey(workspaceRoot));
    if (!state)
        return [];
    return [...state.synapses.values()];
}
function broadcastStatus(state) {
    broadcast('memory-activity:status', getMemoryActivityStatus(state.workspaceRoot));
}
function broadcastSynapses(state) {
    broadcast('memory-activity:synapses', {
        workspaceRoot: state.workspaceRoot,
        synapses: [...state.synapses.values()],
    });
}
export async function clearMemoryActivityHistory(workspaceRoot) {
    const state = states.get(workspaceKey(workspaceRoot));
    if (state) {
        state.synapses.clear();
        state.sessions.clear();
        state.events = [];
    }
    const traceDir = resolve(workspaceRoot, TRACE_DIR_REL);
    if (!existsSync(traceDir))
        return;
    try {
        const entries = await readdir(traceDir);
        await Promise.all(entries
            .filter((n) => n.endsWith('.jsonl'))
            .map((n) => rm(resolve(traceDir, n), { force: true })));
    }
    catch {
        // best-effort
    }
    if (state) {
        broadcastSynapses(state);
        broadcastStatus(state);
    }
}
