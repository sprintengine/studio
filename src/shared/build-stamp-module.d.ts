// The stamp both bundles import. Generated per build by the
// `sprintengine-build-stamp` plugin in `electron.vite.config.ts`; there is no file
// on disk to point a resolver at, so the shape is declared here for main,
// preload and the renderer alike. Inline `import(...)` types keep this file a
// script, which is what lets it declare an ambient module at all.
declare module 'virtual:sprintengine-build-stamp' {
  export const buildStamp: import('./build-stamp').BuildStamp
}
