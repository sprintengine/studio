import { type SkillDiscoveryResult, type SkillRepoHit, type SkillSearchHit } from '../../shared/skills';
import type { SkillFetch } from './github-tree';
export type SkillDiscoveryOptions = {
    fetcher?: SkillFetch;
    timeoutMs?: number;
    cacheTtlMs?: number;
    /** Injected in tests so the cache window can be crossed without waiting. */
    now?: () => number;
};
export type SkillDiscoveryClient = {
    searchSkills(query: string, token: string): Promise<SkillDiscoveryResult<SkillSearchHit>>;
    listPopularSkillRepos(token: string): Promise<SkillDiscoveryResult<SkillRepoHit>>;
};
export declare function createSkillDiscoveryClient(options?: SkillDiscoveryOptions): SkillDiscoveryClient;
