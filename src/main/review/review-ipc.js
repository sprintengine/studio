// Review ingestion IPC. Registered by the `review` capability module (MC-1677),
// which owns the ReviewChangeSetService lifecycle and passes it in here. The
// renderer reaches these handlers only through the preload bridge
// (src/preload/api/review.ts) — never generic file IPC.
import { readFile } from 'fs/promises';
import { join } from 'path';
import { validateReviewBrief } from '../../shared/review';
import { reviewChangeSetDir } from './changeset-service';
import { enumerateReviews } from './review-index';
import { readReviewState, writeReviewState } from './review-state-store';
import { guideRunRegistry } from './guide-run-registry';
// Named import that also runs the module's side effect: registering the
// 'pull-request' source provider (MC-1678) so the service can ingest GitHub PR URLs
// (the local branch/patch providers register from within changeset-service itself),
// plus the PR-project matcher (MC-1787) the match-pr-project handler calls.
import { matchPrProjectRoots } from './providers/github-pr-provider';
import { defaultReviewSyncDeps, postReview, } from './providers/github-review-sync';
const BRIEF_FILE = 'brief.json';
// Read and validate the guide's brief for a workspace. A missing file is the
// honest "no walkthrough yet" state (brief: null); a present-but-invalid file
// comes back as an error so the panel shows a failure instead of a blank pane.
async function readBrief(targetDir) {
    let raw;
    try {
        raw = await readFile(join(targetDir, BRIEF_FILE), 'utf-8');
    }
    catch (error) {
        if (error?.code === 'ENOENT')
            return { ok: true, brief: null };
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch (error) {
        return { ok: false, error: `brief.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
    }
    const validation = validateReviewBrief(parsed);
    if (!validation.ok)
        return { ok: false, error: validation.errors.join('\n') };
    return { ok: true, brief: validation.value };
}
export function registerReviewIpc(ipcMain, { changeSetService, guideTerminals, isUserWindowSender, reviewSyncDeps, guideRuns }) {
    const guideRunState = guideRuns ?? guideRunRegistry;
    ipcMain.handle('review:detect-source', (_event, input) => {
        return changeSetService.detect(input);
    });
    ipcMain.handle('review:ingest-source', async (_event, input, target) => {
        try {
            const changeset = await changeSetService.ingest(input, reviewChangeSetDir(target.workspaceRoot, target.workspaceId));
            return { ok: true, changeset };
        }
        catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
    });
    ipcMain.handle('review:read-changeset', async (_event, target) => {
        try {
            return await changeSetService.read(reviewChangeSetDir(target.workspaceRoot, target.workspaceId));
        }
        catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
    });
    ipcMain.handle('review:read-brief', async (_event, target) => {
        try {
            return await readBrief(reviewChangeSetDir(target.workspaceRoot, target.workspaceId));
        }
        catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
    });
    // Reviewer state (MC-1708): the human's read progress, view mode, and comments,
    // persisted on disk beside the change set and keyed by review id — the store
    // round-trip the retired `review` workspace used to carry. Read returns
    // { state: null } before the reviewer has started; write validates then persists
    // atomically. Both resolve the same per-review-id directory the change set uses.
    ipcMain.handle('review:read-state', async (_event, target) => {
        try {
            return await readReviewState(reviewChangeSetDir(target.workspaceRoot, target.workspaceId));
        }
        catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
    });
    ipcMain.handle('review:write-state', async (_event, target, state) => {
        try {
            await writeReviewState(reviewChangeSetDir(target.workspaceRoot, target.workspaceId), state);
            return { ok: true };
        }
        catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
    });
    // Instance-level review index (MC-1708): enumerate every review across the given
    // project roots, independent of any workspace. The renderer passes its known
    // project folders; a root with no reviews contributes nothing. Powers the
    // Reviews surface rail (MC-1708 T6).
    ipcMain.handle('review:list', async (_event, roots) => {
        try {
            return { ok: true, reviews: await enumerateReviews(Array.isArray(roots) ? roots : []) };
        }
        catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
    });
    // Infer which open project a pasted PR URL belongs to (MC-1787), so the creation
    // form does not force an up-front project pick. `matches` is exactly the passed
    // roots whose git remote points at the same repository; zero matches is a valid,
    // non-error answer the form renders as "create without a project". The result
    // echoes only roots the caller supplied — no git remote URL or foreign path leaks.
    ipcMain.handle('review:match-pr-project', async (_event, url, roots) => {
        try {
            const matches = await matchPrProjectRoots(typeof url === 'string' ? url : '', Array.isArray(roots) ? roots : []);
            return { ok: true, matches };
        }
        catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
    });
    // Freshness probe (MC-1682): rebuild the current change set without persisting
    // it, so the panel can detect that the reviewed head moved and which steps that
    // affects, without disturbing the change set the current walkthrough walks.
    ipcMain.handle('review:probe-changeset', async (_event, input) => {
        try {
            return { ok: true, changeset: await changeSetService.build(input) };
        }
        catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
    });
    // Start the guide run for a review. The guide is a terminal agent under the
    // review's project, so this resolves once its terminal has the prompt — not
    // when the walkthrough exists. The brief lands later through
    // review_submit_brief, which announces itself on BRIEF_RUN_EVENT_TOPIC and
    // is what the panel re-reads on. One guide per review: a start against a live
    // run joins it (result carries `joined`) unless the caller asked for a restart.
    // `guide` names the terminal, so the caller can show and focus it.
    ipcMain.handle('review:start-brief-run', async (_event, input) => {
        const result = await guideTerminals.startRun({
            reviewId: input.workspaceId,
            projectRoot: input.workspaceRoot,
            ...(input.hostWorkspaceId ? { hostWorkspaceId: input.hostWorkspaceId } : {}),
            depth: input.depth,
            ...(input.affectedStepIds ? { affectedStepIds: input.affectedStepIds } : {}),
            ...(input.cli ? { cli: input.cli } : {}),
            ...(input.cliModel ? { cliModel: input.cliModel } : {}),
            ...(input.restart ? { restart: true } : {}),
        });
        if (!result.ok)
            return { ok: false, reason: 'guide-error', errors: [result.error] };
        if ('joined' in result)
            return { ok: true, joined: true, status: result.status, guide: result.guide };
        return { ok: true, guide: result.guide };
    });
    // Stop the guide: kill its terminal and close the run as stopped. Distinct
    // from a plain terminal kill so the run's record says who ended it.
    ipcMain.handle('review:stop-brief-run', (_event, target) => {
        guideTerminals.stop(target.workspaceId);
    });
    // The main process's record of a review's guide run (MC-1784). Run state lives
    // here rather than only in the renderer, so leaving the Reviews door and coming
    // back re-reads a live run's progress — or the reason the last one failed —
    // instead of falling back to "the guide has not run". Null = never run here.
    ipcMain.handle('review:brief-run-status', (_event, target) => guideRunState.status(target.workspaceId));
    // Ask-the-guide: send one question to the review's guide terminal, starting it
    // if none is live. The reviewer reads the answer in that terminal, so this
    // returns only whether the question was delivered and where it landed — a dead
    // engine surfaces as a visible error rather than a silent no-op. The guide
    // answers; it never creates or edits a comment.
    ipcMain.handle('review:ask-guide', async (_event, input) => {
        const result = await guideTerminals.ask({
            reviewId: input.workspaceId,
            projectRoot: input.workspaceRoot,
            ...(input.hostWorkspaceId ? { hostWorkspaceId: input.hostWorkspaceId } : {}),
            question: input.message,
            ...(input.cli ? { cli: input.cli } : {}),
            ...(input.cliModel ? { cliModel: input.cliModel } : {}),
        });
        return result.ok ? { ok: true, guide: result.guide } : { ok: false, error: result.error };
    });
    // Post the pending review to the pull request (MC-1683). This is the ONLY entry
    // point to the write path — there is no programmatic caller — and it is
    // human-outward, so it is gated to a real application window's gesture. The guide
    // runs in a terminal with no renderer, so it cannot reach an ipcMain handler at
    // all (nor could its companion predecessor); the sender gate is defence-in-depth,
    // refusing any invocation that does not resolve to an application window.
    ipcMain.handle('review:post-review', async (event, input) => {
        if (!isUserWindowSender || !isUserWindowSender(event)) {
            return { ok: false, error: 'Posting a review must be initiated from the review window.' };
        }
        try {
            const read = await changeSetService.read(reviewChangeSetDir(input.target.workspaceRoot, input.target.workspaceId));
            if (!read.ok)
                return { ok: false, error: read.error };
            if (!read.changeset)
                return { ok: false, error: 'There is no review to post yet.' };
            return await postReview(read.changeset, input.comments, reviewSyncDeps ?? defaultReviewSyncDeps());
        }
        catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
    });
}
