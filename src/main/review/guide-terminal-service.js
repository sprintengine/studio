// The review guide as an ordinary terminal agent (MC-1783).
//
// The guide used to run on the companion/conversation path: Claude-only, hidden
// from the session manager, and driven by a stream-scraping harness. It now runs
// as a plain agent terminal under whichever CLI the reviewer picked, with the
// `review-guide` builtin skill attached at spawn and the walkthrough delivered
// through the Studio gateway's `review_submit_brief` tool. Nothing here parses
// the guide's output.
//
// It runs WITH the project as its cwd and IN the project's Reviews-host
// workspace (MC-1911) — a rail-hidden residency that holds review guides and
// nothing else, so the guide is never a stray tab among the reviewer's own
// agents. The Reviews door is what finds and opens it.
//
// Where the spawn happens: the app's programmatic agent-terminal seam is the
// terminal runtime's spawn handler (the same one the sprint scheduler drives
// in-process), reached here through injected ports so this module stays free of
// Electron. The renderer owns only the AgentState that makes the terminal
// openable as a tab — it reads the agent/session coordinates off this service's
// result, exactly as the session-manager reattach path does.
//
// Progress is tool-call and file truth, never inferred from output:
//   - `reading` when the terminal is spawned or the prompt is delivered,
//   - `grouping` once the guide has the prompt and is working,
//   - `done` when `review_submit_brief` lands (recorded by the gateway),
//   - `failed` when the terminal ends without a brief, or the reviewer stops it.
// Every phase goes to the guide-run registry (which outlives the renderer) and
// the BriefRunEvent channel, so a remount rediscovers a live run.
import { randomUUID } from 'crypto';
import { resolve } from 'path';
import { isModeHiddenFromRail, REVIEWS_HOST_WORKSPACE_MODE } from '../../shared/workspace-mode';
import { guideRunRegistry, } from './guide-run-registry';
// The builtin skill that carries every word of the guide's craft and contract
// (MC-1782). It is attached at spawn, so this module never states any of it.
export const REVIEW_GUIDE_SKILL_ID = 'review-guide';
// Session-manager label for the guide's terminal.
export const REVIEW_GUIDE_AGENT_NAME = 'Review guide';
// Where the skill always lands, whatever the CLI: the harness-neutral copy the
// builtin skill manager installs alongside any native ones. Named in the join
// prompt for CLIs whose plugin declares no native skill invocation, so the guide
// can read its own instructions instead of running without them.
const REVIEW_GUIDE_SKILL_FILE = `.agents/skills/${REVIEW_GUIDE_SKILL_ID}/SKILL.md`;
// A review id is the on-disk directory name and becomes this agent's id; hold it
// to the same shape the change-set service and the review MCP tools enforce.
const REVIEW_ID_PATTERN = /^[A-Za-z0-9._-]+$/;
// Terminal geometry for a session no view has bound yet. The reviewer's terminal
// resizes it on open; this only has to be wide enough that the CLI's own startup
// output is not wrapped into nonsense in the retained scrollback.
const GUIDE_TERMINAL_COLS = 120;
const GUIDE_TERMINAL_ROWS = 30;
// The two ways a guide run ends without a brief. Both point at the terminal,
// because that is where the reason actually is.
const ENDED_WITHOUT_BRIEF_DETAIL = 'The guide session ended without delivering a walkthrough — its terminal has the details.';
const STOPPED_DETAIL = 'You stopped the guide.';
// One guide agent per review, deterministic from the review id, so a second
// start finds the live terminal instead of spawning a twin and the renderer can
// reattach a tab to it.
//
// This is the AGENT id, never the terminal session id. The two used to be the
// same string, which broke the guide outright on every Claude-harness CLI: a
// manifest declaring `sessionIdFromCaller` renders our terminal key into
// `--session-id <id>` at launch (see resources/plugins/claude-code/plugin.json),
// and Claude rejects anything that is not a UUID — the CLI exited before it
// started and the reviewer got a bare shell. Session ids are minted per spawn
// (`randomUUID`, exactly as every other agent-terminal caller does) and the live
// terminal is found by its agent id instead.
export function reviewGuideAgentId(reviewId) {
    return `review-guide-${reviewId}`;
}
export class ReviewGuideTerminalService {
    deps;
    guideRuns;
    // At most ONE open run per review, so starting a run replaces (and thereby
    // clears) whatever the review had before — no record accumulates. The entry
    // remembers the terminal's EXECUTION id, which is unique per pty unlike the
    // deliberately stable session id, so a replaced terminal's exit is recognised
    // as belonging to a run that is over and can never fail its successor.
    inFlight = new Map();
    nextExecution = 1;
    stopWatchdog;
    constructor(deps) {
        this.deps = deps;
        this.guideRuns = deps.guideRuns ?? guideRunRegistry;
        this.stopWatchdog = deps.terminal.onAgentSessionExit((event) => this.onAgentExit(event));
    }
    // Release the exit listener. Called when the review module tears down, so a
    // disable/enable cycle never leaves a listener pointed at a dead service.
    dispose() {
        this.stopWatchdog();
    }
    // Start (or join) the guide run for a review. One guide terminal per review:
    // a live terminal receives the new prompt, otherwise one is spawned. A start
    // against a run already in flight reports that run instead of interrupting it,
    // unless the caller asked for a restart (the freshness re-run does).
    async startRun(input) {
        const { reviewId, projectRoot, depth, affectedStepIds, restart } = input;
        const invalid = validateTarget(reviewId, projectRoot);
        if (invalid)
            return { ok: false, error: invalid };
        const live = this.guideRuns.status(reviewId);
        if (live?.running && !restart) {
            const joined = this.currentHandle(reviewId);
            // A registry entry that outlived its terminal (the app restarted, the
            // session was reaped) is not a run anyone can join — fall through and
            // start a fresh one rather than reporting a run with nothing behind it.
            if (joined)
                return { ok: true, joined: true, status: live, guide: joined };
        }
        // Every path out of here reaches a terminal phase: a run left marked live
        // would make every later start join a run that is already dead.
        const recorder = this.guideRuns.begin(reviewId);
        const prepared = this.prepareTerminal(reviewId, projectRoot, input.cli, input.hostWorkspaceId);
        if (!prepared.ok)
            return this.fail(recorder, reviewId, prepared.error);
        const prompt = this.buildRunPrompt({
            reviewId,
            projectRoot: prepared.projectRoot,
            depth,
            affectedStepIds,
            cli: prepared.handle.cli,
        });
        this.emitPhase(recorder, reviewId, 'reading');
        const delivered = await this.deliver(prepared, prompt, input.cliModel);
        if (!delivered.ok)
            return this.fail(recorder, reviewId, delivered.error);
        // The guide owns the terminal until it delivers: the idle reaper must not
        // suspend a session that is mid-walkthrough.
        this.deps.terminal.setReapExempt(prepared.handle.sessionId, true);
        this.inFlight.set(reviewId, { executionId: prepared.executionId, recorder });
        this.emitPhase(recorder, reviewId, 'grouping');
        return { ok: true, guide: prepared.handle, reused: delivered.reused };
    }
    // "Ask the guide": send one question to the review's guide terminal, spawning
    // it when none is live. The answer is read in the terminal — that is the point
    // of the redesign — so this reports only where to look, never a reply. Asking
    // is not a run: it records no phase and never touches an in-flight walkthrough.
    async ask(input) {
        const { reviewId, projectRoot, question } = input;
        const invalid = validateTarget(reviewId, projectRoot);
        if (invalid)
            return { ok: false, error: invalid };
        if (question.trim().length === 0)
            return { ok: false, error: 'Ask the guide a question first.' };
        const prepared = this.prepareTerminal(reviewId, projectRoot, input.cli, input.hostWorkspaceId);
        if (!prepared.ok)
            return { ok: false, error: prepared.error };
        const prompt = this.buildAskPrompt({
            reviewId,
            projectRoot: prepared.projectRoot,
            question: question.trim(),
            cli: prepared.handle.cli,
        });
        const delivered = await this.deliver(prepared, prompt, input.cliModel);
        if (!delivered.ok)
            return { ok: false, error: delivered.error };
        return { ok: true, guide: prepared.handle };
    }
    // The reviewer stopped the run. Kill the guide's terminal and record the stop
    // as this run's terminal phase, so the panel shows why it ended and the
    // watchdog stays silent for the exit it is about to see.
    stop(reviewId) {
        const sessionId = this.findGuideSession(reviewGuideAgentId(reviewId))?.sessionId;
        const entry = this.inFlight.get(reviewId);
        this.inFlight.delete(reviewId);
        if (entry)
            this.emitPhase(entry.recorder, reviewId, 'failed', STOPPED_DETAIL);
        else if (this.guideRuns.status(reviewId)?.running) {
            // A run this process did not start (a registry record adopted from the
            // review tools) still ends when the reviewer stops its terminal.
            this.guideRuns.record(reviewId, 'failed', STOPPED_DETAIL);
            this.deps.emit({ workspaceId: reviewId, phase: 'failed', detail: STOPPED_DETAIL });
        }
        if (!sessionId)
            return;
        this.deps.terminal.setReapExempt(sessionId, false);
        this.deps.terminal.kill(sessionId);
    }
    // The run ended by delivering: `review_submit_brief` landed and the gateway's
    // sink calls this. The terminal is still alive and the reviewer may never open
    // it, so without this the pty stays exempt from the idle reaper for the rest
    // of the app session — one unsuspendable agent process retained per reviewed
    // change (item 1806). The in-flight record goes with it: the run is over, so a
    // later stop() must not overwrite the delivered `done` with a failure.
    clearReapExempt(reviewId) {
        this.inFlight.delete(reviewId);
        const sessionId = this.findGuideSession(reviewGuideAgentId(reviewId))?.sessionId;
        if (sessionId)
            this.deps.terminal.setReapExempt(sessionId, false);
    }
    // The watchdog. A guide terminal that ends without a brief failed, whatever
    // the reason — a crashed CLI, a closed tab, an agent that gave up. The
    // registry, not this map, decides whether the run is still open: a brief that
    // landed through review_submit_brief already closed it, and the terminal
    // exiting afterwards is just the CLI quitting.
    onAgentExit(event) {
        const found = [...this.inFlight].find(([, entry]) => entry.executionId === event.executionId);
        if (!found)
            return;
        const [reviewId, entry] = found;
        this.inFlight.delete(reviewId);
        const sessionId = this.findGuideSession(reviewGuideAgentId(reviewId))?.sessionId;
        if (sessionId)
            this.deps.terminal.setReapExempt(sessionId, false);
        if (!this.guideRuns.status(reviewId)?.running)
            return;
        this.emitPhase(entry.recorder, reviewId, 'failed', ENDED_WITHOUT_BRIEF_DETAIL);
    }
    // Resolve the workspace, the CLI, and the live-or-fresh terminal for a review.
    prepareTerminal(reviewId, projectRoot, requestedCli, hostWorkspaceId) {
        const normalizedRoot = resolve(projectRoot);
        const workspaceId = this.resolveHostWorkspace(normalizedRoot, hostWorkspaceId);
        if (!workspaceId) {
            // The degraded walkthrough keeps the review readable; only the guide needs
            // the project open, and saying so is the whole fix.
            return { ok: false, error: 'Open the project to run the guide.' };
        }
        const agentId = reviewGuideAgentId(reviewId);
        const existing = this.findGuideSession(agentId);
        const liveSession = existing && existing.processAlive && !existing.suspended ? existing : null;
        const cli = requestedCli?.trim() || liveSession?.cli || this.lastAgentCli(normalizedRoot);
        if (!cli) {
            return { ok: false, error: 'Choose which agent CLI should run the review guide.' };
        }
        // A live terminal keeps its session id — the prompt is pasted into it. Any
        // other outcome is a fresh spawn, which mints a fresh UUID rather than
        // inheriting the dead session's: a Claude-harness CLI is launched with
        // `--session-id <it>` and refuses an id it has already used.
        const sessionId = liveSession?.sessionId ?? randomUUID();
        return {
            ok: true,
            projectRoot: normalizedRoot,
            liveSession: liveSession !== null,
            // A retained session whose process is gone (exited, or suspended by the
            // reaper) must be disposed before the fresh spawn, or the runtime keeps
            // holding a record for an agent that now has a live terminal elsewhere.
            ...(existing && !liveSession ? { staleSessionId: existing.sessionId } : {}),
            // A reused terminal keeps the execution id it was spawned with — that is
            // the id its exit will carry. A fresh one gets a new id, so the pty being
            // replaced cannot be mistaken for the one taking its place.
            executionId: liveSession?.agentSession?.executionId ?? `${agentId}#${this.nextExecution++}`,
            handle: { workspaceId, agentId, sessionId, cli },
        };
    }
    // This review's guide terminal, live or retained, found by AGENT id — the one
    // identity that is stable across spawns now that session ids are minted.
    findGuideSession(agentId) {
        return this.deps.terminal
            .list()
            .find((session) => session.kind === 'agent' && session.agentId === agentId);
    }
    // Deliver a prompt to the guide: paste it into the live terminal, or spawn one
    // with the prompt as its opening input.
    async deliver(prepared, prompt, cliModel) {
        const { handle } = prepared;
        if (prepared.liveSession) {
            const sent = await this.deps.terminal.sendPrompt(handle.sessionId, prompt);
            if (!sent.ok) {
                return { ok: false, error: sent.message ?? 'Could not deliver the prompt to the guide terminal.' };
            }
            return { ok: true, reused: true };
        }
        // The retained record for this agent's previous terminal has to go before
        // the fresh spawn, or the guide is listed twice — once as a dead session and
        // once as the live one. Its pty exit arrives after this one starts, which is
        // exactly why in-flight runs are keyed by execution id: the dead terminal's
        // exit cannot touch the new run.
        if (prepared.staleSessionId)
            this.deps.terminal.kill(prepared.staleSessionId);
        const settings = this.deps.launchSettings?.();
        const spawned = await this.deps.terminal.spawn({
            sessionId: handle.sessionId,
            cols: GUIDE_TERMINAL_COLS,
            rows: GUIDE_TERMINAL_ROWS,
            cwd: prepared.projectRoot,
            cli: handle.cli,
            initialPrompt: prompt,
            ...(settings?.cliRuntimes ? { cliRuntimes: settings.cliRuntimes } : {}),
            ...(settings?.mcp ? { mcpSettings: settings.mcp } : {}),
            kind: 'agent',
            workspaceId: handle.workspaceId,
            agentId: handle.agentId,
            agentName: REVIEW_GUIDE_AGENT_NAME,
            // The guide reads the change, the surrounding code, and the knowledge
            // graph, then calls the review tools — unattended. On the default preset
            // it stalls at the first approval prompt with nobody watching, so it runs
            // with the same preset the Design Wizard's unattended specialists use.
            cliPermissionPreset: 'bypass_all',
            ...(cliModel?.trim() ? { cliModel: cliModel.trim() } : {}),
            // Installs the skill into this CLI's native skill dir before launch, so
            // the invocation in the prompt resolves to a skill that is really there.
            spawnSkillId: REVIEW_GUIDE_SKILL_ID,
            // No view is bound to this session yet; the reviewer opens it from the
            // session manager (or the run banner's link) when they want to watch.
            visible: false,
            // Gives the runtime an execution identity, which is what makes it report
            // this session's exit to the watchdog.
            agentSession: {
                executionId: prepared.executionId,
                system: 'manual',
                workspaceId: handle.workspaceId,
                workspaceRoot: prepared.projectRoot,
                workId: handle.agentId,
                role: 'review-guide',
                displayName: REVIEW_GUIDE_AGENT_NAME,
            },
        });
        if (!spawned.ok)
            return { ok: false, error: spawned.message ?? 'The guide terminal could not start.' };
        return { ok: true, reused: false };
    }
    // The join prompt carries ONLY run coordinates. Every word about what a
    // walkthrough is and how to build one lives in the skill.
    buildRunPrompt(input) {
        const refresh = input.affectedStepIds?.length
            ? [`Refresh: regenerate only these steps, carry the rest over verbatim: ${input.affectedStepIds.join(', ')}`]
            : [];
        return [
            this.skillLead(input.cli),
            '',
            'You are the Review guide for this review. Build its walkthrough and deliver it with review_submit_brief.',
            '',
            `Review: ${input.reviewId}`,
            `Project root: ${input.projectRoot}`,
            `Depth: ${input.depth}`,
            ...refresh,
        ].join('\n');
    }
    buildAskPrompt(input) {
        return [
            this.skillLead(input.cli),
            '',
            'You are the Review guide for this review. This is a question from the reviewer, not a request for a',
            'walkthrough: answer it in this terminal and submit nothing.',
            '',
            `Review: ${input.reviewId}`,
            `Project root: ${input.projectRoot}`,
            '',
            `Question: ${input.question}`,
        ].join('\n');
    }
    // How the guide gets its instructions. A CLI with native skill support is
    // handed its own invocation; one without is pointed at the installed skill
    // file, which the spawn just wrote into the project. Either way the craft text
    // reaches the agent from the skill and is never restated here.
    skillLead(cli) {
        return (this.deps.resolveSkillInvocation(cli)
            ?? `Read ${REVIEW_GUIDE_SKILL_FILE} and follow it for this whole session.`);
    }
    // Which workspace hosts the guide's terminal (MC-1911). The Reviews host: a
    // per-project workspace that exists to hold review guides and nothing else.
    // The caller's id wins outright — the renderer mints the host immediately
    // before starting, so requiring it in this process's workspace-sync snapshot
    // would lose a race it has no reason to run.
    //
    // The guide used to land in the project's STANDARD workspace (item 1807),
    // which put a "Review guide" tab among the reviewer's own agents in whatever
    // project they had open. That reasoning — a rail-hidden workspace is one the
    // reviewer cannot get back to — is answered by the Reviews door: it owns the
    // link to this terminal, exactly as the Sprints door owns the link to a run's
    // agents. Every OTHER hidden workspace is still excluded, so the guide can
    // never end up parked inside a sprint run.
    resolveHostWorkspace(projectRoot, hostWorkspaceId) {
        const requested = hostWorkspaceId?.trim();
        if (requested)
            return requested;
        const matches = this.deps
            .listWorkspaces()
            .filter((workspace) => normalizeFolder(workspace.folderPath) === projectRoot);
        const host = matches.find((workspace) => workspace.mode === REVIEWS_HOST_WORKSPACE_MODE);
        if (host)
            return host.id;
        // No host yet (a caller that predates one, or a run started from outside the
        // door): fall back to the project's own workspace rather than refusing.
        const visible = matches.filter((workspace) => !workspace.mode || !isModeHiddenFromRail(workspace.mode));
        return (visible.find((workspace) => workspace.mode === 'standard') ?? visible[0])?.id ?? null;
    }
    // The CLI a live guide terminal is already running, or the one the reviewer
    // last used for an agent anywhere in this project. Only a guess for a caller
    // that named none; when there is nothing to go on, the start fails visibly.
    // Keyed by the project's folder rather than one workspace id: the guide's own
    // host workspace is new and empty, so its agent list would never answer.
    lastAgentCli(projectRoot) {
        const workspaceIds = new Set(this.deps
            .listWorkspaces()
            .filter((workspace) => normalizeFolder(workspace.folderPath) === projectRoot)
            .map((workspace) => workspace.id));
        return this.deps.terminal
            .list()
            .filter((session) => session.kind === 'agent'
            && session.cli
            && session.workspaceId !== undefined
            && workspaceIds.has(session.workspaceId))
            .sort((left, right) => right.startedAt - left.startedAt)[0]?.cli;
    }
    // The terminal a joinable run is running in, or null when nothing is live
    // under this review's guide id.
    currentHandle(reviewId) {
        const agentId = reviewGuideAgentId(reviewId);
        const session = this.findGuideSession(agentId);
        if (!session?.processAlive)
            return null;
        return {
            workspaceId: session.workspaceId ?? '',
            agentId,
            sessionId: session.sessionId,
            cli: session.cli ?? '',
        };
    }
    // Both sinks, one decision: the registry (which outlives the renderer) and the
    // live event channel. A run the registry has already replaced goes silent on
    // both, so a dying run never reports on the one that replaced it.
    emitPhase(recorder, reviewId, phase, detail) {
        if (!recorder.record(phase, detail))
            return;
        this.deps.emit(detail ? { workspaceId: reviewId, phase, detail } : { workspaceId: reviewId, phase });
    }
    fail(recorder, reviewId, error) {
        this.emitPhase(recorder, reviewId, 'failed', error);
        return { ok: false, error };
    }
}
export function createReviewGuideTerminalService(deps) {
    return new ReviewGuideTerminalService(deps);
}
// Record a brief that landed through the Studio gateway's review_submit_brief
// against the run registry. The gateway broadcasts the event to open windows but
// knows nothing about runs, so without this a terminal guide would finish while
// the status IPC still reported it working — and every later start would join a
// run that already delivered.
export function recordGuideRunEvent(event, registry = guideRunRegistry) {
    registry.record(event.workspaceId, event.phase, event.detail);
}
function validateTarget(reviewId, projectRoot) {
    if (typeof reviewId !== 'string' || !REVIEW_ID_PATTERN.test(reviewId)) {
        return 'That review id is not a review this app can address.';
    }
    if (typeof projectRoot !== 'string' || projectRoot.trim().length === 0) {
        return 'Open the project to run the guide.';
    }
    return null;
}
function normalizeFolder(folderPath) {
    const trimmed = folderPath?.trim();
    return trimmed ? resolve(trimmed) : null;
}
