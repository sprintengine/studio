// Reviewer state persistence (MC-1708). The human's mutable review progress —
// files read, view mode, and line comments — used to live on the `review`
// workspace's `Workspace.reviewState` store field. Reviews are now instance-level
// objects that outlive the retired workspace type, so their state moves onto disk
// beside the change set and brief: `<reviewDir>/state.json`, written temp-then-
// rename exactly like changeset.ts/brief.ts. The review id keys the directory, so
// a review's state is reachable without any workspace. Node/Electron-main only;
// the renderer reaches it through review IPC (src/main/ipc/review-ipc.ts).
import { mkdir, readFile, rename, unlink, writeFile } from 'fs/promises';
import { randomUUID } from 'crypto';
import { join } from 'path';
import { validateReviewWorkspaceState } from '../../shared/review';
const STATE_FILE = 'state.json';
// Read the reviewer's persisted state for a review dir. A missing file is the
// honest "no progress yet" state (state: null); a present-but-invalid file comes
// back as an error so a corrupted state.json surfaces instead of silently
// resetting the reviewer's comments and read progress.
export async function readReviewState(reviewDir) {
    let raw;
    try {
        raw = await readFile(join(reviewDir, STATE_FILE), 'utf-8');
    }
    catch (error) {
        if (error?.code === 'ENOENT')
            return { ok: true, state: null };
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        return { ok: false, error: 'Stored review state is not valid JSON.' };
    }
    const validation = validateReviewWorkspaceState(parsed);
    if (!validation.ok)
        return { ok: false, error: `Stored review state is invalid: ${validation.errors[0]}` };
    return { ok: true, state: validation.value };
}
// Validate then atomically persist the reviewer's state. Validation happens before
// the write so an internally-inconsistent state never lands on disk; the write is
// temp-then-rename so a crash mid-write leaves the prior state.json (or nothing)
// intact rather than a truncated file.
export async function writeReviewState(reviewDir, state) {
    const validation = validateReviewWorkspaceState(state);
    if (!validation.ok) {
        throw new Error(`Refusing to persist an invalid review state: ${validation.errors[0]}`);
    }
    await mkdir(reviewDir, { recursive: true });
    const finalPath = join(reviewDir, STATE_FILE);
    const tempPath = join(reviewDir, `.${STATE_FILE}.${randomUUID()}.tmp`);
    const data = `${JSON.stringify(validation.value, null, 2)}\n`;
    try {
        await writeFile(tempPath, data, 'utf-8');
        await rename(tempPath, finalPath);
    }
    catch (error) {
        await unlink(tempPath).catch(() => { });
        throw error;
    }
}
