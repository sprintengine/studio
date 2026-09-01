import type { MarketplacePluginInstallInput, MarketplacePluginInstallResult } from '../../shared/electron-api';
import type { AutomationDefinition, AutomationsResult } from '../../shared/automations/contracts';
import { installPluginFolder as installCliPluginFolder } from '../plugin-install';
import { type McpConfigService } from '../mcp-config-service';
import { type ModuleTrustContext } from './module-signature';
import { installModuleFolder as installCapabilityModuleFolder } from './user-module-registry';
/**
 * Adds a catalogue entry's automation to a project — the automations app front
 * door (`installCatalogueDefinition`), which owns payload parsing, the install
 * defaults, the store-issued id, and the "already added" answer. Absent means
 * the Automations module is not running, which an automation component reports
 * rather than installing nothing and calling it success.
 */
export type MarketplaceAutomationInstaller = (input: {
    workspaceRoot: string;
    /** The bundle's automation payload, verbatim; the front door owns parsing it. */
    definition: unknown;
    sourceCatalogueId: string;
    sourcePublisher?: string;
}) => Promise<AutomationsResult<{
    definition: AutomationDefinition;
    alreadyAdded: boolean;
}>>;
export type MarketplacePluginInstallerServices = {
    trustContext: () => ModuleTrustContext;
    mcpConfigService: McpConfigService;
    moduleRoot?: () => string;
    pluginRoot?: () => string;
    installModuleFolder?: typeof installCapabilityModuleFolder;
    installPluginFolder?: typeof installCliPluginFolder;
    reloadPlugins?: () => void;
    installAutomationDefinition?: MarketplaceAutomationInstaller;
};
export declare function createMarketplacePluginInstaller(services: MarketplacePluginInstallerServices): (input: MarketplacePluginInstallInput) => Promise<MarketplacePluginInstallResult>;
export declare function installMarketplacePlugin(input: MarketplacePluginInstallInput, services: MarketplacePluginInstallerServices): Promise<MarketplacePluginInstallResult>;
