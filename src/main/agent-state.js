import { existsSync } from 'fs';
import { copyFile, mkdir, readFile, rm, writeFile } from 'fs/promises';
import { homedir } from 'os';
import { join, resolve, sep } from 'path';
// =============================================================================
// Authoritative agent state — pure core (no Electron deps, fully unit-testable)
//
// This module owns three concerns that need no main-process runtime:
//   1. Resolving a reporter frame against a CLI's manifest-declared
//      `agentStateSpec` (event → AgentPhase, discriminators, turn-end flags).
//      The per-CLI vocabulary is DATA on each plugin manifest, never code here.
//   2. The AgentPhase → legacy SessionActivity bridge (so existing consumers
//      keep working untouched while the richer phase rides alongside).
//   3. Validating an untrusted reporter frame and (un)installing the reporter
//      into a workspace, dispatched by the spec's registration kind.
//
// The Electron-bound half (the socket listener + session resolution + renderer
// broadcast + launch-time install) lives in a sibling service module so this
// stays importable from a plain Node test harness.
// =============================================================================
export const AGENT_STATE_HOOK_TAG = 'multicode-agent-state';
// Where the reporter script is copied inside a workspace. The reporter also
// honours a MULTICODE_AGENT_STATE_SOCKET env fallback (see the .mjs), but the
// install always passes the socket via --socket, so it is not referenced here.
export const AGENT_STATE_HOOK_SCRIPT_REL = join('.multicode', 'hooks', 'agent-state.mjs');
// Read the frame field a discriminator NAMES, never a hardcoded one, so a
// widened field enum can't silently misread.
function discriminatorValue(field, frame) {
    return field === 'notificationType' ? frame.notificationType : frame.status;
}
export function resolveAgentStateEvent(spec, frame) {
    if (spec && frame.event) {
        const entry = spec.events.find((candidate) => candidate.event === frame.event);
        // An event the spec does not name carries no phase for this CLI — the
        // prior phase stands. (This is also what makes a discriminator allow-list
        // fail SAFE: see below.)
        if (!entry)
            return { action: 'drop' };
        // Failure discriminator: a turn-end whose payload carries the outcome
        // (Cursor's stop status error|aborted) counts as a failed turn — a crash
        // finalized as completed opens a PR from failed work.
        const failureValue = entry.failureWhen ? discriminatorValue(entry.failureWhen.field, frame) : undefined;
        const turnFailure = entry.failure === true
            || Boolean(entry.failureWhen && failureValue && entry.failureWhen.oneOf.includes(failureValue));
        if (entry.when) {
            // Discriminator: the phase applies only for allow-listed payload values.
            // Claude's `Notification` is the canonical case — it fires for real
            // permission/elicitation prompts AND informational nudges (idle_prompt),
            // and `awaiting_input` is sticky for a dormant agent, so an unlisted or
            // absent value must drop (falsely "needs input" parks a session forever;
            // a false idle is recoverable — the 2026-07-07 parked-agents incident).
            const value = discriminatorValue(entry.when.field, frame);
            if (!value || !entry.when.oneOf.includes(value)) {
                // Stale-reporter compatibility: a reporter copy from before the
                // dumb-forwarder change filtered discriminated events CLIENT-side and
                // asserted the mapped phase without forwarding the discriminator
                // field. Until the next successful install replaces it (install is
                // best-effort and can fail on e.g. a read-only tree), honor its own
                // filtering: no discriminator + the exact phase this entry maps to
                // means the old allow-list already passed. Anything else drops.
                if (!value && frame.phase === entry.phase) {
                    return {
                        action: 'apply',
                        phase: entry.phase,
                        turnEnd: entry.turnEnd === true,
                        turnFailure,
                    };
                }
                return { action: 'drop' };
            }
        }
        return {
            action: 'apply',
            phase: entry.phase,
            turnEnd: entry.turnEnd === true,
            turnFailure,
        };
    }
    // No spec (a CLI outside the manifest capability whose reporter still emits
    // frames) or an event-less frame: trust the reporter-asserted phase, with no
    // turn-end semantics — those are manifest data only.
    if (frame.phase)
        return { action: 'apply', phase: frame.phase, turnEnd: false, turnFailure: false };
    return { action: 'drop' };
}
// The registration subset of a spec's event table: what actually gets written
// into the CLI's hook config. `register: false` entries are mapped if a frame
// ever arrives (a stale registration from an older release) but never
// registered anew — e.g. Claude's PreToolUse, dropped because PostToolUse alone
// clears awaiting_input and halves the per-tool reporter spawns (the manifest
// $comment on the claude-code plugin carries the full rationale).
export function registeredAgentStateEvents(spec) {
    return spec.events
        .filter((entry) => entry.register !== false)
        .map(({ event, matcher }) => (matcher === undefined ? { event } : { event, matcher }));
}
// =============================================================================
// Phase → legacy SessionActivity bridge
//
// Keeps the existing 4-variant activity field honest from the richer phase so
// every current consumer (sidebar bolding, reaping, diagnostics) keeps working.
// Returns null for terminal phases (`exited`/`failed`): a real process exit is
// owned authoritatively by the pty onExit handler, which carries the exit code
// a hook frame does not — we never synthesize an exit from a hook.
// =============================================================================
// At-rest phases the idle reaper may reclaim once rested past its threshold:
// 'idle' (authoritative turn end) and 'stalled' (inferred quiet ≥90s). Stalled
// counts as rest deliberately — a lost Stop frame lands a genuinely-finished
// agent there, and treating stalled as protected parked sessions forever
// (2026-07-07 incident). Shared by the reap candidate mapping and the
// sprint-agent inactive-run guard so the two can't drift.
export function isAtRestAgentPhase(phase) {
    return phase === 'idle' || phase === 'stalled';
}
export function deriveActivityFromPhase(phase, since) {
    switch (phase) {
        case 'starting':
        case 'thinking':
        case 'tool_use':
            return { kind: 'working', since };
        case 'awaiting_input':
        case 'idle':
        case 'stalled':
            return { kind: 'idle', since };
        case 'exited':
        case 'failed':
            return null;
        default:
            return null;
    }
}
export function evaluateAgentStall(input) {
    if (input.phase !== 'starting' && input.phase !== 'thinking' && input.phase !== 'tool_use') {
        return { action: 'clear' };
    }
    // A hook-driven working phase can stall, and so can the INFERRED `starting`
    // every agent is lifecycle-stamped with at spawn: a session whose hooks
    // never fire at all (a broken or failed install — there is no output-timing
    // fallback any more) must convert to `stalled` and expire via the reap
    // policy rather than reading as working, and being reaper-protected,
    // forever. Inferred thinking/tool_use no longer exist to be evaluated.
    if (input.source !== 'hook' && input.phase !== 'starting')
        return { action: 'clear' };
    const lastActivityAt = Math.max(input.phaseSince, input.lastOutputAt ?? 0);
    const quietForMs = input.now - lastActivityAt;
    if (quietForMs >= input.thresholdMs)
        return { action: 'stalled' };
    return { action: 'recheck', afterMs: input.thresholdMs - quietForMs };
}
// ScheduleWakeup's runtime clamps delaySeconds to [60, 3600]. Anything past
// clamp+slack is a reporter/clock anomaly — cap it so one bad frame cannot
// park a session on a far-future hold.
export const MAX_WAKEUP_DELAY_SECONDS = 2 * 3600;
// Absurd lengths are a reporter/payload anomaly, not a path. Cap so an unbounded
// untrusted string cannot ride the frame into a consumer.
export const MAX_TRANSCRIPT_PATH_LENGTH = 4096;
// Cap on the forwarded user prompt. The reporter truncates too, but it is
// untrusted, so this is the enforcement: the value is retained per session and
// broadcast to every renderer, and an unbounded string would ride into both.
// Sized well above a title (~42 chars) because the same field feeds the tab
// hover preview, which shows several lines.
export const MAX_AGENT_PROMPT_LENGTH = 2000;
const VALID_PHASES = new Set([
    'starting',
    'thinking',
    'tool_use',
    'awaiting_input',
    'idle',
    'exited',
    'failed',
    'stalled',
]);
function isRecord(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
function optionalString(value) {
    return typeof value === 'string' && value.length > 0 ? value : null;
}
// Cap on the forwarded discriminator value: documented notification types are
// short tokens; anything longer is a payload anomaly, and the value is compared
// against manifest allow-lists so an oversized string is dropped, not truncated.
export const MAX_NOTIFICATION_TYPE_LENGTH = 128;
export function parseAgentStateFrame(raw, now) {
    if (!isRecord(raw))
        return null;
    if (raw.type !== 'agent_state')
        return null;
    const agentId = optionalString(raw.agentId);
    if (!agentId)
        return null;
    // A frame must carry a raw event name (mapped in main via the resolving
    // plugin's agentStateSpec), a reporter-asserted phase (the OpenCode plugin,
    // stale reporter copies), or both. Neither ⇒ nothing to apply.
    const event = optionalString(raw.event);
    const phase = typeof raw.phase === 'string' && VALID_PHASES.has(raw.phase)
        ? raw.phase
        : null;
    if (!event && !phase)
        return null;
    // Clamp to server arrival time: raw.ts is reporter-supplied and compared
    // cross-clock against the main-process clock (terminal-runtime drops frames
    // where since > frame.ts, and since is written from Date.now()). A far-future
    // ts would pin the phase forever and future-date "working since"; a reporter
    // cannot legitimately be ahead of now, so cap it.
    const ts = typeof raw.ts === 'number' && Number.isFinite(raw.ts) ? Math.min(raw.ts, now) : now;
    const frame = {
        type: 'agent_state',
        agentId,
        workspaceId: optionalString(raw.workspaceId),
        sessionId: optionalString(raw.sessionId),
        event,
        ts,
    };
    if (phase)
        frame.phase = phase;
    const notificationType = optionalString(raw.notificationType);
    if (notificationType && notificationType.length <= MAX_NOTIFICATION_TYPE_LENGTH) {
        frame.notificationType = notificationType;
    }
    const status = optionalString(raw.status);
    if (status && status.length <= MAX_NOTIFICATION_TYPE_LENGTH) {
        frame.status = status;
    }
    const wakeup = parseFrameWakeup(raw.wakeup);
    if (wakeup)
        frame.wakeup = wakeup;
    const transcriptPath = optionalString(raw.transcriptPath);
    if (transcriptPath && transcriptPath.length <= MAX_TRANSCRIPT_PATH_LENGTH)
        frame.transcriptPath = transcriptPath;
    const prompt = optionalString(raw.prompt);
    if (prompt) {
        const trimmed = prompt.trim();
        if (trimmed)
            frame.prompt = trimmed.slice(0, MAX_AGENT_PROMPT_LENGTH);
    }
    return frame;
}
// A malformed wakeup drops (frame stands without it) — the reporter is
// untrusted, and a bogus hold is worse than a missed one: it parks a session.
function parseFrameWakeup(raw) {
    if (!isRecord(raw))
        return null;
    if (raw.stop === true)
        return { stop: true };
    if (typeof raw.delaySeconds === 'number' && Number.isFinite(raw.delaySeconds) && raw.delaySeconds > 0) {
        return { delaySeconds: Math.min(raw.delaySeconds, MAX_WAKEUP_DELAY_SECONDS) };
    }
    return null;
}
function candidateMatchesAgent(candidate, agentId) {
    return candidate.agentId === agentId || candidate.executionId === agentId || candidate.sessionId === agentId;
}
export function selectAgentStateTarget(candidates, frame) {
    const matches = candidates.filter((candidate) => candidateMatchesAgent(candidate, frame.agentId));
    if (matches.length <= 1)
        return matches[0]?.value;
    const scoped = frame.workspaceId
        ? matches.filter((candidate) => candidate.workspaceId === frame.workspaceId)
        : matches;
    const pool = scoped.length > 0 ? scoped : matches;
    return pool.reduce((latest, candidate) => (candidate.startedAt > latest.startedAt ? candidate : latest)).value;
}
// Raw shell command both install paths embed (Claude into JSON, Codex into TOML).
// `scriptPath` MUST be absolute: hook commands run with no guaranteed cwd (the
// session's working directory can drift into a subdirectory mid-run), so a
// workspace-relative path would misresolve and fail with MODULE_NOT_FOUND. The
// path is normalized to forward slashes (Node accepts them everywhere, incl.
// `C:/...` on Windows, which also avoids embedding unescaped backslashes).
// `socketPath` is VERBATIM: on Windows it is a `\\.\pipe\...` named pipe whose
// backslashes must survive (a separator rewrite would corrupt it to
// `//./pipe/...`, which connect() can't open); on POSIX it has none. Both args
// are double-quoted so spaces survive the shell.
export function buildAgentStateReporterCommand(scriptPath, socketPath) {
    return `node "${scriptPath.split(sep).join('/')}" --socket "${socketPath}"`;
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
// Reporter entries are recognized primarily by the `_multicode` tag, but other
// writers round-trip settings.local.json through schemas that drop unknown keys
// (Claude Code does this when it records e.g. enabledMcpjsonServers), stripping
// the tag. An untagged entry is unremovable by tag alone, and once the workspace
// root moves its absolute script path dangles, firing MODULE_NOT_FOUND on every
// event forever. So also claim untagged entries whose command has the exact
// shape buildAgentStateReporterCommand emits: the script path is always
// forward-slashed and ends in this suffix, immediately followed by `--socket`.
const AGENT_STATE_COMMAND_SIGNATURE = '/.multicode/hooks/agent-state.mjs" --socket "';
function isAgentStateEntry(entry) {
    if (entry?._multicode === AGENT_STATE_HOOK_TAG)
        return true;
    return (typeof entry?.command === 'string' &&
        entry.command.startsWith('node "') &&
        entry.command.includes(AGENT_STATE_COMMAND_SIGNATURE));
}
function ensureMatcherBlock(blocks, matcher) {
    const found = blocks.find((b) => b.matcher === matcher);
    if (found) {
        if (!Array.isArray(found.hooks))
            found.hooks = [];
        return found;
    }
    const next = matcher === undefined ? { hooks: [] } : { matcher, hooks: [] };
    blocks.push(next);
    return next;
}
// Remove every Multicode-tagged reporter entry from ALL event keys, pruning
// emptied matcher-blocks and then emptied event keys. Sweeping all keys — rather
// than only the currently-registered event set — self-heals an
// entry left behind by a prior release that registered an event we have since
// dropped (e.g. PreToolUse). Without this, that stale hook would keep spawning
// the reporter on every tool call and uninstall could never reach it.
function stripAgentStateEntries(hooks) {
    for (const event of Object.keys(hooks)) {
        const blocks = hooks[event];
        if (!Array.isArray(blocks))
            continue;
        for (const block of blocks) {
            if (!Array.isArray(block.hooks))
                continue;
            block.hooks = block.hooks.filter((entry) => !isAgentStateEntry(entry));
        }
        const kept = blocks.filter((b) => Array.isArray(b.hooks) && b.hooks.length > 0);
        if (kept.length === 0)
            delete hooks[event];
        else
            hooks[event] = kept;
    }
}
export async function mergeAgentStateHooks(settingsPath, command, events) {
    const existing = (await readJsonIfExists(settingsPath)) ?? {};
    const settings = { ...existing };
    if (!settings.hooks || typeof settings.hooks !== 'object')
        settings.hooks = {};
    // Clean up first (incl. entries for events we no longer register), then add the
    // current set — so install is both idempotent and a migration for stale hooks.
    stripAgentStateEntries(settings.hooks);
    for (const { event, matcher } of events) {
        if (!Array.isArray(settings.hooks[event]))
            settings.hooks[event] = [];
        const blocks = settings.hooks[event];
        const block = ensureMatcherBlock(blocks, matcher);
        const ours = { type: 'command', command, _multicode: AGENT_STATE_HOOK_TAG };
        const filtered = (block.hooks ?? []).filter((entry) => !isAgentStateEntry(entry));
        filtered.push(ours);
        block.hooks = filtered;
    }
    await mkdir(resolve(settingsPath, '..'), { recursive: true });
    await writeFile(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf8');
}
export async function unmergeAgentStateHooks(settingsPath) {
    const existing = await readJsonIfExists(settingsPath);
    if (!existing?.hooks || typeof existing.hooks !== 'object')
        return;
    // Sweep ALL event keys (not just the currently-registered ones) so uninstall
    // also removes hooks left by an older release under a since-dropped event.
    stripAgentStateEntries(existing.hooks);
    if (Object.keys(existing.hooks).length === 0)
        delete existing.hooks;
    await writeFile(settingsPath, JSON.stringify(existing, null, 2) + '\n', 'utf8');
}
function isAgentStateFlatEntry(entry) {
    return (typeof entry?.command === 'string' &&
        entry.command.startsWith('node "') &&
        entry.command.includes(AGENT_STATE_COMMAND_SIGNATURE));
}
function stripFlatAgentStateEntries(hooks) {
    for (const event of Object.keys(hooks)) {
        const entries = hooks[event];
        if (!Array.isArray(entries))
            continue;
        const kept = entries.filter((entry) => !isAgentStateFlatEntry(entry));
        if (kept.length === 0)
            delete hooks[event];
        else
            hooks[event] = kept;
    }
}
export async function mergeFlatAgentStateHooks(hooksPath, command, events) {
    const existing = (await readJsonIfExists(hooksPath)) ?? {};
    const file = { ...existing };
    if (typeof file.version !== 'number')
        file.version = 1;
    // An array-shaped `hooks` (malformed — the vendor schema wants an object)
    // would silently swallow string-keyed event assignments; replace it so the
    // registration actually lands rather than reporting ok and installing nothing.
    if (!file.hooks || typeof file.hooks !== 'object' || Array.isArray(file.hooks))
        file.hooks = {};
    // Clean up first (all event keys, incl. ones we no longer register), then add
    // the current set — install is both idempotent and a migration.
    stripFlatAgentStateEntries(file.hooks);
    for (const { event, matcher } of events) {
        if (!Array.isArray(file.hooks[event]))
            file.hooks[event] = [];
        const entry = matcher === undefined ? { command } : { command, matcher };
        file.hooks[event].push(entry);
    }
    await mkdir(resolve(hooksPath, '..'), { recursive: true });
    await writeFile(hooksPath, JSON.stringify(file, null, 2) + '\n', 'utf8');
}
export async function unmergeFlatAgentStateHooks(hooksPath) {
    const existing = await readJsonIfExists(hooksPath);
    if (!existing?.hooks || typeof existing.hooks !== 'object' || Array.isArray(existing.hooks))
        return;
    stripFlatAgentStateEntries(existing.hooks);
    // Match the settings-json unmerge: an emptied hooks map is deleted rather
    // than left as a `"hooks": {}` stub.
    if (Object.keys(existing.hooks).length === 0)
        delete existing.hooks;
    await writeFile(hooksPath, JSON.stringify(existing, null, 2) + '\n', 'utf8');
}
// =============================================================================
// TOML managed block (registration kind 'toml-block')
//
// A single tagged managed block (own markers, never the MCP block's) so the
// rest of the user's config file is preserved and the block is idempotently
// replaceable — the same discipline the MCP writer uses, which avoids the known
// footgun of an installer corrupting config.toml. The marker literals predate
// this generic writer (they shipped with the Codex integration) and MUST stay
// byte-identical so existing installed blocks are still recognized and replaced.
// =============================================================================
const AGENT_STATE_TOML_START = '# >>> multicode agent-state hooks managed';
const AGENT_STATE_TOML_END = '# <<< multicode agent-state hooks managed';
// TOML basic strings share JSON's escaping (matches the repo's MCP writer), so
// JSON.stringify yields a valid quoted value — and correctly escapes the Windows
// pipe path's backslashes.
function tomlBasicString(value) {
    return JSON.stringify(value);
}
function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
export function renderTomlAgentStateHooksBlock(command, events) {
    const lines = [
        AGENT_STATE_TOML_START,
        '# Generated for authoritative agent-state reporting. Remove this block to disable.',
    ];
    for (const { event, matcher } of events) {
        lines.push('', `[[hooks.${event}]]`);
        if (matcher !== undefined)
            lines.push(`matcher = ${tomlBasicString(matcher)}`);
        lines.push(`[[hooks.${event}.hooks]]`, 'type = "command"', `command = ${tomlBasicString(command)}`);
    }
    lines.push(AGENT_STATE_TOML_END);
    return lines.join('\n');
}
// Replace (or, with an empty block, remove) our managed hooks block, preserving
// everything else in the file. Mirrors the MCP writer's replaceManagedBlock.
function replaceTomlAgentStateBlock(previous, block) {
    const pattern = new RegExp(`${escapeRegExp(AGENT_STATE_TOML_START)}[\\s\\S]*?${escapeRegExp(AGENT_STATE_TOML_END)}\\n?`, 'm');
    const trimmed = previous.replace(pattern, '').trimEnd();
    if (!block)
        return trimmed ? `${trimmed}\n` : '';
    return `${trimmed}${trimmed ? '\n\n' : ''}${block}\n`;
}
export function mergeTomlAgentStateHooks(previous, command, events) {
    return replaceTomlAgentStateBlock(previous, renderTomlAgentStateHooksBlock(command, events));
}
export function unmergeTomlAgentStateHooks(previous) {
    return replaceTomlAgentStateBlock(previous, '');
}
// The array-of-tables variant (registration kind 'toml-array-block'): Kimi
// Code's hooks are `[[hooks]]` entries with an `event` key per table, not
// Codex's `[[hooks.<Event>]]` nesting. Same marker discipline (and the same
// marker literals — the two kinds never share a file, since each CLI names its
// own config path).
export function renderTomlArrayAgentStateHooksBlock(command, events) {
    const lines = [
        AGENT_STATE_TOML_START,
        '# Generated for authoritative agent-state reporting. Remove this block to disable.',
    ];
    for (const { event, matcher } of events) {
        lines.push('', '[[hooks]]', `event = ${tomlBasicString(event)}`);
        if (matcher !== undefined)
            lines.push(`matcher = ${tomlBasicString(matcher)}`);
        lines.push(`command = ${tomlBasicString(command)}`);
    }
    lines.push(AGENT_STATE_TOML_END);
    return lines.join('\n');
}
export function mergeTomlArrayAgentStateHooks(previous, command, events) {
    return replaceTomlAgentStateBlock(previous, renderTomlArrayAgentStateHooksBlock(command, events));
}
async function readTextIfExists(path) {
    try {
        return await readFile(path, 'utf8');
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return null;
        throw error;
    }
}
// =============================================================================
// Owned JSON hook config (registration kind 'owned-json')
//
// For CLIs whose hook discovery is per-file (Grok Build reads standalone JSON
// files under .grok/hooks/*.json) we own our config file outright: install is a
// plain write, uninstall a plain remove — no merge/unmerge bookkeeping. The
// per-event structure ({ matcher?, hooks: [{ type: 'command', command }] })
// mirrors Claude Code's settings hooks, which is the format Grok documents.
// =============================================================================
export function renderOwnedJsonAgentStateHooksConfig(command, events) {
    const hooks = {};
    for (const { event, matcher } of events) {
        const block = {};
        if (matcher !== undefined)
            block.matcher = matcher;
        block.hooks = [{ type: 'command', command }];
        hooks[event] = [block];
    }
    return JSON.stringify({ hooks }, null, 2) + '\n';
}
// =============================================================================
// Plugin-file reporter (registration kind 'plugin-file')
//
// For CLIs with no command-hook mechanism (OpenCode auto-loads in-process JS
// plugins and exposes a typed event stream), the reporter is a bundled plugin
// TEMPLATE named by the manifest's registration. It subscribes to the CLI's
// events itself and emits the same socket frames; the manifest's `events` table
// remains the canonical event→phase mapping the main process applies — the
// template's internal mapping only decides which events it reports and dedups
// on (frame `phase` is consulted solely when no spec entry resolves the event).
//
// A plugin can't take a --socket arg, so the live socket path is baked into the
// file at install time (token substitution); the plugin also honours
// MULTICODE_AGENT_STATE_SOCKET as a fallback. Note the OpenCode dest extension
// is .js while the bundled template ships as .mjs (the packaging filter is
// **/*.mjs; OpenCode's loader picks up .js/.ts but not .mjs, verified against
// opencode v1.17.11) — the manifest declares both names, so the rename is data.
// =============================================================================
// The quoted token in a plugin template that install replaces with the live
// socket path. Replacing the WHOLE quoted literal with JSON.stringify(path) keeps
// the value valid even for a Windows pipe path full of backslashes (splicing a
// bare string back inside the quotes would let those backslashes act as JS
// escapes and corrupt the path).
const PLUGIN_SOCKET_PLACEHOLDER = "'__MULTICODE_AGENT_STATE_SOCKET__'";
export function renderAgentStatePluginTemplate(template, socketPath) {
    return template.split(PLUGIN_SOCKET_PLACEHOLDER).join(JSON.stringify(socketPath));
}
// A user-scoped registration (Kimi Code's user-global config.toml) resolves
// against the home directory instead of the workspace. `homeDir` is injectable
// so tests never touch the real home.
function resolveRegistrationPath(workspaceRoot, registration, homeDir) {
    const base = registration.scope === 'user' ? homeDir : workspaceRoot;
    return resolve(base, ...registration.path.split('/'));
}
export async function installAgentStateReporter(workspaceRoot, spec, options) {
    if (!workspaceRoot?.trim())
        return { ok: false, message: 'Workspace root is required.' };
    if (!options.socketPath?.trim())
        return { ok: false, message: 'Agent-state socket path is required.' };
    if (!options.sourceScriptPath || !existsSync(options.sourceScriptPath)) {
        return { ok: false, message: 'Agent-state reporter script is missing from this build.' };
    }
    const registration = spec.registration;
    try {
        const homeDir = options.homeDir ?? homedir();
        const targetPath = resolveRegistrationPath(workspaceRoot, registration, homeDir);
        await mkdir(resolve(targetPath, '..'), { recursive: true });
        if (registration.kind === 'plugin-file') {
            const template = await readFile(options.sourceScriptPath, 'utf8');
            await writeFile(targetPath, renderAgentStatePluginTemplate(template, options.socketPath), 'utf8');
            return { ok: true, settingsPath: targetPath, hookScriptPath: targetPath };
        }
        // Command-hook kinds share the stdin-filter reporter, referenced by its
        // ABSOLUTE path (hook commands run with no guaranteed cwd). The copy lives
        // where the REGISTRATION lives: a workspace-scoped registration uses the
        // workspace copy; a user-scoped one (a user-global config like Kimi's)
        // gets a home-scoped copy (~/.multicode/hooks/) — pointing a user-global
        // config into a workspace would dangle machine-wide the moment that
        // workspace (or a sprint's finalize-deleted worktree) goes away, firing
        // MODULE_NOT_FOUND for every session of that CLI until reinstalled.
        const destScript = registration.scope === 'user'
            ? resolve(homeDir, AGENT_STATE_HOOK_SCRIPT_REL)
            : resolve(workspaceRoot, AGENT_STATE_HOOK_SCRIPT_REL);
        await mkdir(resolve(destScript, '..'), { recursive: true });
        await copyFile(options.sourceScriptPath, destScript);
        const command = buildAgentStateReporterCommand(destScript, options.socketPath);
        const events = registeredAgentStateEvents(spec);
        switch (registration.kind) {
            case 'settings-json':
                await mergeAgentStateHooks(targetPath, command, events);
                break;
            case 'flat-hooks-json':
                await mergeFlatAgentStateHooks(targetPath, command, events);
                break;
            case 'toml-block': {
                const previous = (await readTextIfExists(targetPath)) ?? '';
                await writeFile(targetPath, mergeTomlAgentStateHooks(previous, command, events), 'utf8');
                break;
            }
            case 'toml-array-block': {
                const previous = (await readTextIfExists(targetPath)) ?? '';
                await writeFile(targetPath, mergeTomlArrayAgentStateHooks(previous, command, events), 'utf8');
                break;
            }
            case 'owned-json':
                await writeFile(targetPath, renderOwnedJsonAgentStateHooksConfig(command, events), 'utf8');
                break;
        }
        return { ok: true, settingsPath: targetPath, hookScriptPath: destScript };
    }
    catch (error) {
        return {
            ok: false,
            message: error instanceof Error ? error.message : 'Failed to install agent-state reporter.',
        };
    }
}
export async function uninstallAgentStateReporter(workspaceRoot, spec, options = {}) {
    if (!workspaceRoot?.trim())
        return { ok: false, message: 'Workspace root is required.' };
    const registration = spec.registration;
    try {
        const targetPath = resolveRegistrationPath(workspaceRoot, registration, options.homeDir ?? homedir());
        switch (registration.kind) {
            case 'settings-json': {
                if (existsSync(targetPath))
                    await unmergeAgentStateHooks(targetPath);
                // The copied stdin-filter reporter is shared by every command-hook
                // registration in the workspace; the settings-json uninstall owns its
                // removal (legacy behavior — the other kinds leave it in place).
                const destScript = resolve(workspaceRoot, AGENT_STATE_HOOK_SCRIPT_REL);
                if (existsSync(destScript))
                    await rm(destScript, { force: true });
                break;
            }
            case 'flat-hooks-json':
                if (existsSync(targetPath))
                    await unmergeFlatAgentStateHooks(targetPath);
                break;
            case 'toml-block':
            case 'toml-array-block': {
                const previous = await readTextIfExists(targetPath);
                if (previous !== null)
                    await writeFile(targetPath, unmergeTomlAgentStateHooks(previous), 'utf8');
                break;
            }
            case 'owned-json':
            case 'plugin-file':
                if (existsSync(targetPath))
                    await rm(targetPath, { force: true });
                break;
        }
        return { ok: true };
    }
    catch (error) {
        return {
            ok: false,
            message: error instanceof Error ? error.message : 'Failed to uninstall agent-state reporter.',
        };
    }
}
