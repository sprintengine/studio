import type { ChangeSetFile } from '../../shared/review';
export type PatchParseResult = {
    ok: true;
    files: ChangeSetFile[];
    stats: {
        files: number;
        additions: number;
        deletions: number;
    };
} | {
    ok: false;
    error: string;
};
export declare function parsePatch(text: string): PatchParseResult;
