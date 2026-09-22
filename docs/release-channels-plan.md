# Release channels: gated nightlies, promoted stables

Design, 2026-09-22. Status: in progress.

## Decision

A merge to `main` no longer publishes a desktop release. Main feeds a
**nightly** train that is cut on a schedule when there is something new to
ship, and **stable** is a manual promotion of the exact commit the latest
nightly shipped. An installed app follows the channel its own version names,
and a person can switch channels in Settings.

Why: a per-merge stable gives every merge, including a refactor of a settings
store, to every user within the hour, with no soak and one release per merge.
Nightly-then-promote costs one click per stable release and buys a soak period,
one version per batch of merges, and the ability to hold a release while
something is checked. The machinery for it already existed here as the
switched-off `preview` train; this change turns it on under the right name and
turns the per-merge stable off.

## Channels

| Channel | How it is cut | Version | GitHub release | Updater manifests | Who follows it |
|---|---|---|---|---|---|
| nightly | Scheduled every 30 minutes; publishes only when both gates pass (below). Also `workflow_dispatch channel=nightly` from `main`. | `X.Y.Z-nightly.YYYYMMDD.RUN`, where `X.Y.Z` is the version the next stable would take | prerelease, never latest | `nightly*.yml` | installs whose version carries `-nightly.`, and stable installs whose person chose nightly |
| stable | `workflow_dispatch channel=stable` from `main`, which builds the commit of the latest published nightly; or a pushed `vX.Y.Z` tag, which builds exactly that commit (the hotfix route) | `X.Y.Z` | release, marked latest | `latest*.yml` | every other install |

There is no third train. The old `preview` name goes: nothing shipped on it
while its schedule was off, so no install follows `preview*.yml`.

## Nightly gates

Both must hold for a scheduled run to publish; a dispatch skips them.

1. At least six hours since the last published nightly.
2. `main` has commits since the commit that nightly shipped (compare the
   nightly tag's commit against `main`'s head; the status must be "ahead").

The gate is a pure function in `scripts/release/nightly-gate.mjs` with node:test
coverage, given the release list, the comparison and a clock. Nightly runs
share one concurrency group that never cancels and keeps every queued run, so
two scheduled ticks cannot build the same commit or publish out of order.
Stable runs have their own group so a nightly never blocks a promotion.

## Versioning

The nightly's base version is what `scripts/release/main-release.mjs` already
computes for a stable: the strongest Conventional Commit since the last stable
tag applied to that tag's version. So `feat` merged during the day shows up as
`0.5.0-nightly.…` at once, and promotion needs no recomputation: the stable is
the nightly's base version unless the `version` input overrides it (a bigger
bump than the commits declared). A version a tag already holds is never reused.
No version-bump commit is pushed to `main`.

## Promotion

`workflow_dispatch channel=stable` resolves the newest published nightly,
takes its commit, refuses unless that commit is on `main`, builds it, and
creates the `vX.Y.Z` tag on it when the GitHub release publishes. Merges to
`main` while a maintainer verifies a nightly never reach the stable build.
Stable and nightly dispatches must be run from `main`; the dispatch default
channel is `nightly` so an omitted choice cannot publish a stable.

## In the app

- **Channel resolution at startup.** `-nightly.` in the running version means
  nightly, otherwise stable, unless a saved choice exists. The rule is one pure
  function with tests.
- **Saved choice.** A small main-owned store under userData
  (`update-channel.json`, following `background-mode-store.ts`), never a key in
  the renderer's `appSettings`. Get and set over IPC; set re-points the updater
  and triggers a check.
- **Updater.** `autoUpdater.channel` is the resolved channel;
  `allowPrerelease` is true only for nightly; `allowDowngrade` is set when a
  nightly install switches to stable, so the next stable is offered even though
  its version sorts lower.
- **Settings.** In the updates section, a two-option control (Stable, Nightly)
  with one sentence each, built from existing ui primitives and `--sem-*`
  tokens. The update state names the channel it checked.

## Out of scope

- A separate maintainer test train that publishes with no update feed. If it
  is wanted later it is one more channel name in the same workflow.
- Changing CI, the main ruleset or the Conventional PR title check. Merges
  still need a conventional title because the version is still derived from it.

## Rollout

Nothing changes for installed stable users until the first promotion. The
`PREVIEW_SCHEDULE` repository variable is no longer read and can be deleted.
Secrets are unchanged. The first scheduled run after merge cuts the first
nightly.
