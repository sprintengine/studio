import { type ScanResult, type SkillSource } from '../../shared/skills';
/** The two sources every install has, which cannot be removed. */
export declare const ALWAYS_PRESENT_SKILL_SOURCES: readonly SkillSource[];
export declare function isRemovableSkillSource(id: string): boolean;
type PersistedState = {
    sources: SkillSource[];
    scans: Record<string, ScanResult>;
    /** True once the retired skill packs have been offered adoption — see adopt-legacy-packs.ts. */
    adoptedLegacyPacks: boolean;
};
export type SkillSourceStore = {
    listSources(): Promise<SkillSource[]>;
    getSource(id: string): Promise<SkillSource | null>;
    /** A null scan records the source without claiming to know what it holds. */
    putSource(source: SkillSource, scan: ScanResult | null): Promise<void>;
    removeSource(id: string): Promise<boolean>;
    getScan(id: string): Promise<ScanResult | null>;
    hasAdoptedLegacyPacks(): Promise<boolean>;
    markLegacyPacksAdopted(): Promise<void>;
};
export declare function createSkillSourceStore(userDataDir: string): SkillSourceStore;
/**
 * A malformed or partly-unreadable store degrades to "no user sources" rather
 * than throwing: the always-present sources still list, and re-adding a
 * repository is one paste.
 */
export declare function parseSkillSourceState(raw: string): PersistedState;
export {};
