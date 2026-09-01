export declare const AUTOMATION_SETTINGS_FILENAME = "automation-settings.json";
export type AutomationSettings = {
    enabled: boolean;
};
export type AutomationSettingsReadResult = {
    settings: AutomationSettings;
    /** Set when the file existed but could not be parsed; the gateway still defaults on. */
    error: string | null;
};
export declare function readAutomationSettings(userDataDir: string): AutomationSettingsReadResult;
export declare function writeAutomationSettings(userDataDir: string, settings: AutomationSettings): void;
