/**
 * How far a remote viewer's transport may fall behind before its output is
 * dropped in favour of a later replay.
 *
 * The pty never waits on a socket: a consumer on a slow link that cannot drain
 * loses bytes and is repainted from the retained scrollback, because the
 * alternative — queueing without bound — grows main's heap until the app dies,
 * and the alternative to THAT — waiting — stalls the pty and the local window
 * behind a stranger's link.
 */
export const TERMINAL_REMOTE_TRANSPORT_HIGH_WATER_BYTES = 512 * 1024;
/** Bytes buffered for one remote viewer before the oldest are dropped and it resyncs. */
export const TERMINAL_REMOTE_PENDING_LIMIT_BYTES = 256 * 1024;
