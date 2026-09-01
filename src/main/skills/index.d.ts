import { type SkillHarness } from '../../shared/skills';
import type { SkillAddSourceInput, SkillAddSourceResult, SkillInstallInput, SkillInstallOutcome, SkillPopularReposOutcome, SkillReadFileInput, SkillReadFileResult, SkillRemoveSourceInput, SkillRemoveSourceResult, SkillScanInput, SkillScanOutcome, SkillSearchInput, SkillSearchOutcome, SkillSourcesResult, SkillSyncSourceInput, SkillSyncSourceOutcome, SkillUninstallInput, SkillUninstallOutcome } from '../../shared/electron-api';
import { type SkillDiscoveryOptions } from './discover';
import { type SkillGithubOptions } from './github-tree';
import { type SkillSourceStore } from './source-store';
export type SkillsServiceDeps = {
    resolveToken: () => Promise<string>;
    /** Overridden in tests; production reads the packaged resource dirs. */
    builtinSkillsRoot?: () => string | null;
    connectorSkillsRoot?: () => string | null;
    listHarnesses?: () => Promise<SkillHarness[]>;
    /** Open project roots, used once to adopt the retired skill packs as sources. */
    listWorkspaceRoots?: () => string[];
    github?: SkillGithubOptions;
    discovery?: SkillDiscoveryOptions;
};
export type SkillsService = {
    listSources(): Promise<SkillSourcesResult>;
    addSource(input: SkillAddSourceInput): Promise<SkillAddSourceResult>;
    removeSource(input: SkillRemoveSourceInput): Promise<SkillRemoveSourceResult>;
    getScan(input: SkillScanInput): Promise<SkillScanOutcome>;
    readFile(input: SkillReadFileInput): Promise<SkillReadFileResult>;
    install(input: SkillInstallInput): Promise<SkillInstallOutcome>;
    uninstall(input: SkillUninstallInput): Promise<SkillUninstallOutcome>;
    syncSource(input: SkillSyncSourceInput): Promise<SkillSyncSourceOutcome>;
    search(input: SkillSearchInput): Promise<SkillSearchOutcome>;
    listPopularRepos(): Promise<SkillPopularReposOutcome>;
};
export declare function createSkillsService(userDataDir: string, deps: SkillsServiceDeps, store?: SkillSourceStore): SkillsService;
