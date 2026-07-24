import {
  getRunDirectoryPath,
  getRunStateFilePath,
  slugifyRunName,
  type RunKind,
} from './runStateFile'

export type RunWorkspaceContext = {
  name: string
  slug: string
  directoryPath: string
  statePath: string
}

/**
 * Derive the workspace-creation context Sprint Engine uses:
 * slug + directory + state-file path under the run's project-relative root.
 * Domain-specific creation flows wrap this and attach their own state shape,
 * prompt builders, and registration logic.
 */
export function buildRunWorkspaceContext(input: {
  kind: RunKind
  rootPath: string
  name: string
}): RunWorkspaceContext {
  const trimmedRoot = input.rootPath.trim()
  const trimmedName = input.name.trim()
  const slug = slugifyRunName(input.kind, trimmedName)
  return {
    name: trimmedName,
    slug,
    directoryPath: getRunDirectoryPath(trimmedRoot, input.kind, slug),
    statePath: getRunStateFilePath(trimmedRoot, input.kind, slug),
  }
}

/**
 * Parser shape that domain-specific state files implement. The parser is
 * intentionally generic over the error payload so each domain can preserve
 * its own display-error type (title, path, schema location, etc.) instead of
 * collapsing to a flat string.
 */
export type RunStateParser<TState, TError extends { message: string } = { message: string }> =
  (raw: string) => { ok: true; state: TState } | { ok: false; error: TError }

/**
 * Thrown when a shared loader cannot parse the state-file content. The
 * caller's catch can recover the original typed error via `cause`, so
 * downstream surfaces still see the parser-specific title and path metadata.
 */
export class RunWorkspaceStateParseError<TError extends { message: string }> extends Error {
  readonly cause: TError
  constructor(error: TError) {
    super(error.message)
    this.name = 'RunWorkspaceStateParseError'
    this.cause = error
  }
}

/**
 * Shared loader: build the canonical run context, read the state file, and
 * run a domain-supplied parser. The parser is the only domain-specific input.
 * On parse failure the typed error is rethrown via RunWorkspaceStateParseError
 * so the caller can surface the original title/path; on read failure the
 * underlying IO error propagates unchanged.
 */
export async function loadRunWorkspaceState<TState, TError extends { message: string }>(input: {
  kind: RunKind
  rootPath: string
  name: string
  /** Optional overrides coming from a domain initializer. */
  statePathOverride?: string | null
  slugOverride?: string | null
  directoryOverride?: string | null
  displayNameOverride?: string | null
  readFile: (path: string) => Promise<string>
  parser: RunStateParser<TState, TError>
}): Promise<{ state: TState; context: RunWorkspaceContext; rawContent: string }> {
  const fallback = buildRunWorkspaceContext({
    kind: input.kind,
    rootPath: input.rootPath,
    name: input.name,
  })
  const context: RunWorkspaceContext = {
    name: input.displayNameOverride?.trim() || fallback.name,
    slug: input.slugOverride?.trim() || fallback.slug,
    directoryPath: input.directoryOverride?.trim() || fallback.directoryPath,
    statePath: input.statePathOverride?.trim() || fallback.statePath,
  }
  const rawContent = await input.readFile(context.statePath)
  const parsed = input.parser(rawContent)
  if (!parsed.ok) {
    throw new RunWorkspaceStateParseError<TError>(parsed.error)
  }
  return { state: parsed.state, context, rawContent }
}
