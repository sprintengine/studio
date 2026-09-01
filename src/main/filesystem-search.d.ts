import type { ContentSearchResult, FileSearchResult } from '../shared/electron-api';
export type FileSearchRequest = {
    rootPath: string;
    query: string;
    limit?: number;
    excludes?: string[];
};
export type ContentSearchRequest = FileSearchRequest;
export declare function cancelActiveContentSearch(senderId: number): void;
export declare function searchFiles(senderId: number, input: FileSearchRequest): Promise<FileSearchResult>;
export declare function searchContent(senderId: number, input: ContentSearchRequest): Promise<ContentSearchResult>;
