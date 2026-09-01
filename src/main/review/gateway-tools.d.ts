import { type McpToolRegistration } from '../../shared/modules/mcp-tools';
import { type BriefRunEvent } from './brief-run-service';
export interface ReviewGatewayBackends {
    /** Absolute folder paths of the projects currently open in the app. */
    listOpenProjectRoots: () => string[];
    /** The user's home directory, for the outgoing-payload leak guard. */
    homeDir: () => string;
    /**
     * Emit a BriefRunEvent on the review brief-run channel (broadcast to windows).
     * A submitted brief emits phase 'done' so an open Reviews door reloads it with
     * no app restart — the same event the companion path already emits.
     */
    emitBriefRunEvent: (event: BriefRunEvent) => void;
}
export declare function createReviewGatewayTools(backends: ReviewGatewayBackends): McpToolRegistration[];
