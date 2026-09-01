import type { IpcMain } from 'electron';
import type { GitHubTokenStore } from '../github-token-store';
export declare function registerGitHubReposIpc(ipcMain: IpcMain, githubTokenStore: GitHubTokenStore): void;
