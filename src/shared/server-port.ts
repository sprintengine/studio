// The channel main hands a window its port to the Studio server on, when the
// server runs in a process of its own: `{ clientId }`, with the port
// transferred. The preload keeps the port in its own world and routes the
// server's IPC channels over it (src/preload/ipc-router.ts).
export const SERVER_PORT_CHANNEL = 'studio-server:port'

/** The server is restarting: pending calls on server channels fail with this, and idempotent reads retry once. */
export const SERVER_UNAVAILABLE_ERROR = 'ServerUnavailable'
