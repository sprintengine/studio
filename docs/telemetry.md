# Product usage data

SprintEngine Studio can send anonymous product usage events to PostHog. This
page is the whole of it: what goes out, what never does, how to turn it off, and
how to point a build at a project.

**Nothing is sent unless a PostHog project key is configured, and no key ships in
this repository.** A build from source, a fork, and every test run are silent
without opting out of anything.

## What is sent

Four events, listed in `src/shared/telemetry.ts`:

| Event | When | Carries |
| --- | --- | --- |
| `app.boot` | Once per process start | `firstRun` — true only on the launch that minted this install's id |
| `agent.launched` | An agent CLI starts, from any door | Resolved CLI id, permission preset, and flags for specialist / worktree / connector / whether a startup prompt was given |
| `sprint.run.created` | A sprint run is created | Staffed role count, source count, intake mode, and the worktree / task-isolation / start-runner flags |
| `sprint.run.finished` | A run reaches a terminal state | `outcome`: `complete` or `canceled` |

Every event also carries the platform, architecture, app version, and whether
this is a packaged build.

## What is never sent

Prompts and agent output, file contents, **file or folder paths**, workspace,
project, run, repository or branch names, tokens and credentials, account
identifiers, and anything else the user typed.

This is enforced in code, not by review habit. `sanitizeProperties` in
`src/main/telemetry/analytics-service.ts` accepts only strings, finite numbers
and booleans — no nested objects — caps string length, and **drops** any string
that looks like a local filesystem path. Dropped, not redacted: a property that
arrived as `[redacted-path]` would still report that a path had been there.

## Who you are

One random UUID per profile, minted on first send and kept in
`telemetry-install-id.json` under the app's userData directory.

That is the entire identity model. It is not derived from an account, a machine,
a hostname, a MAC address, or any file another vendor's CLI left on disk, and
PostHog person profiles are disabled (`$process_person_profile: false`). The
honest cost: one person using two computers counts as two, and a wiped profile
counts as new.

## Turning it off

Either of these stops collection; the environment variable outranks the setting.

- **Settings → General → Share anonymous usage data.** On by default. Turning it
  off is recorded under userData and survives restarts, including for runs that
  happen with no window open.
- **`SPRINTENGINE_TELEMETRY_ENABLED=false`** in the app's environment, for a
  machine or a fleet that wants it off regardless of what the UI says. Only the
  exact string `false` counts — a typo will not silently opt you out, and will
  not silently opt you in either.

## Configuring a project key

The key is empty in `src/shared/telemetry.ts`. Two ways to set one:

- **A keyed build** — set `DEFAULT_POSTHOG_PROJECT_KEY` in
  `src/shared/telemetry.ts` to the PostHog project's public API key (`phc_…`).
  This key is public by design; it can write events and read nothing.
- **Per process** — `SPRINTENGINE_POSTHOG_KEY=phc_…`, which is how to point a
  dev build at a throwaway project without touching the source.

`SPRINTENGINE_POSTHOG_HOST` overrides the ingestion host (default
`https://us.i.posthog.com`); set it to `https://eu.i.posthog.com` for EU cloud
or to a self-hosted instance.

## How it behaves

Main is the only process that sends anything — the renderer holds no key, loads
no analytics SDK, and has no channel for recording an event. Its only telemetry
surface is the one push that turns collection off.

Events buffer in memory and flush in batches of 20 every 30 seconds, plus once
on quit. A failed send is retried on the next flush; a 4xx that is not 429 is
treated as permanent and the batch is discarded rather than retried forever. The
buffer is capped at 500 events and drops the oldest on overflow. Delivery
failures write one diagnostic per process, never one per attempt.

## Reading the numbers

`app.boot` counts launches, not people — a user who restarts the app four times
in a morning is four boots and one install id. For "how many people are using
this", count distinct `distinct_id`; for "are they actually working in it", use
`agent.launched`, which only fires when an agent really started.

`sprint.run.created` and `sprint.run.finished` need not balance. A run that is
still going, one abandoned without being canceled, or one created before this
version shipped will never produce a finish.
