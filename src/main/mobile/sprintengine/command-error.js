export class MobileSprintEngineCommandError extends Error {
    code;
    retryable;
    constructor(code, message, retryable) {
        super(message);
        this.code = code;
        this.retryable = retryable;
    }
}
export function getMobileSprintEngineCommandErrorMessage(error) {
    if (error instanceof MobileSprintEngineCommandError)
        return error.message;
    return error instanceof Error ? error.message : String(error);
}
