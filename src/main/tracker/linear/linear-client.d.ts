export declare const LINEAR_GRAPHQL_ENDPOINT = "https://api.linear.app/graphql";
export declare const LINEAR_REQUEST_TIMEOUT_MS = 20000;
export type LinearFetch = (url: string, init: RequestInit) => Promise<Response>;
export type PostLinearGraphQLArgs = {
    endpoint: string;
    apiKey: string;
    query: string;
    variables: Record<string, unknown>;
    fetchImpl: LinearFetch;
    timeoutMs: number;
    connectionId: string;
};
export declare function postLinearGraphQL<T>(args: PostLinearGraphQLArgs): Promise<T>;
