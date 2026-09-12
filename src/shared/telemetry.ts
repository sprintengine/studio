/**
 * The product-telemetry contract: what SprintEngine is allowed to send, under
 * what name, and where the switches are.
 *
 * Shape of the thing: the MAIN process is the only sender. The renderer never
 * loads an analytics SDK and never holds the project key — it owns exactly one
 * value, the user's consent, which it pushes to main the same one-way way it
 * pushes background mode and window material. Everything measured is measured
 * where it actually happens (a launch, a run, a boot), which is main anyway.
 *
 * Nothing ships until a project key is configured. `DEFAULT_POSTHOG_PROJECT_KEY`
 * is empty on purpose: an unkeyed build records into a buffer that is never
 * flushed and never opens a socket, so a from-source build, a fork, and every
 * test run are silent without having to know this file exists.
 *
 * COLLECTION BOUNDARY — the whole of it, enforced by `sanitizeProperties` in
 * `src/main/telemetry/analytics-service.ts` rather than by reviewer memory:
 *
 *   Sent      product metadata and normalized measurements. Counts, durations,
 *             enum-ish identifiers we ship ourselves (a CLI id, a run outcome),
 *             platform, arch, app version.
 *   Never     prompt or agent text, file contents, file or folder PATHS,
 *             workspace/project/run names, repository or branch names, tokens,
 *             credentials, account identifiers, IP-identifying detail, or
 *             anything typed by the user.
 *
 * The path rule is the one that bites in practice — a workspace root or a state
 * path reads like harmless context right up until it carries a client's name in
 * a directory. A property whose string looks like a local filesystem path is
 * DROPPED, not redacted: a redacted path still reports that a path was there.
 */

/**
 * Every event this app may send. A union rather than free-form strings so the
 * set stays readable in one place and a typo fails the build instead of
 * quietly opening a new series in PostHog.
 *
 * `app.boot` is the install/active-machine counter — one per process start.
 * The rest answer "is the thing people installed the thing they use": agents
 * launched, sprints created, sprints finished and how.
 */
const TELEMETRY_EVENTS = [
  'app.boot',
  'agent.launched',
  'sprint.run.created',
  'sprint.run.finished',
] as const

export type TelemetryEventName = (typeof TELEMETRY_EVENTS)[number]

/**
 * Property values that survive the boundary. Anything else — an object, an
 * array, a function, a Date — is dropped rather than serialized, because the
 * moment a nested shape is allowed through, the review question stops being
 * "is this property safe" and becomes "is everything reachable from it safe".
 */
export type TelemetryPropertyValue = string | number | boolean

export type TelemetryProperties = Readonly<Record<string, TelemetryPropertyValue>>

/**
 * PostHog project key this build reports to. Empty ships nothing — see the
 * header. Set it here for a keyed build, or override per-process with
 * `SPRINTENGINE_POSTHOG_KEY` (which is also how you point a dev build at a
 * throwaway project without touching the source).
 */
export const DEFAULT_POSTHOG_PROJECT_KEY = ''

/** PostHog ingestion host. US cloud; EU builds set `SPRINTENGINE_POSTHOG_HOST`. */
export const DEFAULT_POSTHOG_HOST = 'https://us.i.posthog.com'

/**
 * The kill switch that does not need a window: `SPRINTENGINE_TELEMETRY_ENABLED=false`
 * in the environment stops collection for the process, above and before the
 * user's Settings toggle. Any other value (including unset) leaves the decision
 * to the toggle.
 */
export const TELEMETRY_ENABLED_ENV_VAR = 'SPRINTENGINE_TELEMETRY_ENABLED'
export const POSTHOG_PROJECT_KEY_ENV_VAR = 'SPRINTENGINE_POSTHOG_KEY'
export const POSTHOG_HOST_ENV_VAR = 'SPRINTENGINE_POSTHOG_HOST'
