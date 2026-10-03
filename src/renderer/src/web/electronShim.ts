// What `electron` is in the web client's build (vite.web.config.ts swaps the
// module for this one). The preload's api modules are shared with the web
// tab; the one runtime member any of them imports from Electron is `webUtils`,
// for a dropped file's path, which a browser does not reveal.

export const webUtils = {
  getPathForFile: (): string => '',
}
