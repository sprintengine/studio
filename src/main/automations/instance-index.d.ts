import type { AutomationDefinition, AutomationsInstanceIndex } from '../../shared/automations/contracts';
import type { AutomationsStore } from './store';
export type AutomationsInstanceProjectFolder = {
    workspaceId: string;
    folderPath: string;
};
export type AutomationsInstanceIndexPorts = {
    projectFolders: AutomationsInstanceProjectFolder[];
    createStore: (workspaceRoot: string) => AutomationsStore;
    /**
     * Applied to every definition before it leaves the process — the IPC handler
     * passes the same webhook-secret redaction the single-project list channel
     * uses, so an enumerated definition never carries a secret. Absent ⇒ identity.
     */
    mapDefinition?: (definition: AutomationDefinition) => AutomationDefinition;
};
export declare function buildAutomationsInstanceIndex(ports: AutomationsInstanceIndexPorts): Promise<AutomationsInstanceIndex>;
