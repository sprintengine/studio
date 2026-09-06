import {
  SCHEDULE_TRIGGER_KIND,
  SPAWN_AGENT_ACTION_KIND,
  type AutomationStatus,
  type ScheduleTriggerConfig,
} from './contracts'

// The five automations that ship INSIDE the app (Extensions drawer ruling,
// 2026-09-05, frame 4). They are a cron line and a prompt — no code, no bytes to
// unpack, nothing to trust — so they are app content the Automations surface
// lists under "Built in", not marketplace entries a shelf installs.
//
// They live as a module rather than as files under `resources/` because a
// resources tree only reaches a packaged app through an `extraResources` entry
// in package.json, and would then need a dev-vs-packaged path resolver on top
// (`marketplaceResourceCandidates`, src/main/marketplace/resources.ts). A module
// is compiled into both bundles by both builds, so there is no path to resolve
// and no packaging step that can be forgotten.
//
// Shared, because the same five records answer three questions in two processes:
// what the rail lists, what the card states, and what the install writes.
//
// `id` is the STABLE identity and is deliberately the marketplace plugin id these
// were published under: a project's copy records it as `sourceCatalogueId`, so a
// project that added one from the old Plugins shelf is recognised as already
// having it and `installFromCatalogue` will not write a second copy.
//
// Generated from resources/marketplace/plugins/<id>/{plugin.json,automation/
// automation.json}; edit those and regenerate rather than drifting the two.

export type BuiltinAutomation = {
  /** The marker every built-in record carries; a project's own copy never has it. */
  builtin: true
  /** Stable id, and the `sourceCatalogueId` stamped on a project's copy. */
  id: string
  name: string
  publisher: string
  category: string
  /** The one paragraph the card leads with. */
  description: string
  status: AutomationStatus
  /**
   * Whether a run gets a worktree and branch of its own. Absent ⇒ true, the same
   * answer `AutomationDefinition` gives, so the built-in and the project's copy
   * of it are read by one rule. None of the five sets it; a built-in that ran in
   * the user's checkout would have no branch and so no pull request to deliver.
   */
  runInWorktree?: boolean
  trigger: { kind: string; config: ScheduleTriggerConfig }
  action: { kind: string; config: { prompt: string } }
}

export const BUILTIN_AUTOMATIONS: readonly BuiltinAutomation[] = [
  {
    builtin: true,
    id: 'dead-code-sweep-automation',
    name: 'Dead code sweep',
    publisher: 'Multicode Labs',
    category: 'Code Quality',
    description:
      'Deletes code nothing reaches, with the evidence for each removal. One agent run on a worktree of its own, opening a pull request that carries both the removals and the report naming what proved each one dead.',
    status: 'enabled',
    trigger: {
      kind: SCHEDULE_TRIGGER_KIND,
      config: {
        kind: SCHEDULE_TRIGGER_KIND,
        timezone: 'UTC',
        cadence: { type: 'daily', timeLocal: '02:00' },
      },
    },
    action: {
      kind: SPAWN_AGENT_ACTION_KIND,
      config: {
        prompt:
          "Find code in this repository that nothing reaches: unexported symbols with no references, files no import path leads to, feature flags whose branches are both dead, and dependencies nothing imports.\n\nVerify each candidate is genuinely unreachable before touching it — check dynamic imports, string-keyed lookups, reflection, and anything a build or test config names directly. Delete only what you can prove is dead.\n\nOpen a pull request listing each removal and the evidence for it.\n\nA symbol nothing outside its file imports is not dead if the file itself uses it — that is a redundant `export`, and the most it earns is dropping the keyword. Deleting one breaks the build, and this is the mistake a search for unreferenced exports will hand you dozens of, so do not treat that search as a list of dead code.\n\nThe pull request is built from what you leave in the working tree, so the listing has to be a file: write it to reports/dead-code-sweep-<today's date, YYYY-MM-DD>.md, one entry per removal naming the symbol or file, where it lived, and the evidence that proved it unreachable. Delete nothing you could not prove; if that is everything, write the file saying so and leave the code alone.",
      },
    },
  },
  {
    builtin: true,
    id: 'duplication-review-automation',
    name: 'Duplication review',
    publisher: 'Multicode Labs',
    category: 'Code Quality',
    description:
      'Writes up duplication worth abstracting and the case against it, and never refactors. One agent run on a worktree of its own, opening a pull request that contains the write-up and nothing else.',
    status: 'enabled',
    trigger: {
      kind: SCHEDULE_TRIGGER_KIND,
      config: {
        kind: SCHEDULE_TRIGGER_KIND,
        timezone: 'UTC',
        cadence: { type: 'daily', timeLocal: '02:30' },
      },
    },
    action: {
      kind: SPAWN_AGENT_ACTION_KIND,
      config: {
        prompt:
          "Find places where the same logic is written more than twice and an abstraction would genuinely pay for itself.\n\nDo not extract on similarity of shape alone — the duplicates must change together, for the same reason. Premature abstraction costs more than the duplication it removes.\n\nFor each candidate, write up the call sites, the abstraction you would introduce, and the argument against introducing it. Open a pull request containing the write-up only; do not refactor.\n\nWrite the write-up to reports/duplication-review-<today's date, YYYY-MM-DD>.md. That file is the only change this run may leave behind: no code edits, no test edits, no reformatting, no other files. If nothing you found earns an abstraction, say so in the file — a short honest report is the right output, and a manufactured one is worse than none.",
      },
    },
  },
  {
    builtin: true,
    id: 'unit-test-coverage-automation',
    name: 'Unit test coverage',
    publisher: 'Multicode Labs',
    category: 'Testing',
    description:
      'Writes unit tests for the weakest-covered, highest-cost paths, up to five files a run. One agent run on a worktree of its own, opening a pull request with the tests it added.',
    status: 'enabled',
    trigger: {
      kind: SCHEDULE_TRIGGER_KIND,
      config: {
        kind: SCHEDULE_TRIGGER_KIND,
        timezone: 'UTC',
        cadence: { type: 'daily', timeLocal: '03:00' },
      },
    },
    action: {
      kind: SPAWN_AGENT_ACTION_KIND,
      config: {
        prompt:
          "Find the code paths in this repository with the weakest test coverage and the highest cost of being wrong, and write unit tests for them.\n\nTest observable behaviour, not implementation detail. Do not change production code except where a test proves a bug — file that separately rather than fixing it here.\n\nOpen a pull request with the new tests.\n\nBound the run: cover at most five production files, chosen for the highest cost of being wrong, and leave the rest for tomorrow. Run every test you write and keep only the ones that pass against the code as it stands. Write reports/unit-test-coverage-<today's date, YYYY-MM-DD>.md naming what you covered, what you deliberately left for the next run, and any bug a test exposed — that file is where a bug gets filed, not the production code.",
      },
    },
  },
  {
    builtin: true,
    id: 'ui-ux-review-automation',
    name: 'UI & UX review',
    publisher: 'Multicode Labs',
    category: 'Design',
    description:
      'Reviews the interface against the design system from source only — it does not render the app. One agent run on a worktree of its own, opening a pull request with what it found.',
    status: 'enabled',
    trigger: {
      kind: SCHEDULE_TRIGGER_KIND,
      config: {
        kind: SCHEDULE_TRIGGER_KIND,
        timezone: 'UTC',
        cadence: { type: 'daily', timeLocal: '03:30' },
      },
    },
    action: {
      kind: SPAWN_AGENT_ACTION_KIND,
      config: {
        prompt:
          "Review the application interface against this project's own design system and brand guidance — whatever the repository actually carries: a token module, a theme file, a design-system folder, brand notes, a component library. Find it before you start; nothing is attached to this job. If the repository carries none, say so in your report and review the interface for internal consistency instead of against a standard you invented.\n\nScope yourself to what source can prove: token conformance, spacing off the scale, type sizes per view, hard-coded colours, missing keyboard paths, missing aria labels, and copy that explains instead of shows. You are not rendering the app — do not claim judgements about appearance you cannot support.\n\nOpen a pull request with the findings; fix only the mechanical ones.\n\nWrite the findings to reports/ui-ux-review-<today's date, YYYY-MM-DD>.md, and open that file by stating that this review read source and never rendered the app, so nothing in it describes how the interface actually looks. A mechanical fix is one where the design system gives exactly one correct value — a raw colour that has an exact token, a spacing value off the scale, a labelled control with no accessible name. Everything that needs judgement goes in the file, not in the diff.",
      },
    },
  },
  {
    builtin: true,
    id: 'merged-pr-seam-review-automation',
    name: 'Merged-PR seam review',
    publisher: 'Multicode Labs',
    category: 'Code Review',
    description:
      'Reviews the day’s merged pull requests together for the seams between them: duplicated concepts under different names, contradictory assumptions, interfaces one changed and another still consumes. One agent run on a worktree of its own, opening a pull request with the findings.',
    status: 'enabled',
    trigger: {
      kind: SCHEDULE_TRIGGER_KIND,
      config: {
        kind: SCHEDULE_TRIGGER_KIND,
        timezone: 'UTC',
        cadence: { type: 'daily', timeLocal: '18:00' },
      },
    },
    action: {
      kind: SPAWN_AGENT_ACTION_KIND,
      config: {
        prompt:
          "List the pull requests merged into the default branch in the last 24 hours. These were built independently and reviewed separately.\n\nReview them together for the seams between them: duplicated concepts introduced under different names, contradictory assumptions about shared state, interfaces one changed and another still consumes, and behaviour that is correct per-PR but wrong in combination.\n\nOpen a pull request with the findings; fix only what is unambiguous.\n\nRead the merged list with `gh pr list --state merged --limit 50 --json number,title,mergedAt,url`, and fall back to `git log --merges --since=\"24 hours ago\"` on the default branch when `gh` is missing or not authenticated. Write the findings to reports/merged-pr-seam-review-<today's date, YYYY-MM-DD>.md. If neither route can read the merge history, write that file saying exactly which one failed and how, and review nothing — substituting some other review and reporting it as this one is the failure this job exists to avoid. If the history reads and nothing merged in the window, say that instead.",
      },
    },
  },
]

export function builtinAutomationById(id: string): BuiltinAutomation | null {
  return BUILTIN_AUTOMATIONS.find((entry) => entry.id === id) ?? null
}

/**
 * The payload the install writes, which is exactly what a marketplace
 * `automation.json` carried: name, status, trigger, action, and nothing else.
 * The catalogue write path owns the rest — it drops `status`/`runInWorktree`,
 * resolves the schedule into the installing machine's zone, and stamps the
 * provenance — so this deliberately hands over no id and no defaults it would
 * freeze into a second source of truth.
 */
export function builtinAutomationPayload(entry: BuiltinAutomation): {
  name: string
  status: AutomationStatus
  trigger: { kind: string; config: ScheduleTriggerConfig }
  action: { kind: string; config: { prompt: string } }
} {
  return {
    name: entry.name,
    status: entry.status,
    trigger: entry.trigger,
    action: entry.action,
  }
}
