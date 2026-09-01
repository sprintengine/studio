export declare const MODULE_FOLDER_README = "# Multicode capability modules\n\nDrop a capability module here to have Multicode pick it up on next launch.\n\n## Layout\n\n```\n~/.multicode/modules/\n  <module-id>/\n    manifest.json   # required \u2014 id must equal this folder name\n    dist/main.cjs   # optional entry.main (CommonJS, main process)\n    dist/renderer.mjs # optional entry.renderer (ESM bundle, renderer)\n```\n\n## Getting started\n\nAuthor modules against the published SDK:\n\n```\nnpm install --save-dev @multicode/module-sdk\n```\n\nA `manifest.json` describes the module; `entry.main` / `entry.renderer`\nregister IPC, services, panels, workspace types, commands and settings through\nthe host APIs (`MainHost` / `RendererHost`). Validate, pack and sign with the\nbundled CLI:\n\n```\nnpx multicode-module pack ./my-module\nnpx multicode-module sign ./my-module --key ./signing.pem\n```\n\nInstalled modules are listed under **Settings \u2192 Modules**, where you review the\naccess each one requests and grant trust before its code runs. You can also\ninstall a module folder from there instead of copying it here by hand.\n";
export declare const PLUGIN_FOLDER_README = "# Multicode CLI plugins (BYO CLI)\n\nDrop a CLI plugin here to add a new agent CLI to Multicode. Plugins are picked\nup on next launch (or after **Refresh** / **Install CLI from folder** under\n**Settings \u2192 Agents**).\n\n## Layout\n\n```\n~/.multicode/plugins/\n  <plugin-id>/\n    plugin.json     # required \u2014 id must equal this folder name\n```\n\n## What a plugin describes\n\nA `plugin.json` tells Multicode how to launch and resume an agent CLI: its\n`binary`, the `launch` / `resume` argv templates, prompt injection, completion\ndetection, MCP config format, model selection and capabilities. See the\n`CliPluginManifest` type and `validateCliPluginManifest` validator published by\n`@multicode/module-sdk` for the authoring contract, and\n`docs/2026-05-16-plugin-manifests-worked-examples.md` for worked examples.\n\nA plugin id must match its containing folder name. A user plugin with the same\nid as a bundled CLI overrides the bundled one.\n";
export type EnsureExtensionFoldersOptions = {
    moduleRoot?: string;
    pluginRoot?: string;
};
export type EnsureExtensionFoldersResult = {
    moduleRoot: string;
    pluginRoot: string;
    errors: string[];
};
/**
 * Create the user module and plugin drop-in roots if absent and seed each with
 * a README describing the contract. Idempotent: existing folders are left in
 * place and an existing README is never overwritten (a user may have edited or
 * removed it). Returns the resolved roots and any non-fatal errors.
 */
export declare function ensureExtensionFolders(options?: EnsureExtensionFoldersOptions): EnsureExtensionFoldersResult;
