export type JiraBodyConversion = {
    markdown: string;
    raw?: string;
};
export declare function jiraBodyToMarkdown(body: unknown): JiraBodyConversion;
export declare function jiraCommentBodyToMarkdown(body: unknown): string;
export declare function wikiMarkupToMarkdown(wiki: string): string;
export declare function adfToMarkdown(node: unknown): string;
