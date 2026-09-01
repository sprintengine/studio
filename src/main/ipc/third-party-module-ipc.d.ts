import { type IpcMain } from 'electron';
import type { ModuleEnablementOverrides, ThirdPartyModuleView } from '../../shared/modules/manifest';
import { type ThirdPartyMainLaunchSnapshot } from '../modules/third-party-main-loader';
import { type InstalledModule } from '../modules/user-module-registry';
export declare function registerThirdPartyModuleIpc(ipcMain: IpcMain): void;
export declare function toThirdPartyModuleView(module: InstalledModule, launchSnapshot?: ThirdPartyMainLaunchSnapshot, enablementOverrides?: ModuleEnablementOverrides): ThirdPartyModuleView;
