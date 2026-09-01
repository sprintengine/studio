import { type SkillSource } from '../../shared/skills';
import type { SkillSourceStore } from './source-store';
/** The retired catalogue: the repository each pack came from, and what it installed as. */
export declare const LEGACY_SKILL_PACKS: readonly {
    repo: string;
    installedDirName: string;
}[];
export type AdoptLegacySkillPacksOptions = {
    store: SkillSourceStore;
    /** Workspace roots to look in — the projects this install has open. */
    workspaceRoots: readonly string[];
    /** Overridden in tests; production checks the real harness skill dirs. */
    isInstalled?: (workspaceRoot: string, dirName: string) => boolean;
};
/**
 * Adopt every legacy pack still installed somewhere, exactly once.
 *
 * An adopted source carries no scan: what the repository holds today is a
 * network read, and inventing one here would put skills on screen that nobody
 * verified are still there. The source lists as unread until Sync reads it,
 * which is the same state a source added while offline is in.
 */
export declare function adoptLegacySkillPackSources(options: AdoptLegacySkillPacksOptions): Promise<SkillSource[]>;
