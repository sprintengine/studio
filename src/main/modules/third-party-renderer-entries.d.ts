import { type ThirdPartyRendererEntriesResult, type ThirdPartyRendererEntryView } from '../../shared/modules/manifest';
import type { MainHost } from '../module-host/main-host';
import { type ModuleTrustContext } from './module-signature';
import type { InstalledModule, UserModuleListResult } from './user-module-registry';
export declare function rendererEntryView(installed: InstalledModule): ThirdPartyRendererEntryView;
export declare function collectThirdPartyRendererEntries(modules: readonly InstalledModule[], trustContext?: ModuleTrustContext): Promise<ThirdPartyRendererEntriesResult>;
export declare function registerThirdPartyRendererEntryIpc(host: MainHost, options: {
    discoverModules: () => Promise<UserModuleListResult>;
    trustContext?: () => ModuleTrustContext;
}): void;
