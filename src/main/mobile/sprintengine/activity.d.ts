import type { MobileSprintEngineCommandAuditEntry } from './command';
import type { MobileControlSnapshot } from './snapshot';
declare const mobileControlProtocolVersion: 2;
export type MobileNotificationCategory = 'artifact.ready' | 'task.needs_input' | 'command.failed' | 'desktop.offline' | 'sprintengine.complete';
type MobileNotificationTarget = {
    kind: 'artifact';
    sprintEngineId: string;
    artifactId: string;
} | {
    kind: 'task';
    sprintEngineId: string;
    taskId: string;
} | {
    kind: 'sprintengine';
    sprintEngineId: string;
} | {
    kind: 'command';
    commandId: string;
    sprintEngineId?: string;
} | {
    kind: 'desktop';
};
export type MobileNotificationEvent = {
    protocolVersion: typeof mobileControlProtocolVersion;
    eventId: string;
    type: 'notification.created';
    emittedAt: string;
    payload: {
        category: MobileNotificationCategory;
        sprintEngineId?: string;
        title: string;
        body: string;
        severity: 'info' | 'warning' | 'error';
        deepLink: string;
        target: MobileNotificationTarget;
    };
};
export type MobileNotificationDelivery = {
    deviceId: string;
    registrationId: string;
    event: MobileNotificationEvent;
};
export type MobilePushRegistrationTarget = {
    deviceId: string;
    registrationId: string;
    revokedAt?: string;
};
type MobileSprintEngineActivityPublisherOptions = {
    now?: () => Date;
    getPushTargets: () => readonly MobilePushRegistrationTarget[];
    publish: (delivery: MobileNotificationDelivery) => void;
};
export declare class MobileSprintEngineActivityPublisher {
    private previousSnapshot;
    private previousDesktopOffline;
    private readonly now;
    private readonly getPushTargets;
    private readonly publishDelivery;
    constructor(options: MobileSprintEngineActivityPublisherOptions);
    publishSnapshotActivity(snapshot: MobileControlSnapshot): MobileNotificationDelivery[];
    publishCommandAudit(entry: MobileSprintEngineCommandAuditEntry): MobileNotificationDelivery[];
    publishDesktopPresence(online: boolean): MobileNotificationDelivery[];
    private eventsForSprintEngineTransition;
    private artifactReadyEvent;
    private taskNeedsInputEvent;
    private sprintEngineCompleteEvent;
    private notification;
    private deliver;
}
export declare function pushTokenHash(token: string): string;
export {};
