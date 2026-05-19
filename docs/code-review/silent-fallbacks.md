# Silent-Fallback Policy

Source: `.multi-code/sprintengine/2026-05-17-code-quality-srp-and-fallback-remediation/handover.md` (Section A5 — Silent-fallback elimination policy).

This document is the project-wide checklist for code review. It defines where a `catch` block is allowed to absorb an error and where it is not. The rules below apply equally to TypeScript, Python, and any shell helpers that report up to product surfaces.

## Why this policy exists

`catch (error) { return []; }`, `?? []`, and similar swallow-and-continue patterns at the wrong layer make a real failure indistinguishable from a real empty result. When the swallow happens at an IPC, filesystem, network, git, or CLI boundary, downstream code keeps going against state it cannot trust. Two of the failure modes the audit found:

- `SprintEngineAutoRunSupervisor.tsx` swallowed terminal-list IPC failures and treated them as "no sessions running," which could cause duplicate agents to spawn against terminals that were actually alive.
- `?? null` / `?? 0` defaults inside business logic made it impossible to tell whether a value was genuinely absent or had failed to load.

The pattern is not always a bug, but it is always a *risk* — the fix is to put the catch at the layer that can do something meaningful about the error.

## Three layers, three rules

### 1. Boundary catches must escalate

A boundary is any code that crosses a process, machine, disk, or shell line: IPC calls, file system reads/writes, network requests, `child_process` calls, git/gh shell-outs, database queries, terminal pipes, CLI subprocesses.

At a boundary, a `catch` block must do **one** of:

1. Return a structured failure to the caller — for example, `Result<T, BoundaryError>`, a tagged union `{ ok: false, error }`, or `null` only when the type system forces the caller to handle it.
2. Log at `error` level (with workspace, intent, and cause) and rethrow so the calling cycle can decide what to do — pause, retry, or surface the failure.
3. Throw a typed error class (for example `TerminalListIpcError`) that the caller can `instanceof`-match against.

A boundary catch that returns `[]`, `{}`, `''`, `null`, `0`, or `false` and lets the caller keep working is a defect. The caller cannot tell the difference between "no rows" and "the call failed," and any decision it makes based on that emptiness will be wrong half the time.

#### Pattern to avoid

```ts
async function listSessions(): Promise<Session[]> {
  try {
    return await window.api.terminalList()
  } catch (error) {
    logPerfEvent('list-error', { error })
    return []
  }
}

// caller:
const sessions = await listSessions()
if (sessions.length === 0) spawnAgent()   // spawns even when IPC failed
```

#### Pattern to use

```ts
class TerminalListIpcError extends Error { /* ... */ }

async function listSessions(): Promise<Session[]> {
  try {
    return await window.api.terminalList()
  } catch (error) {
    throw new TerminalListIpcError({ cause: error })
  }
}

// caller:
try {
  const sessions = await listSessions()
  if (sessions.length === 0) spawnAgent()
} catch (error) {
  if (error instanceof TerminalListIpcError) {
    await publishDiagnostic({ /* operator-visible notice */ })
    return                                  // skip the cycle, do not spawn
  }
  throw error
}
```

### 2. Domain catches must classify

A domain catch is anywhere inside business logic — selection, projection, prompt assembly, gate decisions, normalization, etc.

A domain `catch` block must:

- Identify the specific exception class or condition it handles.
- Let everything else propagate.
- Never coerce an error into an empty value just to keep the function returning something.

`catch (e) { return null }` and `catch (e) { return [] }` are banned in domain code. If a domain operation can fail recoverably, it must return a value that says "this failed because X" (a tagged union, a discriminated result), not an empty success.

The exception: when wrapping a sub-operation specifically to swallow a known, harmless failure (for example, a best-effort cache write), the catch must name what it is suppressing in a one-line comment and log at `warn` level.

### 3. Render-boundary defaults are fine — but the fix is upstream

`?? []`, `?? {}`, `?? ''`, `?? 0`, and `?? false` are legitimate at the **render boundary** — JSX templates, prop fallbacks for an optional input, formatting helpers. They defend the renderer against a momentarily undefined upstream value during state transitions.

But: if a value is *expected* to arrive defined and is arriving `undefined`, the bug is upstream, not at the JSX. The default is a guard against a transient state, not a fix for missing data. When a render-boundary default hides a real failure, escalate the fix to the upstream catch/selector.

#### Acceptable

```tsx
<TaskList tasks={tasks ?? []} />        // tasks is optional during initial load
<Banner label={label ?? 'Untitled'} />  // label can be unset by user input
```

#### Not acceptable — defaulting at the render boundary masks a failed selector

```tsx
const tasks = useTasksThatSometimesFails()
return <TaskList tasks={tasks ?? []} />   // if selector failed, list reads as empty
```

The fix is in `useTasksThatSometimesFails`: it must distinguish "loading," "empty," and "unavailable," and the renderer must show each state explicitly. See the Soul's "Fallback Discipline" — empty is not unavailable.

## Empty vs. unavailable

A list of zero items and a failed dependency are not the same state. The supervisor case is the canonical example:

| State | Meaning | UI/operator action |
|---|---|---|
| `sessions.length === 0` after a successful IPC call | No terminals are running. | Spawn the next ready agent. |
| `listSessions()` threw | We cannot tell what is running. | Pause auto-run, surface a notice, retry next tick. |

If a code path treats the second case like the first, it is a silent fallback and a defect.

## Code-review checklist

When reviewing a PR that touches a boundary or any place that catches:

1. **Is this catch at a boundary?** If yes, does it rethrow, return a structured failure, or throw a typed error?
2. **Does the catch return an empty primitive (`[]`, `{}`, `''`, `null`, `0`, `false`)?** If yes, what does the caller do with that emptiness? If the caller cannot tell "empty" from "failed," the catch is wrong.
3. **Is the caller blind to the failure?** If a boundary failure produces no operator-visible signal (diagnostic, banner, error state, log at `error` level), the failure will surprise someone in production.
4. **Does the surrounding domain handle "unavailable" as a separate state from "empty"?** The UI must distinguish them in copy, status, and the action it offers.
5. **Is the policy followed for new code?** New `?? []` / `?? null` should not appear in boundary or domain code — only at the render boundary.

## Enforcement

This document is the contract. The build does not lint silent fallbacks yet; reviewers enforce it manually. When the audit's count of `?? []` / `?? null` patterns drops far enough that a lint becomes practical, codify the rule in `scripts/lint-*.mjs` and reference this doc from the rule.

## Worked example: Sprint Engine auto-run terminal-list IPC

Before:

```ts
async function listTerminalSessionsForAutoRun(workspace, cause) {
  try {
    return await withTimeout(window.api.terminalList(), TERMINAL_IPC_TIMEOUT_MS, '…')
  } catch (error) {
    logPerfEvent('SprintEngineAutoRun', 'terminal-list-error', { /* … */ })
    return []                                              // silent fallback
  }
}

// caller:
const runningAgentIds = await getRunningAutoRunAgentIds(workspace, state)
//                                                                       ^ wrong on IPC failure
// supervisor proceeds to spawn, possibly duplicating live agents
```

After:

```ts
class TerminalListIpcError extends Error {
  readonly cause: unknown
  readonly workspaceId: string
  readonly workspaceName: string
  readonly intent: string
  constructor(input: { workspaceId: string; workspaceName: string; intent: string; cause: unknown }) { /* … */ }
}

async function listTerminalSessionsForAutoRun(workspace, cause) {
  try {
    return await withTimeout(window.api.terminalList(), TERMINAL_IPC_TIMEOUT_MS, '…')
  } catch (error) {
    throw new TerminalListIpcError({                       // boundary escalates
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      intent: cause,
      cause: error,
    })
  }
}

// caller (in the supervisor cycle):
try {
  const runningAgentIds = await getRunningAutoRunAgentIds(workspace, state)
  // … spawn decisions only run when the listing succeeded …
} catch (error) {
  if (error instanceof TerminalListIpcError) {
    await publishDiagnostic({                              // operator-visible notice
      level: 'warning',
      source: 'sprintengine',
      title: 'Auto-run paused: terminal IPC unavailable',
      message: '…',
    })
    return                                                 // skip the cycle, do not spawn
  }
  throw error
}
```

The behavior change is that the operator now sees the failure; the auto-run cycle skips the affected tick instead of spawning against unknown state. The auto-approval-only path still functions when there is no eligible terminal-write to make, because the per-artifact `try/catch` already classifies terminal-write failures and converts them into artifact-level warnings.
