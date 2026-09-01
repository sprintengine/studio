export type { LayoutTemplateInstallResult, UserLayoutTemplateListResult } from '../shared/layouts/template-manifest';
export declare function defaultUserLayoutTemplateRoot(): string;
export declare function resolveTemplateFiles(srcDir: string): Promise<string[]>;
export declare function installLayoutTemplateFolder(srcDir: string, root: string): Promise<import('../shared/layouts/template-manifest').LayoutTemplateInstallResult>;
export declare function loadUserLayoutTemplates(root: string): Promise<import('../shared/layouts/template-manifest').UserLayoutTemplateListResult>;
