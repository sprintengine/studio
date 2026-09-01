export function createFakeIpcMain() {
    const handled = [];
    const handlers = new Map();
    const ipcMain = {
        handle(channel, handler) {
            handled.push(channel);
            handlers.set(channel, handler);
        },
        removeHandler(channel) {
            handlers.delete(channel);
        },
    };
    return {
        ipcMain,
        handled,
        async invoke(channel, ...args) {
            const handler = handlers.get(channel);
            if (!handler)
                throw new Error(`No handler for "${channel}".`);
            return handler({}, ...args);
        },
    };
}
