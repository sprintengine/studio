import { WEBHOOK_TRIGGER_KIND, type AutomationTriggerPollEvent, type AutomationTriggerProvider, type WebhookTriggerConfig } from '../../../shared/automations/contracts';
export { WEBHOOK_TRIGGER_KIND };
export type { WebhookTriggerConfig };
export declare const WEBHOOK_SIGNATURE_HEADER = "x-multicode-signature";
export declare const WEBHOOK_DELIVERY_ID_HEADER = "x-multicode-delivery-id";
export declare const WEBHOOK_EVENT_TIME_HEADER = "x-multicode-event-time";
export declare const WEBHOOK_ROUTE_PREFIX = "/automations/webhooks/";
type WebhookTriggerValidationResult = {
    ok: true;
    value: WebhookTriggerConfig;
} | {
    ok: false;
    error: string;
};
export declare function createWebhookTriggerProvider(): AutomationTriggerProvider;
export declare function validateWebhookTriggerConfig(config: unknown): WebhookTriggerValidationResult;
export declare function activeWebhookTriggerConfig(config: unknown): WebhookTriggerConfig | null;
export declare function webhookEndpointPath(path: string): string;
export declare function createWebhookSignature(secret: string, rawBody: string | Buffer): string;
export declare function verifyWebhookSignature(input: {
    secret: string;
    rawBody: string | Buffer;
    signature: string | undefined;
}): boolean;
export declare function normalizeWebhookDeliveryId(value: unknown): string | null;
export declare function buildWebhookTriggerEvent(input: {
    config: WebhookTriggerConfig;
    deliveryId: string;
    rawPayload: Record<string, unknown>;
    occurredAt: string;
    receivedAt: string;
}): AutomationTriggerPollEvent;
export declare function webhookPayloadMatchesConfig(payload: Record<string, unknown>, config: WebhookTriggerConfig): boolean;
