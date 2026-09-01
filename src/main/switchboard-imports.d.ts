import type { SwitchboardImportItem, SwitchboardImportItemResult, SwitchboardImportProvider, SwitchboardImportResult, SwitchboardImportSummary } from '../shared/switchboard';
export declare function normalizeImportLabels(labels: unknown): string[];
export declare function normalizeSwitchboardImportItem(input: {
    provider: SwitchboardImportProvider;
    externalId?: unknown;
    externalKey?: unknown;
    externalUrl?: unknown;
    identifier?: unknown;
    title?: unknown;
    description?: unknown;
    labels?: unknown;
    priority?: unknown;
    updatedAt?: unknown;
}): SwitchboardImportItem;
export declare function summarizeImportItems(items: SwitchboardImportItemResult[]): SwitchboardImportSummary;
export declare function importSwitchboardItems(workspaceRoot: string, provider: SwitchboardImportProvider, items: SwitchboardImportItem[]): Promise<SwitchboardImportResult>;
