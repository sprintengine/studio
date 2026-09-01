// Instance-level review index (MC-1708). Reviews outlive the retired `review`
// workspace type: they are enumerated by scanning every known project root's
// `.multi-code/review/<reviewId>/` directory rather than derived from workspace
// rows. A single call across all roots produces the rail the Reviews surface
// (MC-1708 T6) renders — each entry carries the project, review id, change title,
// source kind, and the state-line inputs (walkthrough presence, steps, files
// read, pending/posted comment counts). Node/Electron-main only; the renderer
// reaches it through review IPC.
import { readFile, readdir } from 'fs/promises';
import { basename, join } from 'path';
import { validateReviewBrief, validateReviewChangeSet, validateReviewWorkspaceState, } from '../../shared/review';
const REVIEW_ROOT_SEGMENTS = ['.multi-code', 'review'];
// The review id is the on-disk directory name; it is minted to satisfy the same
// constraint changeset-service enforces, so a stray directory that does not match
// it (or a dotfile temp) is skipped rather than surfaced as a broken review.
const REVIEW_ID = /^[A-Za-z0-9._-]+$/;
// Enumerate every review under the given project roots. Roots are the caller's
// known project folders (the renderer passes its workspace folder paths); a root
// with no `.multi-code/review/` directory contributes nothing rather than
// erroring, and a review directory without a readable, valid change set is skipped
// — a directory is only a review once its change set has been ingested. Duplicate
// roots are de-duplicated so the same folder open in two workspaces is scanned
// once. The result is unsorted; the surface owns ordering.
export async function enumerateReviews(roots) {
    const uniqueRoots = [...new Set(roots.filter((root) => typeof root === 'string' && root.length > 0))];
    const entries = [];
    for (const root of uniqueRoots) {
        const reviewRoot = join(root, ...REVIEW_ROOT_SEGMENTS);
        let dirents;
        try {
            dirents = (await readdir(reviewRoot, { withFileTypes: true }))
                .filter((dirent) => dirent.isDirectory() && REVIEW_ID.test(dirent.name))
                .map((dirent) => dirent.name);
        }
        catch {
            // No reviews for this root (missing directory or unreadable) — not an error.
            continue;
        }
        for (const reviewId of dirents) {
            const entry = await readReviewEntry(root, reviewId);
            if (entry)
                entries.push(entry);
        }
    }
    return entries;
}
async function readReviewEntry(workspaceRoot, reviewId) {
    const reviewDir = join(workspaceRoot, ...REVIEW_ROOT_SEGMENTS, reviewId);
    const changeset = await readJsonValidated(join(reviewDir, 'changeset.json'), validateReviewChangeSet);
    if (!changeset)
        return null;
    const brief = await readJsonValidated(join(reviewDir, 'brief.json'), validateReviewBrief);
    const state = await readJsonValidated(join(reviewDir, 'state.json'), validateReviewWorkspaceState);
    const comments = state?.comments ?? [];
    return {
        reviewId,
        workspaceRoot,
        projectName: basename(workspaceRoot),
        title: changeset.title,
        sourceKind: changeset.source.kind,
        fetchedAt: changeset.fetchedAt,
        fileCount: changeset.stats.files,
        hasWalkthrough: brief !== null,
        stepCount: brief ? brief.steps.length : 0,
        readFileCount: state ? state.readFiles.length : 0,
        pendingComments: comments.filter((comment) => comment.sync.state !== 'posted').length,
        postedComments: comments.filter((comment) => comment.sync.state === 'posted').length,
    };
}
// Read + validate a review JSON file. A missing or unreadable file, malformed
// JSON, or a shape that fails validation all yield null — a single corrupt
// sidecar never breaks enumeration of the other reviews, and the index degrades
// to "no walkthrough / no state" rather than throwing.
async function readJsonValidated(filePath, validate) {
    let raw;
    try {
        raw = await readFile(filePath, 'utf-8');
    }
    catch {
        return null;
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        return null;
    }
    const validation = validate(parsed);
    return validation.ok ? validation.value : null;
}
