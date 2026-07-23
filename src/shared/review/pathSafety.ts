// Review artifacts (the guide's brief, the metadata a tool hands back) walk
// project-relative paths. An absolute home-directory path embedded anywhere in one
// means a machine-specific path — or a secret carried through one — leaked, so the
// value is rejected before it is persisted, rendered, or returned to an agent.
// Shared by the brief-run service and the review MCP tools so both enforce one
// copy. Node-free: the caller supplies the home directory (main passes
// os.homedir()), keeping this importable from the renderer/web build.
export function homePathLeak(value: unknown, home: string): string | null {
  if (!home) return null
  return JSON.stringify(value).includes(home)
    ? 'a review artifact contains an absolute home-directory path; paths must be project-relative.'
    : null
}
