// Which build of Studio this is, as the server reports it: in the MCP server
// info agents read, in the version a WSL install is keyed on, and (from the
// protocol phase) in the `welcome` a client reads, beside the build stamp.

export type AppIdentity = {
  /** The app's semver (`app.getVersion()` in the desktop; baked into a server bundle). */
  version(): string
}

export function createStaticAppIdentity(identity: { version: string }): AppIdentity {
  return { version: () => identity.version }
}
