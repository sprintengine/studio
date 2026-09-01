import { type IncomingHttpHeaders } from 'node:http';
import type { AutomationTriggerPollEvent } from '../../shared/automations/contracts';
import { AutomationsStore } from './store';
import type { AutomationsEngineProblem, AutomationsEngineTriggerEventDeliveryResult, AutomationsProjectFolder } from './engine';
export type AutomationWebhookReceiverOptions = {
    getProjectFolders: () => AutomationsProjectFolder[] | Promise<AutomationsProjectFolder[]>;
    createStore?: (workspaceRoot: string) => AutomationsStore;
    deliverTriggerEvent(input: {
        workspaceRoot: string;
        workspaceId?: string;
        automationId: string;
        event: AutomationTriggerPollEvent;
    }): Promise<AutomationsEngineTriggerEventDeliveryResult>;
    now?: () => number;
    host?: string;
    logDeliveryProblem?: (problem: AutomationsEngineProblem) => void;
};
export type AutomationWebhookDeliveryInput = {
    port: number;
    path: string;
    headers: IncomingHttpHeaders | Record<string, string | string[] | undefined>;
    rawBody: string | Buffer;
};
export type AutomationWebhookDeliveryResult = {
    ok: true;
    status: 'delivered' | 'duplicate' | 'ignored';
    fired: number;
    duplicates: number;
    ignored: number;
    inFlight: number;
    runIds: string[];
} | {
    ok: false;
    statusCode: number;
    code: string;
    message: string;
};
export type AutomationWebhookReceiverStatus = {
    state: 'running' | 'stopped';
    host: string;
    ports: number[];
    targetCount: number;
    error?: string;
};
export declare class AutomationWebhookReceiverRefreshError extends Error {
    constructor(message: string);
}
export declare class AutomationWebhookReceiver {
    private readonly getProjectFolders;
    private readonly createStore;
    private readonly deliverTriggerEvent;
    private readonly now;
    private readonly host;
    private readonly logDeliveryProblem;
    private readonly servers;
    private operationQueue;
    private mutationGeneration;
    private routes;
    private targetCount;
    private lastError;
    constructor(options: AutomationWebhookReceiverOptions);
    refresh(): Promise<AutomationWebhookReceiverStatus>;
    stop(): Promise<void>;
    status(): AutomationWebhookReceiverStatus;
    deliver(input: AutomationWebhookDeliveryInput): Promise<AutomationWebhookDeliveryResult>;
    private refreshLatest;
    private enqueueMutation;
    private isLatestMutation;
    private failClosed;
    private stopAllServers;
    private loadRoutes;
    private startServer;
    private stopServer;
    private handleHttpRequest;
}
export declare function createAutomationWebhookReceiver(options: AutomationWebhookReceiverOptions): AutomationWebhookReceiver;
