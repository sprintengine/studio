import { trackerWriteBackPostKey, } from '../../../shared/tracker/writeback';
import { pullRequestComment, runCompletedComment, runStartedComment } from './messages';
export class TrackerWriteBackEngine {
    deps;
    constructor(deps) {
        this.deps = deps;
    }
    // Reconcile every proxy item on a run against the tracker. Never throws — a
    // failure to read state, list items, or post is contained and reported.
    async reconcileRun(input) {
        try {
            if (!(await this.deps.config.anyActive())) {
                return { posted: 0, failed: 0, skipped: 0, reason: 'no_active_config' };
            }
            const facts = await this.deps.runState.readRunFacts({ statePath: input.statePath });
            if (!facts)
                return { posted: 0, failed: 0, skipped: 0, reason: 'run_unreadable' };
            if (!facts.started)
                return { posted: 0, failed: 0, skipped: 0, reason: 'not_started' };
            const items = await this.deps.proxyItems.proxyItemsForRun({
                workspaceRoot: input.workspaceRoot,
                statePath: input.statePath,
            });
            if (items.length === 0)
                return { posted: 0, failed: 0, skipped: 0, reason: 'no_proxy_items' };
            let posted = 0;
            let failed = 0;
            let skipped = 0;
            for (const item of items) {
                const config = await this.deps.config.get(item.connectionId);
                if (!config.enabled) {
                    // Disabling mid-run stops future posts; already-posted comments stay.
                    skipped += 1;
                    continue;
                }
                const capabilities = this.deps.capabilities.capabilitiesFor(item.provider);
                const desired = desiredPostsFor(facts, config, capabilities);
                for (const post of desired) {
                    const key = trackerWriteBackPostKey({
                        runId: facts.runId,
                        postKind: post.postKind,
                        externalId: item.externalId,
                        ...(post.type === 'comment' && post.keyDiscriminator ? { discriminator: post.keyDiscriminator } : {}),
                    });
                    if (await this.deps.ledger.hasPosted(key)) {
                        skipped += 1;
                        continue;
                    }
                    const outcome = await this.attempt(item, post, key, input.statePath);
                    if (outcome === 'posted')
                        posted += 1;
                    else
                        failed += 1;
                }
            }
            return { posted, failed, skipped };
        }
        catch (err) {
            // The last line of failure isolation: even a bug in the reconcile itself
            // must never surface into the run lifecycle that called us.
            this.deps.logDiagnostic?.('tracker_writeback_reconcile_error', {
                statePath: input.statePath,
                message: errorMessage(err),
            });
            return { posted: 0, failed: 0, skipped: 0, reason: 'error' };
        }
    }
    async attempt(item, post, key, statePath) {
        const meta = {
            key,
            statePath,
            connectionId: item.connectionId,
            externalId: item.externalId,
            provider: item.provider,
            postKind: post.postKind,
            relativePath: item.relativePath,
            at: this.deps.now().toISOString(),
        };
        try {
            if (post.type === 'comment') {
                await this.deps.poster.postComment({
                    provider: item.provider,
                    connectionId: item.connectionId,
                    externalId: item.externalId,
                    body: post.body,
                });
            }
            else {
                await this.deps.poster.transitionIssue({
                    provider: item.provider,
                    connectionId: item.connectionId,
                    externalId: item.externalId,
                    transitionId: post.transitionId,
                });
            }
        }
        catch (err) {
            // A post failure is isolated to this item+event: record the visible notice
            // and move on. Not marking it posted is what makes it retry next event.
            await this.deps.ledger
                .recordFailure({ ...meta, message: errorMessage(err) })
                .catch(() => undefined);
            return 'failed';
        }
        // The post succeeded. Recording it is best-effort and separate: a ledger
        // write failure must never turn a delivered post into a false failure notice
        // (at worst the post re-fires on a later event, which is idempotent upstream).
        await this.deps.ledger.markPosted(meta).catch(() => undefined);
        return 'posted';
    }
}
// The set of posts the run's observed state implies for one proxy item, ordered
// COMMENTS BEFORE TRANSITIONS within each event, and started → PR → completed
// across events. Each is independently gated by the config toggle, the observed
// fact, and the provider capability, so a provider that cannot comment or
// transition simply produces fewer posts (never a rejected call).
export function desiredPostsFor(facts, config, capabilities) {
    const canComment = capabilities?.canComment === true;
    const canTransition = capabilities?.canTransition === true;
    const posts = [];
    if (facts.started) {
        if (canComment && config.comments.started) {
            posts.push({ postKind: 'comment:started', type: 'comment', body: runStartedComment({ goal: facts.goal }) });
        }
        if (canTransition && config.transitions.onStart) {
            posts.push({ postKind: 'transition:onStart', type: 'transition', transitionId: config.transitions.onStart });
        }
    }
    if (facts.pullRequestUrls.length > 0 && canComment && config.comments.pr) {
        posts.push({
            postKind: 'comment:pr',
            type: 'comment',
            body: pullRequestComment({ goal: facts.goal, pullRequestUrls: facts.pullRequestUrls }),
            // Fold the sorted PR-URL set into the key so a multi-repo run's later PR
            // (a new set) posts its own comment instead of being deduped by the first
            // PR's key, while a redundant reconcile of the same set stays idempotent.
            keyDiscriminator: [...facts.pullRequestUrls].sort().join(','),
        });
    }
    if (facts.completed) {
        if (canComment && config.comments.done) {
            posts.push({
                postKind: 'comment:done',
                type: 'comment',
                body: runCompletedComment({
                    goal: facts.goal,
                    pullRequestUrls: facts.pullRequestUrls,
                    taskCount: facts.taskCount,
                }),
            });
        }
        if (canTransition && config.transitions.onComplete) {
            posts.push({ postKind: 'transition:onComplete', type: 'transition', transitionId: config.transitions.onComplete });
        }
    }
    return posts;
}
function errorMessage(err) {
    return err instanceof Error ? err.message : 'Unexpected write-back error.';
}
