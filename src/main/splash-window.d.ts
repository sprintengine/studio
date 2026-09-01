import { BrowserWindow } from 'electron';
import type { SplashProgress } from '../shared/electron-api';
export declare function createSplashWindow(): BrowserWindow;
export declare function sendSplashProgress(update: SplashProgress): void;
export declare function closeSplashWindow(): void;
export declare function isSplashOpen(): boolean;
