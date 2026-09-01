import { type ScanResult } from '../../shared/skills';
import { type SkillTreeEntry } from './scan';
/**
 * List a directory as tree entries the scan rule can read. Local files have no
 * git blob identity, so `blobSha` stays empty rather than carrying an invented
 * digest — nothing downstream compares a local skill by blob.
 */
export declare function listLocalTree(root: string): Promise<SkillTreeEntry[]>;
/**
 * Scan a directory of skills, reading each entry's frontmatter for the name and
 * description the surface lists. Local reads are cheap enough to do inline;
 * a repository defers the same enrichment behind the network.
 */
export declare function scanLocalSkillSource(root: string): Promise<ScanResult>;
