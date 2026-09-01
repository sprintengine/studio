import type { AgentCliAvailabilityMap, SkillHarness } from '../../shared/electron-api';
import type { PluginRegistryListEntry } from '../../shared/plugin-manifest';
export type ResolveInstalledSkillHarnessesDeps = {
    listEntries?: () => PluginRegistryListEntry[];
    detectAvailability?: () => Promise<AgentCliAvailabilityMap>;
};
export declare function resolveInstalledSkillHarnesses(deps?: ResolveInstalledSkillHarnessesDeps): Promise<SkillHarness[]>;
