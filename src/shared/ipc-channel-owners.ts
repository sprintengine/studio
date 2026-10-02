// The `window.api` channels the Studio server owns when it runs in a process
// of its own (phase 6 spec, 6.2). Out of process, the preload routes an invoke
// or send on one of these over the window's port; every other channel stays
// with the shell. In process everything goes to main, as it always has.
//
// A domain is listed whole when its registration moves into the server, and
// the completeness test (src/server/desktop/server-ipc.test.ts) holds this
// table and the server's registrations to each other in both directions. When
// phase 10 turns a domain's channels into typed protocol methods, its entries
// leave this table; the tunnel is done when the table is empty.
//
// `retry: 'once'` marks an idempotent read the preload sends again, once, on
// the next port when the server restarts under it.

export type ServerIpcChannel = { retry?: 'once' }

export const SERVER_IPC_CHANNELS: Readonly<Record<string, ServerIpcChannel>> = {}
