import { ipcRenderer } from 'electron'
import type {
  ElectronApi,
  SkillAddSourceInput,
  SkillAddSourceResult,
  SkillInstallInput,
  SkillInstallOutcome,
  SkillReadFileInput,
  SkillReadFileResult,
  SkillRemoveSourceInput,
  SkillRemoveSourceResult,
  SkillScanInput,
  SkillScanOutcome,
  SkillSourcesResult,
} from '../../shared/electron-api'

export const skillsApi = {
  skillsListSources: (): Promise<SkillSourcesResult> => ipcRenderer.invoke('skills:list-sources'),
  skillsAddSource: (input: SkillAddSourceInput): Promise<SkillAddSourceResult> =>
    ipcRenderer.invoke('skills:add-source', input),
  skillsRemoveSource: (input: SkillRemoveSourceInput): Promise<SkillRemoveSourceResult> =>
    ipcRenderer.invoke('skills:remove-source', input),
  skillsGetScan: (input: SkillScanInput): Promise<SkillScanOutcome> =>
    ipcRenderer.invoke('skills:scan', input),
  skillsReadFile: (input: SkillReadFileInput): Promise<SkillReadFileResult> =>
    ipcRenderer.invoke('skills:read-file', input),
  skillsInstall: (input: SkillInstallInput): Promise<SkillInstallOutcome> =>
    ipcRenderer.invoke('skills:install', input),
} satisfies Pick<
  ElectronApi,
  | 'skillsListSources'
  | 'skillsAddSource'
  | 'skillsRemoveSource'
  | 'skillsGetScan'
  | 'skillsReadFile'
  | 'skillsInstall'
>
