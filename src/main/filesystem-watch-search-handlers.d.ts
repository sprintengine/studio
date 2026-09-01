import { cancelActiveContentSearch, searchContent, searchFiles } from './filesystem-search';
import { isMissingPathError, pathExists } from './filesystem-workspace';
export declare function createFilesystemWatchSearchHandlers(): {
    pathExists: typeof pathExists;
    isMissingPathError: typeof isMissingPathError;
    searchFiles: typeof searchFiles;
    searchContent: typeof searchContent;
    cancelActiveContentSearch: typeof cancelActiveContentSearch;
};
