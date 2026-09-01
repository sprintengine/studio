import type { MobileControlBacklogItemSnapshot, MobileControlBacklogWorkspaceSnapshot } from '../../../shared/mobile-control/protocol';
export declare function readMobileBacklogWorkspaceSnapshot(workspaceRoot: string, generatedAt: string): Promise<MobileControlBacklogWorkspaceSnapshot | null>;
export declare function readBacklogEpicChildren(workspaceRoot: string, slug: string | readonly string[]): Promise<MobileControlBacklogItemSnapshot[]>;
export interface BacklogStartChild {
    relativePath: string;
    absolutePath: string;
    status: MobileControlBacklogItemSnapshot['status'];
}
export interface BacklogStartContext {
    title: string;
    /** Absolute path of the item, handed to `handover --handover` as the run's root source. */
    absolutePath: string;
    relativePath: string;
    /** True when the item is an epic container, so a start means "work the whole epic". */
    isEpic: boolean;
    /** Active leaf children of the epic; empty for a leaf item or a childless epic. */
    children: BacklogStartChild[];
}
export declare function resolveBacklogStartContext(workspaceRoot: string, relativePath: string): Promise<BacklogStartContext>;
export declare function assertBacklogRelativePath(value: string): string;
