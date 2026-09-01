import { type ScanResult } from '../../shared/skills';
export declare const SKILL_MARKETPLACE_MANIFEST_PATH = ".claude-plugin/marketplace.json";
/** A `git/trees` entry, trimmed to the fields the scan actually reads. */
export type SkillTreeEntry = {
    path: string;
    mode: string;
    type: string;
    sha: string;
    size?: number;
};
export type SkillTreeScanInput = {
    entries: readonly SkillTreeEntry[];
    commitSha: string;
    /** Raw `.claude-plugin/marketplace.json` bytes, when the tree carries one. */
    marketplaceManifest?: string | null;
};
export declare function scanSkillTree(input: SkillTreeScanInput): ScanResult;
