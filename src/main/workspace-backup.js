import { mkdir, readFile, rename, writeFile } from 'fs/promises';
import { join } from 'path';
const BACKUP_FILE_NAME = 'workspace-backup.json';
export class WorkspaceBackupService {
    deps;
    inFlightWrite = Promise.resolve();
    constructor(deps) {
        this.deps = deps;
    }
    get backupPath() {
        return join(this.deps.resolveUserDataDir(), BACKUP_FILE_NAME);
    }
    async write(payload) {
        let serialized;
        try {
            serialized = JSON.stringify(payload);
        }
        catch (error) {
            return {
                ok: false,
                message: error instanceof Error ? error.message : 'serialize_failed',
            };
        }
        // Serialize writes so a slower write cannot clobber a newer payload.
        const previous = this.inFlightWrite;
        let releaseCurrent = () => { };
        this.inFlightWrite = new Promise((resolve) => {
            releaseCurrent = resolve;
        });
        await previous;
        try {
            const path = this.backupPath;
            const dir = join(path, '..');
            await mkdir(dir, { recursive: true });
            const tmp = `${path}.tmp`;
            await writeFile(tmp, serialized, { mode: 0o600 });
            await rename(tmp, path);
            return { ok: true };
        }
        catch (error) {
            return {
                ok: false,
                message: error instanceof Error ? error.message : 'unknown_write_error',
            };
        }
        finally {
            releaseCurrent();
        }
    }
    async read() {
        let raw;
        try {
            raw = await readFile(this.backupPath, 'utf8');
        }
        catch (error) {
            const code = error?.code;
            if (code === 'ENOENT')
                return { ok: false, reason: 'missing' };
            return {
                ok: false,
                reason: 'unreadable',
                message: error instanceof Error ? error.message : 'unknown_read_error',
            };
        }
        try {
            const parsed = JSON.parse(raw);
            if (!parsed
                || typeof parsed !== 'object'
                || typeof parsed.version !== 'number'
                || typeof parsed.writtenAt !== 'string') {
                return { ok: false, reason: 'parse_error', message: 'malformed_payload' };
            }
            return { ok: true, payload: parsed };
        }
        catch (error) {
            return {
                ok: false,
                reason: 'parse_error',
                message: error instanceof Error ? error.message : 'unknown_parse_error',
            };
        }
    }
}
export function createWorkspaceBackupService(deps) {
    return new WorkspaceBackupService(deps);
}
