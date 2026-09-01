import { randomUUID } from 'node:crypto';
import { deriveActivityFromPhase } from '../agent-state';
import { AutomationsStore } from './store';
import { computeNextRun, scheduleCadenceCanExhaust, validateScheduleTriggerConfig } from './schedule';
import { evaluatePollingTriggerDefinition } from './polling-trigger-runner';
import { readTranscriptSummary } from './transcript-summary';
import { completeAutomationRun as completeRun } from './run-record';
import { enqueueTriggerEventRun } from './trigger-event-runner';
const DEFAULT_POLL_INTERVAL_MS = 60_000;
// A turn end is not the same as being done: a Stop hook in the user's own repo
// settings can continue the turn, an agent can end its turn to ask a question,
// plan mode ends a turn, and ESC ends a turn. Finalizing is destructive (opens a
// PR, removes the worktree, kills the agent), so an armed turn-end waits this
// long and any working-phase frame in the window disarms it.
const DEFAULT_TURN_SETTLE_MS = 15_000;
// Bounded backstop for runs whose agent never reports a turn end. Every
// selectable agent CLI reports via lifecycle hooks now (the hook-capable gate),
// so this is no longer "the hookless-CLI path" — it survives because frame
// delivery is best-effort over a local socket: a lost Stop frame, a reporter
// install that failed on a read-only tree, or a hook system the CLI vendor
// broke in an update all leave a run with no turn end. Past this age a pending
// run is failed rather than left Running forever — the bug this whole path
// exists to fix.
const DEFAULT_MAX_AGENT_RUN_MS = 6 * 60 * 60 * 1000;
export class AutomationsEngine {
    getProjectFolders;
    getWorkspaceSnapshot;
    createStore;
    getTriggerProviders;
    isIntegrationAvailable;
    runAutomation;
    now;
    createRunId;
    pollIntervalMs;
    onEvaluation;
    onRunEvent;
    openRunPullRequest;
    removeRunWorktree;
    disposeRunAgent;
    getLiveAgentExecutionIds;
    turnSettleMs;
    maxAgentRunMs;
    readRunTranscriptSummary;
    inFlight = new Set();
    pendingAgentRuns = new Map();
    // Per-run finalize lock (pendingRunKey shape). Closes the manual-IPC vs
    // signal-scan TOCTOU: only the first caller finalizes; a concurrent caller
    // gets the in-progress/terminal run back instead of double-opening a PR.
    finalizingRuns = new Set();
    timer = null;
    started = false;
    startupEvaluation = null;
    timerEvaluation = null;
    constructor(options) {
        this.getProjectFolders = options.getProjectFolders;
        this.getWorkspaceSnapshot = options.getWorkspaceSnapshot;
        this.createStore = options.createStore ?? ((workspaceRoot) => new AutomationsStore(workspaceRoot));
        const staticTriggerProviders = options.triggerProviders ?? [];
        this.getTriggerProviders = options.getTriggerProviders ?? (() => staticTriggerProviders);
        this.isIntegrationAvailable = options.isIntegrationAvailable;
        this.runAutomation = options.runAutomation;
        this.now = options.now ?? Date.now;
        this.createRunId = options.createRunId ?? (() => `automation-run-${randomUUID()}`);
        this.pollIntervalMs = Math.max(1_000, Math.floor(options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS));
        this.onEvaluation = options.onEvaluation;
        this.onRunEvent = options.onRunEvent;
        this.openRunPullRequest = options.openRunPullRequest;
        this.removeRunWorktree = options.removeRunWorktree;
        this.disposeRunAgent = options.disposeRunAgent;
        this.getLiveAgentExecutionIds = options.getLiveAgentExecutionIds;
        this.turnSettleMs = Math.max(0, Math.floor(options.turnSettleMs ?? DEFAULT_TURN_SETTLE_MS));
        this.maxAgentRunMs = Math.max(1_000, Math.floor(options.maxAgentRunMs ?? DEFAULT_MAX_AGENT_RUN_MS));
        this.readRunTranscriptSummary = options.readRunTranscriptSummary ?? readTranscriptSummary;
    }
    start() {
        if (this.started)
            return;
        this.started = true;
        const startup = this.handleStartup();
        void startup
            .catch(() => undefined)
            .finally(() => {
            if (!this.started || this.timer)
                return;
            this.timer = setInterval(() => {
                void this.tick();
            }, this.pollIntervalMs);
        });
    }
    stop() {
        // Armed turn-ends are cleared unconditionally: a settle timer that survives
        // stop() would finalize a run — opening a PR and disposing an agent — for an
        // engine the app has already torn down. Disarming also aborts an in-flight
        // armed finalize at its post-transcript-read check; only a finalize that has
        // already entered finalizeRun still runs to completion.
        for (const pending of this.pendingAgentRuns.values())
            this.disarmTurnEnd(pending);
        if (!this.started && !this.timer)
            return;
        this.started = false;
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }
    isRunning() {
        return this.started;
    }
    async handleStartup() {
        if (this.startupEvaluation)
            return this.startupEvaluation;
        let startup;
        startup = this.evaluate('startup').finally(() => {
            if (this.startupEvaluation === startup)
                this.startupEvaluation = null;
        });
        this.startupEvaluation = startup;
        return startup;
    }
    async tick() {
        const startup = this.startupEvaluation;
        if (startup)
            await startup;
        if (this.timerEvaluation)
            return emptyEvaluationResult();
        let timerEvaluation;
        timerEvaluation = this.evaluate('timer').finally(() => {
            if (this.timerEvaluation === timerEvaluation)
                this.timerEvaluation = null;
        });
        this.timerEvaluation = timerEvaluation;
        return timerEvaluation;
    }
    async runNow(input) {
        const store = this.createStore(input.workspaceRoot);
        const definitionResult = await store.getDefinition(input.automationId);
        if (!definitionResult.ok) {
            return { ok: false, problem: storeProblem(input.workspaceRoot, definitionResult.error, input.automationId) };
        }
        const definition = definitionResult.value;
        if (definition.trigger.kind !== 'schedule') {
            return {
                ok: false,
                problem: {
                    workspaceRoot: input.workspaceRoot,
                    automationId: definition.id,
                    code: 'unsupported_trigger',
                    message: `Automation "${definition.id}" cannot run because trigger "${definition.trigger.kind}" is not supported.`,
                },
            };
        }
        const validation = validateScheduleTriggerConfig(definition.trigger.config);
        if (!validation.ok) {
            return {
                ok: false,
                problem: {
                    workspaceRoot: input.workspaceRoot,
                    automationId: definition.id,
                    code: 'invalid_schedule',
                    message: validation.error,
                },
            };
        }
        const stateResult = await store.readState();
        if (!stateResult.ok) {
            return { ok: false, problem: storeProblem(input.workspaceRoot, stateResult.error, definition.id) };
        }
        const state = stateResult.value ?? { nextRunAtByAutomationId: {}, lock: null };
        const inFlightKey = this.inFlightKey(input.workspaceRoot, definition.id);
        if (this.inFlight.has(inFlightKey)) {
            return {
                ok: false,
                problem: {
                    workspaceRoot: input.workspaceRoot,
                    automationId: definition.id,
                    code: 'in_flight',
                    message: `Automation "${definition.id}" is already running.`,
                },
            };
        }
        this.inFlight.add(inFlightKey);
        try {
            const now = this.now();
            const dueAt = new Date(now).toISOString();
            const run = this.runRecord(input.workspaceRoot, definition.id, dueAt, {
                status: 'running',
                startedAt: dueAt,
                completedAt: null,
            });
            const started = await store.recordRun(run);
            if (!started.ok) {
                return { ok: false, problem: storeProblem(input.workspaceRoot, started.error, definition.id) };
            }
            let finalRun;
            try {
                const patch = await this.runAutomation({
                    workspaceRoot: input.workspaceRoot,
                    definition,
                    run,
                    triggerPayload: input.triggerPayload ?? { kind: 'manual', dueAt },
                    workspaceId: input.workspaceId ?? await this.resolveWorkspaceIdForRoot(input.workspaceRoot) ?? undefined,
                });
                const completedAt = patch.completedAt ?? new Date(this.now()).toISOString();
                finalRun = completeRun(run, patch, completedAt);
            }
            catch (error) {
                const failedAt = new Date(this.now()).toISOString();
                finalRun = completeRun(run, {
                    status: 'failed',
                    completedAt: failedAt,
                    summary: error instanceof Error ? error.message : 'Automation action failed.',
                }, failedAt);
            }
            const completed = await store.recordRun(finalRun);
            if (!completed.ok) {
                return { ok: false, problem: storeProblem(input.workspaceRoot, completed.error, definition.id) };
            }
            const eventWorkspaceId = input.workspaceId
                ?? await this.resolveWorkspaceIdForRoot(input.workspaceRoot)
                ?? finalRun.workspaceId;
            this.trackPendingAgentRun(input.workspaceRoot, finalRun, eventWorkspaceId);
            this.emitRunEvent({
                workspaceId: eventWorkspaceId,
                definition,
                run: finalRun,
                trigger: 'manual',
            });
            const completedAt = Date.parse(finalRun.completedAt ?? dueAt);
            const result = emptyEvaluationResult();
            const nextRunAt = nextRunIso(validation.value, completedAt);
            const updated = await this.updateDefinitionAfterRun(store, state, input.workspaceRoot, definition, validation.value, finalRun, nextRunAt, completedAt, result, 
            // Manual "Run now" does not consume a once-off's single triggered fire.
            { consumeOnceOffShot: false });
            if (!updated) {
                return {
                    ok: false,
                    problem: result.problems[0] ?? {
                        workspaceRoot: input.workspaceRoot,
                        automationId: definition.id,
                        code: 'definition_update_failed',
                        message: `Automation "${definition.id}" ran, but its schedule could not be updated.`,
                    },
                };
            }
            const refreshed = await store.getDefinition(definition.id);
            if (!refreshed.ok) {
                return { ok: false, problem: storeProblem(input.workspaceRoot, refreshed.error, definition.id) };
            }
            return { ok: true, definition: refreshed.value, run: finalRun };
        }
        finally {
            this.inFlight.delete(inFlightKey);
        }
    }
    async deliverTriggerEvent(input) {
        const store = this.createStore(input.workspaceRoot);
        const definitionResult = await store.getDefinition(input.automationId);
        if (!definitionResult.ok) {
            return { ok: false, problem: storeProblem(input.workspaceRoot, definitionResult.error, input.automationId) };
        }
        const definition = definitionResult.value;
        if (definition.status !== 'enabled') {
            return {
                ok: false,
                problem: {
                    workspaceRoot: input.workspaceRoot,
                    automationId: definition.id,
                    code: 'automation_disabled',
                    message: `Automation "${definition.id}" is not enabled.`,
                },
            };
        }
        if (definition.trigger.kind === 'schedule') {
            return {
                ok: false,
                problem: {
                    workspaceRoot: input.workspaceRoot,
                    automationId: definition.id,
                    code: 'unsupported_trigger',
                    message: `Automation "${definition.id}" cannot receive external trigger events for schedule triggers.`,
                },
            };
        }
        const provider = this.getTriggerProviders().find((candidate) => candidate.kind === definition.trigger.kind);
        if (!provider) {
            return {
                ok: false,
                problem: {
                    workspaceRoot: input.workspaceRoot,
                    automationId: definition.id,
                    code: 'unknown_trigger',
                    message: `No automation trigger provider is registered for "${definition.trigger.kind}".`,
                },
            };
        }
        const validation = provider.validateConfig?.(definition.trigger.config);
        if (validation && !validation.ok) {
            return {
                ok: false,
                problem: {
                    workspaceRoot: input.workspaceRoot,
                    automationId: definition.id,
                    code: 'invalid_trigger_config',
                    message: validation.error,
                },
            };
        }
        const missingIntegrations = (provider.requiredIntegrations ?? [])
            .filter((id) => this.isIntegrationAvailable?.(id) !== true);
        if (missingIntegrations.length > 0) {
            return {
                ok: false,
                problem: {
                    workspaceRoot: input.workspaceRoot,
                    automationId: definition.id,
                    code: 'missing_trigger_integration',
                    message: `Required trigger integration is unavailable: ${missingIntegrations.join(', ')}.`,
                },
            };
        }
        const stateResult = await store.readState();
        if (!stateResult.ok) {
            return { ok: false, problem: storeProblem(input.workspaceRoot, stateResult.error, definition.id) };
        }
        const state = stateResult.value ?? { nextRunAtByAutomationId: {}, lock: null };
        const result = emptyEvaluationResult();
        const workspaceId = input.workspaceId ?? await this.resolveWorkspaceIdForRoot(input.workspaceRoot) ?? '';
        const delivery = await enqueueTriggerEventRun({
            store,
            state,
            projectFolder: { workspaceId, folderPath: input.workspaceRoot },
            definition,
            event: input.event,
            runAutomation: this.runAutomation,
            now: this.now,
            createRunId: this.createRunId,
            inFlight: this.inFlight,
            emitRunEvent: (event) => {
                this.trackPendingAgentRun(input.workspaceRoot, event.run, event.workspaceId ?? workspaceId);
                this.emitRunEvent({ ...event, trigger: 'timer' });
            },
            result,
        });
        if (delivery.status === 'problem')
            return { ok: false, problem: delivery.problem };
        return { ok: true, definition, delivery };
    }
    // Records the terminal outcome of an agent-backed run that was dispatched as
    // `running`. On a `completed` outcome it backstop-commits + opens (or reuses) a
    // PR for the run's branch; either way it tears down the run's worktree, records
    // the terminal run, and emits the run-event. Idempotent: a run already in a
    // terminal state is returned unchanged.
    async finalizeRun(input) {
        const runKey = this.pendingRunKey(input.workspaceRoot, input.automationId, input.runId);
        // Drop from the pending registry on any finalize (manual or auto) so a later
        // frame or tick never re-finalizes a run that is already being finalized —
        // and cancel any settle timer still armed for it.
        const pending = this.pendingAgentRuns.get(runKey);
        if (pending)
            this.disarmTurnEnd(pending);
        this.pendingAgentRuns.delete(runKey);
        const store = this.createStore(input.workspaceRoot);
        // Serialize finalize per run: a concurrent manual IPC finalize and the
        // per-tick scan must not both pass the 'running' check below and double-open
        // a PR / double-emit. The first caller holds the lock; a second caller reads
        // the current run and returns it (in-progress or terminal) without re-running.
        if (this.finalizingRuns.has(runKey)) {
            const concurrentRun = await store.getRun(input.automationId, input.runId);
            if (!concurrentRun.ok) {
                return { ok: false, problem: storeProblem(input.workspaceRoot, concurrentRun.error, input.automationId) };
            }
            return { ok: true, run: concurrentRun.value };
        }
        this.finalizingRuns.add(runKey);
        try {
            return await this.finalizeRunLocked(input, store);
        }
        finally {
            this.finalizingRuns.delete(runKey);
        }
    }
    // The finalize trigger for the happy path: an accepted agent-state phase
    // transition for one of this app's agent terminals. Frames for agents that own
    // no pending run (every non-automation agent) fall straight through.
    //
    // A working phase marks the run as having done work and disarms any settle
    // timer. A turn end (or an OpenCode session error) arms one, but only past the
    // guards — each of which stands between a live agent and a destructive
    // finalize that opens a PR from half-finished work, removes the agent's cwd,
    // and kills it:
    //   - the event is a real turn end, not a Task subagent's (the manifest-
    //     resolved turnEnd flag owns this: SubagentStop maps to the same phase as
    //     Stop, so the phase alone cannot tell them apart);
    //   - the run has been seen working, so a stray idle frame before the prompt
    //     lands cannot finalize instantly;
    //   - the agent has no wakeup armed — a self-paced (/loop) agent intends to
    //     resume, and pendingWakeupAt is resolved from the SESSION because the
    //     reporter never attaches a wakeup to a turn-end frame;
    //   - the settle window elapses with no further work (see DEFAULT_TURN_SETTLE_MS).
    async noteAgentPhase(event) {
        const pending = this.findPendingRunByAgent(event.workspaceId, event.agentId);
        if (!pending)
            return;
        // Backfill an executionId the launch probe missed, so the pty-exit path can
        // still correlate on it for a run whose agentId is somehow absent.
        if (event.executionId && !pending.executionId)
            pending.executionId = event.executionId;
        // "Working" is read through the shared phase vocabulary rather than a local
        // phase list, so a new working phase cannot silently stop cancelling a
        // settle timer here.
        if (deriveActivityFromPhase(event.phase, event.ts)?.kind === 'working') {
            pending.observedWorkingPhase = true;
            this.disarmTurnEnd(pending);
            return;
        }
        const failed = event.turnFailure;
        if (!failed && !event.turnEnd)
            return;
        if (!pending.observedWorkingPhase)
            return;
        if (event.pendingWakeupAt !== null && event.pendingWakeupAt > this.now())
            return;
        if (pending.armedTurnEnd)
            return;
        pending.armedTurnEnd = {
            outcome: failed ? 'failed' : 'completed',
            transcriptPath: event.transcriptPath,
            timer: setTimeout(() => {
                void this.finalizeArmedTurnEnd(pending);
            }, this.turnSettleMs),
        };
        pending.armedTurnEnd.timer.unref?.();
    }
    // Agent-lifecycle finalize trigger: the owning module routes a real agent-
    // session pty exit here. Correlates on the executionId or on
    // (workspaceId, agentId); an exit matching no pending run (a non-automation
    // agent, or an already-finalized run) is ignored.
    //
    // An armed turn-end WINS over the exit: an agent that finished its turn and
    // then exited inside the settle window succeeded, and recording it as failed
    // would throw away its PR. Only an exit with no turn-end behind it is a
    // failure. Routed 'timer' so a failed auto-finalize still emits a run-event
    // while a completed one stays silent. Shares finalizeRun's lock and
    // idempotency, so a concurrent tick/manual finalize still yields one record.
    async finalizeRunOnAgentExit(input) {
        const executionId = input.executionId?.trim();
        const pending = (executionId ? this.findPendingRunByExecutionId(executionId) : undefined)
            ?? this.findPendingRunByAgent(input.workspaceId ?? null, input.agentId ?? '');
        if (!pending)
            return;
        if (pending.armedTurnEnd) {
            await this.finalizeArmedTurnEnd(pending);
            // The armed finalize can abort if a straggler working frame disarmed it
            // mid-transcript-read. The pty is gone either way, so a run the abort
            // left pending falls through to the exit outcome below instead of
            // hanging until the max-duration sweep.
            if (!this.pendingAgentRuns.has(this.pendingRunKey(pending.workspaceRoot, pending.automationId, pending.runId))) {
                return;
            }
        }
        await this.finalizeRun({
            workspaceRoot: pending.workspaceRoot,
            automationId: pending.automationId,
            runId: pending.runId,
            outcome: 'failed',
            summary: `The agent stopped before it finished (exit code ${input.exitCode}).`,
            workspaceId: pending.workspaceId,
            eventTrigger: 'timer',
        });
    }
    // Fire an armed turn-end. Single-flight: the settle timer and a racing pty
    // exit share one in-flight finalize, so the armed outcome always wins over
    // the exit's `failed`. The armed record stays on the run while the transcript
    // is read; anything that disarms it during that read — a working-phase frame
    // (the agent resumed), a manual finalize, stop() — aborts the finalize
    // instead of racing it.
    finalizeArmedTurnEnd(pending) {
        const armed = pending.armedTurnEnd;
        if (!armed)
            return Promise.resolve();
        if (!armed.finalizing) {
            clearTimeout(armed.timer);
            armed.finalizing = this.finalizeTurnEnd(pending, armed);
        }
        return armed.finalizing;
    }
    // The body of an armed turn-end finalize: derive the summary, then finalize.
    // Best-effort by design — no transcript, or an unreadable one, degrades to a
    // generic summary and never blocks the finalize.
    async finalizeTurnEnd(pending, armed) {
        const transcriptSummary = armed.transcriptPath
            ? await this.readRunTranscriptSummary(armed.transcriptPath)
            : undefined;
        // Disarmed during the transcript read: the turn-end no longer stands, so
        // finalizing now would dispose an agent that is working again (or drive an
        // engine that has been stopped). finalizeRun below re-disarms and drops the
        // pending entry synchronously, so this check cannot miss its own finalize.
        if (pending.armedTurnEnd !== armed)
            return;
        // Every summary here is read verbatim by a person in the run row, so it names
        // the cause in plain language and never in the runtime's vocabulary: a "turn"
        // is an agent-runtime concept, and a user reading their automation history has
        // no model for it. The completed fallback in particular must not overclaim —
        // with no transcript, all that is actually known is that the agent stopped
        // talking, so it says exactly that rather than "finished its turn".
        const summary = armed.outcome === 'failed'
            ? 'The agent hit an error and stopped before it finished.'
            : transcriptSummary ?? 'The agent finished, but left no summary of what it did.';
        await this.finalizeRun({
            workspaceRoot: pending.workspaceRoot,
            automationId: pending.automationId,
            runId: pending.runId,
            outcome: armed.outcome,
            summary,
            workspaceId: pending.workspaceId,
            eventTrigger: 'timer',
        });
    }
    disarmTurnEnd(pending) {
        if (!pending.armedTurnEnd)
            return;
        clearTimeout(pending.armedTurnEnd.timer);
        pending.armedTurnEnd = undefined;
    }
    async finalizeRunLocked(input, store) {
        const runResult = await store.getRun(input.automationId, input.runId);
        if (!runResult.ok) {
            return { ok: false, problem: storeProblem(input.workspaceRoot, runResult.error, input.automationId) };
        }
        const run = runResult.value;
        if (run.status !== 'running' && run.status !== 'queued') {
            // Already finalized — return it unchanged (idempotent re-finalize).
            return { ok: true, run };
        }
        const definitionResult = await store.getDefinition(input.automationId);
        const definitionName = definitionResult.ok ? definitionResult.value.name : input.automationId;
        let pullRequestUrl;
        const summaryParts = [];
        if (input.summary?.trim())
            summaryParts.push(input.summary.trim());
        if (input.outcome === 'completed' && run.branch && run.worktreePath && this.openRunPullRequest) {
            const pr = await this.openRunPullRequest({
                workspaceRoot: input.workspaceRoot,
                worktreePath: run.worktreePath,
                branch: run.branch,
                title: `Automation: ${definitionName}`,
                body: `Opened by the "${definitionName}" automation (run ${run.id}).`,
            });
            if (pr.ok) {
                pullRequestUrl = pr.url;
                summaryParts.push(pr.created ? `Opened pull request ${pr.url}.` : `Linked existing pull request ${pr.url}.`);
            }
            else {
                summaryParts.push(`No pull request linked: ${pr.reason}`);
            }
        }
        if (run.worktreePath && this.removeRunWorktree) {
            try {
                await this.removeRunWorktree({ workspaceRoot: input.workspaceRoot, worktreePath: run.worktreePath });
            }
            catch {
                // Worktree teardown is best-effort; a leftover worktree is swept later
                // and must not fail the finalize.
            }
        }
        // Dispose the run's one-shot agent alongside its worktree: kill the terminal,
        // drop the tab, delete the record. This is what prevents the dead-cwd relaunch
        // loop — with no surviving agent there is nothing to relaunch into the removed
        // worktree. Best-effort, and reached by the startup reconcile too (it re-runs
        // finalize for runs orphaned while Multicode was down), so a crash mid-run is
        // also covered.
        if (run.workspaceId && run.agentId && this.disposeRunAgent) {
            try {
                await this.disposeRunAgent({ workspaceId: run.workspaceId, agentId: run.agentId });
            }
            catch {
                // Best-effort teardown; a failure leaves the pre-fix behavior, not worse.
            }
        }
        const finalRun = {
            ...run,
            status: input.outcome,
            completedAt: new Date(this.now()).toISOString(),
            pullRequestUrl,
            summary: summaryParts.length > 0 ? summaryParts.join(' ') : run.summary,
        };
        const recorded = await store.recordRun(finalRun);
        if (!recorded.ok) {
            return { ok: false, problem: storeProblem(input.workspaceRoot, recorded.error, input.automationId) };
        }
        const eventTrigger = input.eventTrigger ?? 'manual';
        const emitTerminalEvent = eventTrigger === 'manual' || finalRun.status === 'failed';
        if (definitionResult.ok && emitTerminalEvent) {
            const eventWorkspaceId = input.workspaceId
                ?? run.workspaceId
                ?? await this.resolveWorkspaceIdForRoot(input.workspaceRoot)
                ?? undefined;
            this.emitRunEvent({
                workspaceId: eventWorkspaceId,
                definition: definitionResult.value,
                run: finalRun,
                trigger: eventTrigger,
            });
        }
        return { ok: true, run: finalRun };
    }
    async evaluate(mode) {
        const result = emptyEvaluationResult();
        const now = this.now();
        const projectFolders = await this.loadProjectFolders(result);
        // Rebuild the pending-run registry from disk once at startup so agent runs
        // dispatched before an app restart are still finalized when their signal lands.
        if (mode === 'startup') {
            await this.seedPendingAgentRuns(projectFolders);
            // Force-fail runs orphaned while Multicode was down before the scan below
            // gets a chance to leave them pending forever (their agent is gone).
            await this.reconcileOrphanedAgentRuns();
        }
        const pollContext = createTriggerPollContext();
        const triggerProvidersByKind = new Map(this.getTriggerProviders().map((provider) => [provider.kind, provider]));
        for (const projectFolder of projectFolders) {
            await this.evaluateProject(projectFolder, mode, now, pollContext, triggerProvidersByKind, result);
        }
        await this.scanPendingAgentRuns();
        this.onEvaluation?.(result);
        return result;
    }
    // Max-duration sweep — the per-tick backstop, and the only thing the tick does
    // for pending runs now that finalization is frame-driven. A run whose agent
    // reports no frames at all (a CLI outside the reporter set) or whose turn-end
    // frame was lost would otherwise sit Running forever; past the cap it is
    // failed. A younger run is left alone for its frames.
    async scanPendingAgentRuns() {
        if (this.pendingAgentRuns.size === 0)
            return;
        const now = this.now();
        for (const pending of [...this.pendingAgentRuns.values()]) {
            if (now - pending.startedAtMs < this.maxAgentRunMs)
                continue;
            await this.finalizeRun({
                workspaceRoot: pending.workspaceRoot,
                automationId: pending.automationId,
                runId: pending.runId,
                outcome: 'failed',
                // Names the limit it actually hit: "past its maximum duration" leaves the
                // user with no way to tell a hung agent from one that simply needed longer.
                summary: `The agent was still running after ${formatRunLimit(this.maxAgentRunMs)}, so Multicode stopped waiting and ended the run.`,
                workspaceId: pending.workspaceId,
                eventTrigger: 'timer',
            });
        }
    }
    // Startup reconciliation: an agent-backed run recorded `running` whose
    // executionId is NOT among the live agent executions had its agent end while
    // Multicode was down — force-fail it. A run whose executionId is still live
    // stays pending for its frames; a run with no recorded executionId is never
    // force-failed here (nothing proves its agent is gone) and is covered by the
    // max-duration sweep instead.
    async reconcileOrphanedAgentRuns() {
        if (!this.getLiveAgentExecutionIds || this.pendingAgentRuns.size === 0)
            return;
        const liveExecutionIds = new Set(this.getLiveAgentExecutionIds());
        for (const pending of [...this.pendingAgentRuns.values()]) {
            if (!pending.executionId || liveExecutionIds.has(pending.executionId))
                continue;
            await this.finalizeRun({
                workspaceRoot: pending.workspaceRoot,
                automationId: pending.automationId,
                runId: pending.runId,
                outcome: 'failed',
                summary: 'The agent stopped while the app was closed, so this run never finished.',
                workspaceId: pending.workspaceId,
                eventTrigger: 'timer',
            });
        }
    }
    findPendingRunByExecutionId(executionId) {
        for (const pending of this.pendingAgentRuns.values()) {
            if (pending.executionId === executionId)
                return pending;
        }
        return undefined;
    }
    // (workspaceId, agentId) is the correlation key on the frame path: both are
    // stamped on every agent-backed run at launch-confirm, and both ride every
    // agent-state frame. A partial key matches nothing.
    findPendingRunByAgent(workspaceId, agentId) {
        if (!workspaceId || !agentId)
            return undefined;
        for (const pending of this.pendingAgentRuns.values()) {
            if (pending.workspaceId === workspaceId && pending.agentId === agentId)
                return pending;
        }
        return undefined;
    }
    async seedPendingAgentRuns(projectFolders) {
        for (const projectFolder of projectFolders) {
            const store = this.createStore(projectFolder.folderPath);
            const definitions = await store.listDefinitions();
            if (!definitions.ok)
                continue;
            for (const definition of definitions.values) {
                const runs = await store.listRuns(definition.id);
                if (!runs.ok)
                    continue;
                for (const run of runs.values) {
                    this.trackPendingAgentRun(projectFolder.folderPath, run, projectFolder.workspaceId);
                }
            }
        }
    }
    // Register a dispatched agent-backed run for finalization. A run WITHOUT a
    // worktree (runInWorktree: false) is registered too — it used to be dropped
    // here, which is why those runs had no finalize path at all and sat Running
    // forever. Called on dispatch and again on the startup seed, so an existing
    // entry keeps its live phase state and only refreshes its correlation fields.
    trackPendingAgentRun(workspaceRoot, run, workspaceId) {
        if (run.status !== 'running')
            return;
        const key = this.pendingRunKey(workspaceRoot, run.automationId, run.id);
        const existing = this.pendingAgentRuns.get(key);
        if (existing) {
            existing.worktreePath = run.worktreePath ?? existing.worktreePath;
            existing.workspaceId = workspaceId ?? run.workspaceId ?? existing.workspaceId;
            existing.agentId = run.agentId ?? existing.agentId;
            existing.executionId = run.executionId ?? existing.executionId;
            return;
        }
        const startedAt = Date.parse(run.startedAt ?? '');
        this.pendingAgentRuns.set(key, {
            workspaceRoot,
            automationId: run.automationId,
            runId: run.id,
            worktreePath: run.worktreePath,
            workspaceId: workspaceId ?? run.workspaceId,
            agentId: run.agentId,
            executionId: run.executionId,
            startedAtMs: Number.isFinite(startedAt) ? startedAt : this.now(),
            observedWorkingPhase: false,
        });
    }
    pendingRunKey(workspaceRoot, automationId, runId) {
        return `${normalizeWorkspaceRoot(workspaceRoot)}\u0000${automationId}\u0000${runId}`;
    }
    async loadProjectFolders(result) {
        try {
            const projectFolders = this.getProjectFolders
                ? await this.getProjectFolders()
                : this.getWorkspaceSnapshot
                    ? projectFoldersFromWorkspaceSyncSnapshot(await this.getWorkspaceSnapshot())
                    : [];
            return dedupeProjectFolders(projectFolders);
        }
        catch (error) {
            result.problems.push({
                code: 'workspace_snapshot_failed',
                message: error instanceof Error ? error.message : 'Unable to read workspace snapshot.',
            });
            return [];
        }
    }
    async evaluateProject(projectFolder, mode, now, pollContext, triggerProvidersByKind, result) {
        const workspaceRoot = projectFolder.folderPath;
        const store = this.createStore(workspaceRoot);
        const definitions = await store.listDefinitions();
        if (!definitions.ok) {
            for (const error of definitions.errors) {
                result.problems.push(storeProblem(workspaceRoot, error));
            }
            return;
        }
        const stateResult = await store.readState();
        if (!stateResult.ok) {
            result.problems.push(storeProblem(workspaceRoot, stateResult.error));
            return;
        }
        const state = stateResult.value ?? { nextRunAtByAutomationId: {}, lock: null };
        for (const definition of definitions.values) {
            await this.evaluateDefinition(store, state, projectFolder, definition, mode, now, pollContext, triggerProvidersByKind, result);
        }
    }
    async evaluateDefinition(store, state, projectFolder, definition, mode, now, pollContext, triggerProvidersByKind, result) {
        const workspaceRoot = projectFolder.folderPath;
        if (definition.status !== 'enabled')
            return;
        if (definition.trigger.kind !== 'schedule') {
            await evaluatePollingTriggerDefinition({
                store,
                state,
                projectFolder,
                definition,
                triggerProvidersByKind,
                pollContext,
                isIntegrationAvailable: this.isIntegrationAvailable,
                runAutomation: this.runAutomation,
                now: this.now,
                createRunId: this.createRunId,
                inFlight: this.inFlight,
                emitRunEvent: (event) => {
                    this.trackPendingAgentRun(projectFolder.folderPath, event.run, event.workspaceId ?? projectFolder.workspaceId);
                    this.emitRunEvent({ ...event, trigger: 'timer' });
                },
                result,
            });
            return;
        }
        const validation = validateScheduleTriggerConfig(definition.trigger.config);
        if (!validation.ok) {
            result.problems.push({
                workspaceRoot,
                automationId: definition.id,
                code: 'invalid_schedule',
                message: validation.error,
            });
            return;
        }
        const nextRunAt = definition.nextRunAt ?? state.nextRunAtByAutomationId[definition.id] ?? null;
        if (!nextRunAt) {
            await this.persistNextRun(store, state, workspaceRoot, definition, validation.value, now, result);
            return;
        }
        const dueAt = Date.parse(nextRunAt);
        if (!Number.isFinite(dueAt)) {
            result.problems.push({
                workspaceRoot,
                automationId: definition.id,
                code: 'invalid_next_run_at',
                message: `Automation "${definition.id}" has an invalid nextRunAt value.`,
            });
            return;
        }
        if (mode === 'startup' && dueAt < now) {
            await this.skipOverdueRun(store, state, workspaceRoot, definition, validation.value, nextRunAt, now, result);
            return;
        }
        if (dueAt <= now) {
            await this.fireDueRun(store, state, projectFolder, definition, validation.value, nextRunAt, result);
            return;
        }
        if (state.nextRunAtByAutomationId[definition.id] !== nextRunAt) {
            state.nextRunAtByAutomationId[definition.id] = nextRunAt;
            const written = await store.writeState(state);
            if (!written.ok)
                result.problems.push(storeProblem(workspaceRoot, written.error, definition.id));
        }
        result.scheduled.push({ workspaceRoot, automationId: definition.id, nextRunAt });
    }
    async persistNextRun(store, state, workspaceRoot, definition, config, after, result) {
        const nextRunAt = nextRunIso(config, after);
        if (!nextRunAt) {
            // A one-shot whose fire time has passed simply has no upcoming run —
            // documented terminal state, nothing to persist and nothing to report.
            if (scheduleCadenceCanExhaust(config))
                return;
            result.problems.push({
                workspaceRoot,
                automationId: definition.id,
                code: 'next_run_unavailable',
                message: `Unable to compute next run for automation "${definition.id}".`,
            });
            return;
        }
        const updated = await store.updateDefinition({
            ...definition,
            nextRunAt,
            updatedAt: new Date(after).toISOString(),
        });
        if (!updated.ok) {
            result.problems.push(storeProblem(workspaceRoot, updated.error, definition.id));
            return;
        }
        state.nextRunAtByAutomationId[definition.id] = nextRunAt;
        const written = await store.writeState(state);
        if (!written.ok) {
            result.problems.push(storeProblem(workspaceRoot, written.error, definition.id));
            return;
        }
        result.scheduled.push({ workspaceRoot, automationId: definition.id, nextRunAt });
    }
    async skipOverdueRun(store, state, workspaceRoot, definition, config, dueAt, now, result) {
        const completedAt = new Date(now).toISOString();
        const run = this.runRecord(workspaceRoot, definition.id, dueAt, {
            status: 'skipped',
            startedAt: null,
            completedAt,
            blockedReason: 'overdue_not_replayed',
            summary: 'Missed while Multicode was not running; skipped instead of replaying catch-up runs.',
        });
        const recorded = await store.recordRun(run);
        if (!recorded.ok) {
            result.problems.push(storeProblem(workspaceRoot, recorded.error, definition.id));
            return;
        }
        const nextRunAt = nextRunIso(config, now);
        const updated = await this.updateDefinitionAfterRun(store, state, workspaceRoot, definition, config, run, nextRunAt, now, result);
        if (updated)
            result.skipped.push({ workspaceRoot, automationId: definition.id, runId: run.id, status: run.status });
    }
    async fireDueRun(store, state, projectFolder, definition, config, dueAt, result) {
        const workspaceRoot = projectFolder.folderPath;
        const inFlightKey = this.inFlightKey(workspaceRoot, definition.id);
        if (this.inFlight.has(inFlightKey)) {
            result.droppedInFlight.push({ workspaceRoot, automationId: definition.id });
            return;
        }
        this.inFlight.add(inFlightKey);
        const startedAt = new Date(this.now()).toISOString();
        const run = this.runRecord(workspaceRoot, definition.id, dueAt, {
            status: 'running',
            startedAt,
            completedAt: null,
        });
        try {
            const started = await store.recordRun(run);
            if (!started.ok) {
                result.problems.push(storeProblem(workspaceRoot, started.error, definition.id));
                return;
            }
            const patch = await this.runAutomation({
                workspaceRoot,
                definition,
                run,
                triggerPayload: { kind: 'schedule', dueAt },
                workspaceId: projectFolder.workspaceId,
            });
            const completedAt = patch.completedAt ?? new Date(this.now()).toISOString();
            const finalRun = completeRun(run, patch, completedAt);
            const completed = await store.recordRun(finalRun);
            if (!completed.ok) {
                result.problems.push(storeProblem(workspaceRoot, completed.error, definition.id));
                return;
            }
            this.trackPendingAgentRun(workspaceRoot, finalRun, projectFolder.workspaceId);
            this.emitRunEvent({
                workspaceId: projectFolder.workspaceId,
                definition,
                run: finalRun,
                trigger: 'timer',
            });
            const nextRunAt = nextRunIso(config, Date.parse(completedAt));
            const updated = await this.updateDefinitionAfterRun(store, state, workspaceRoot, definition, config, finalRun, nextRunAt, Date.parse(completedAt), result);
            if (updated)
                result.fired.push({ workspaceRoot, automationId: definition.id, runId: finalRun.id, status: finalRun.status });
        }
        catch (error) {
            const failedAt = new Date(this.now()).toISOString();
            const failedRun = completeRun(run, {
                status: 'failed',
                completedAt: failedAt,
                summary: error instanceof Error ? error.message : 'Automation action failed.',
            }, failedAt);
            const recorded = await store.recordRun(failedRun);
            if (!recorded.ok)
                result.problems.push(storeProblem(workspaceRoot, recorded.error, definition.id));
            else {
                this.emitRunEvent({
                    workspaceId: projectFolder.workspaceId,
                    definition,
                    run: failedRun,
                    trigger: 'timer',
                });
            }
            const nextRunAt = nextRunIso(config, Date.parse(failedAt));
            const updated = await this.updateDefinitionAfterRun(store, state, workspaceRoot, definition, config, failedRun, nextRunAt, Date.parse(failedAt), result);
            if (updated)
                result.fired.push({ workspaceRoot, automationId: definition.id, runId: failedRun.id, status: failedRun.status });
        }
        finally {
            this.inFlight.delete(inFlightKey);
        }
    }
    async updateDefinitionAfterRun(store, state, workspaceRoot, definition, config, run, nextRunAt, updatedAt, result, 
    // `runNow` passes false: a once-off (`disableAfterRun`) pauses after one
    // *triggered* fire — a manual run never consumes the shot.
    options) {
        // Once-off consumption: pause instead of rescheduling. A skipped overdue run
        // routes through here too, so a missed once-off records its `skipped` run and
        // then pauses (the documented missed-run rule). A failed run also consumed
        // the shot — the user re-enables to arm it again.
        const pauseAfterRun = options?.consumeOnceOffShot !== false
            && definition.disableAfterRun === true
            && definition.status === 'enabled';
        if (!pauseAfterRun && !nextRunAt && !scheduleCadenceCanExhaust(config)) {
            result.problems.push({
                workspaceRoot,
                automationId: definition.id,
                code: 'next_run_unavailable',
                message: `Unable to compute next run for automation "${definition.id}".`,
            });
            return false;
        }
        // A null nextRunAt here is a fired (or already-past) one-shot: persisting
        // the null — definition AND state cache — is exactly what makes it fire
        // exactly once instead of staying due forever. A paused once-off has no
        // upcoming run either, whatever its cadence would have computed.
        const persistedNextRunAt = pauseAfterRun ? null : nextRunAt;
        const updated = await store.updateDefinition({
            ...definition,
            ...(pauseAfterRun ? { status: 'paused' } : {}),
            nextRunAt: persistedNextRunAt,
            lastRunAt: run.completedAt ?? new Date(updatedAt).toISOString(),
            lastRunId: run.id,
            updatedAt: new Date(updatedAt).toISOString(),
        });
        if (!updated.ok) {
            result.problems.push(storeProblem(workspaceRoot, updated.error, definition.id));
            return false;
        }
        state.nextRunAtByAutomationId[definition.id] = persistedNextRunAt;
        const stateWrite = await store.writeState(state);
        if (!stateWrite.ok) {
            result.problems.push(storeProblem(workspaceRoot, stateWrite.error, definition.id));
            return false;
        }
        if (persistedNextRunAt)
            result.scheduled.push({ workspaceRoot, automationId: definition.id, nextRunAt: persistedNextRunAt });
        return true;
    }
    runRecord(workspaceRoot, automationId, dueAt, fields) {
        return {
            id: this.createRunId({ workspaceRoot, automationId, dueAt }),
            automationId,
            dueAt,
            ...fields,
        };
    }
    inFlightKey(workspaceRoot, automationId) {
        return `${workspaceRoot}\u0000${automationId}`;
    }
    emitRunEvent(input) {
        if (!this.onRunEvent || !isRunEventStatus(input.run.status))
            return;
        const workspaceId = input.workspaceId?.trim();
        if (!workspaceId)
            return;
        const event = {
            automationId: input.definition.id,
            runId: input.run.id,
            workspaceId,
            ...(input.run.agentId ? { agentId: input.run.agentId } : {}),
            definitionName: input.definition.name,
            status: input.run.status,
            trigger: input.trigger,
        };
        try {
            this.onRunEvent(event, input.definition);
        }
        catch {
            // Renderer delivery is best-effort; run records and IPC results are authoritative.
        }
    }
    async resolveWorkspaceIdForRoot(workspaceRoot) {
        try {
            const projectFolders = this.getProjectFolders
                ? await this.getProjectFolders()
                : this.getWorkspaceSnapshot
                    ? projectFoldersFromWorkspaceSyncSnapshot(await this.getWorkspaceSnapshot())
                    : [];
            const normalizedRoot = normalizeWorkspaceRoot(workspaceRoot);
            return dedupeProjectFolders(projectFolders).find((folder) => normalizeWorkspaceRoot(folder.folderPath) === normalizedRoot)?.workspaceId ?? null;
        }
        catch {
            return null;
        }
    }
}
export function createAutomationsEngine(options) {
    return new AutomationsEngine(options);
}
export function projectFoldersFromWorkspaceSyncSnapshot(snapshot) {
    return dedupeProjectFolders(snapshot.state.workspaces.flatMap((workspace) => {
        const folderPath = workspace.folderPath?.trim();
        return folderPath ? [{ workspaceId: workspace.id, folderPath }] : [];
    }));
}
// The max-run limit as a person would say it, for the sweep's run summary. Read
// from the configured cap rather than hardcoded, so the number a user is told is
// always the number that was actually applied.
function formatRunLimit(ms) {
    const hours = ms / 3_600_000;
    if (hours >= 1) {
        const rounded = Math.round(hours * 10) / 10;
        return `${rounded} ${rounded === 1 ? 'hour' : 'hours'}`;
    }
    const minutes = Math.max(1, Math.round(ms / 60_000));
    return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
}
function nextRunIso(config, after) {
    const nextRun = computeNextRun(config, after);
    return nextRun === null ? null : new Date(nextRun).toISOString();
}
function createTriggerPollContext() {
    const sharedValues = new Map();
    return {
        getSharedValue(key, factory) {
            const existing = sharedValues.get(key);
            if (existing)
                return existing;
            const created = Promise.resolve().then(factory);
            sharedValues.set(key, created);
            return created;
        },
    };
}
function dedupeProjectFolders(projectFolders) {
    const seen = new Set();
    const deduped = [];
    for (const projectFolder of projectFolders) {
        const folderPath = projectFolder.folderPath.trim();
        if (!folderPath)
            continue;
        const key = folderPath.replace(/\\/g, '/').replace(/\/+$/u, '').toLowerCase();
        if (seen.has(key))
            continue;
        seen.add(key);
        deduped.push({ workspaceId: projectFolder.workspaceId, folderPath });
    }
    return deduped;
}
function isRunEventStatus(status) {
    return status === 'completed' || status === 'failed' || status === 'blocked';
}
function normalizeWorkspaceRoot(workspaceRoot) {
    return workspaceRoot.replace(/\\/g, '/').replace(/\/+$/u, '').toLowerCase();
}
function storeProblem(workspaceRoot, error, automationId) {
    return {
        workspaceRoot,
        automationId,
        code: error.code,
        message: `${error.path}: ${error.message}`,
    };
}
function emptyEvaluationResult() {
    return {
        scheduled: [],
        fired: [],
        skipped: [],
        droppedInFlight: [],
        problems: [],
    };
}
