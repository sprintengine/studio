// Discover: searching GitHub for skills rather than repositories.
//
// Two queries, and they answer different questions. `/search/code` filtered to
// `filename:SKILL.md` finds skills that *do* a thing, because it matches inside
// the skill document — including skills vendored in repos that are not skill
// collections. `/search/repositories` finds repos that *mention* a thing, which
// is why it is the browse tab and not the search tab.
//
// Code search is asked for `application/vnd.github.text-match+json`, so a hit
// comes back with the fragment it matched. For a SKILL.md that fragment is the
// frontmatter, which is where a row's name and description come from — there is
// no second fetch per row, and at 10 code searches a minute there could not be.
//
// Nothing here derives a skill count. A count needs the repository scanned, and
// the scan is the existing add-a-source path a chosen candidate hands off to.
import { MIN_SKILL_SEARCH_QUERY_LENGTH, parseSkillFragment, SKILL_ENTRY_FILE, } from '../../shared/skills';
/** Verified 2026-07-28: code search 10/min and authenticated only; repo search 30/min authenticated, 10 anonymous. */
const GITHUB_API_ORIGIN = 'https://api.github.com';
const SEARCH_PAGE_SIZE = 30;
const DEFAULT_DISCOVER_TIMEOUT_MS = 15_000;
const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_CACHE_ENTRIES = 32;
/** The topics skill repositories actually carry, measured on 2026-07-28. */
const SKILL_REPO_TOPICS = ['claude-skills', 'agent-skills'];
const MARKETPLACE_MANIFEST_QUERY = 'filename:marketplace.json path:.claude-plugin';
const NEEDS_TOKEN_MESSAGE = 'Searching inside skill files needs a GitHub access token. Add one in Settings under GitHub.';
export function createSkillDiscoveryClient(options = {}) {
    const now = options.now ?? Date.now;
    const ttlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    const cache = new Map();
    function cached(key) {
        const entry = cache.get(key);
        if (!entry)
            return null;
        if (now() - entry.at >= ttlMs) {
            cache.delete(key);
            return null;
        }
        return entry.value;
    }
    /**
     * Only conditions that will still hold on the next keystroke are cached. A
     * rate-limited answer is not: its window reopens in under a minute, and a
     * cached one would keep saying no long after GitHub started saying yes.
     */
    function remember(key, value) {
        if (value.degraded?.reason === 'rate_limited' || value.degraded?.reason === 'unavailable')
            return value;
        if (cache.size >= MAX_CACHE_ENTRIES) {
            const oldest = cache.keys().next();
            if (!oldest.done)
                cache.delete(oldest.value);
        }
        cache.set(key, { at: now(), value });
        return value;
    }
    const request = (url, token, accept) => fetchSearch(url, token, accept, options);
    return {
        async searchSkills(query, token) {
            const terms = query.trim().replace(/\s+/g, ' ');
            if (terms.length < MIN_SKILL_SEARCH_QUERY_LENGTH) {
                return {
                    results: [],
                    rateLimit: null,
                    degraded: condition('query_too_short', `Type at least ${MIN_SKILL_SEARCH_QUERY_LENGTH} characters to search skills.`),
                };
            }
            // GitHub requires authentication for code search, so an anonymous call
            // would spend a request to be told the same thing.
            if (!token) {
                return { results: [], rateLimit: null, degraded: condition('needs_token', NEEDS_TOKEN_MESSAGE) };
            }
            const key = cacheKey('code', token, terms);
            const hit = cached(key);
            if (hit)
                return hit;
            const response = await request(searchUrl('code', `${terms} filename:${SKILL_ENTRY_FILE}`), token, 'application/vnd.github.text-match+json');
            if (!response.ok) {
                return { results: [], rateLimit: response.rateLimit, degraded: response.condition };
            }
            return remember(key, {
                results: response.items.map(toSearchHit).filter(isPresent),
                rateLimit: response.rateLimit,
                degraded: response.condition,
            });
        },
        /**
         * The browse tab. Stars lead it because that is the only ordering GitHub
         * offers — there is no trending API — but a manifest is the better signal,
         * so repositories carrying `.claude-plugin/marketplace.json` come first.
         */
        async listPopularSkillRepos(token) {
            const key = cacheKey('repos', token, '');
            const hit = cached(key);
            if (hit)
                return hit;
            const byStars = await Promise.all(SKILL_REPO_TOPICS.map((topic) => request(searchUrl('repositories', `topic:${topic}`, { sort: 'stars', order: 'desc' }), token, 'application/vnd.github+json')));
            // Finding the curated repositories means code search, which needs a
            // token. Without one the starred list still stands on its own.
            const curated = token
                ? await request(searchUrl('code', MARKETPLACE_MANIFEST_QUERY), token, 'application/vnd.github+json')
                : unauthenticated();
            const merged = new Map();
            for (const item of curated.ok ? curated.items : []) {
                const repo = repoFullName(item);
                if (repo)
                    merged.set(repo, { repo, description: repoDescription(item), stars: null, htmlUrl: repoUrl(repo), curated: true });
            }
            for (const response of byStars) {
                for (const item of response.ok ? response.items : []) {
                    const starred = toRepoHit(item);
                    if (!starred)
                        continue;
                    const existing = merged.get(starred.repo);
                    merged.set(starred.repo, { ...starred, curated: existing?.curated ?? false });
                }
            }
            const responses = [...byStars, curated];
            const results = [...merged.values()].sort(curatedThenStars);
            // Partial answers still ship their results; the condition says what is
            // missing from them, which is the whole reason it travels alongside.
            const degraded = responses.find((response) => response.condition !== null)?.condition ?? null;
            return remember(key, { results, rateLimit: tightestLimit(responses), degraded });
        },
    };
}
/** Curated first, then most-starred; a repo with no star count sorts after one that has them. */
function curatedThenStars(left, right) {
    if (left.curated !== right.curated)
        return left.curated ? -1 : 1;
    return (right.stars ?? -1) - (left.stars ?? -1);
}
function cacheKey(kind, token, query) {
    // Whether a token was in play is part of the key: adding one in Settings
    // changes what the same query can return, and must not read a cached refusal.
    return `${kind}:${token ? 'auth' : 'anon'}:${query.toLowerCase()}`;
}
function searchUrl(endpoint, query, extras = {}) {
    const url = new URL(`${GITHUB_API_ORIGIN}/search/${endpoint}`);
    url.searchParams.set('q', query);
    url.searchParams.set('per_page', String(SEARCH_PAGE_SIZE));
    for (const [name, value] of Object.entries(extras))
        url.searchParams.set(name, value);
    return url;
}
function unauthenticated() {
    return { ok: false, items: [], rateLimit: null, condition: condition('needs_token', NEEDS_TOKEN_MESSAGE) };
}
async function fetchSearch(url, token, accept, options) {
    const fetcher = options.fetcher ?? defaultFetch;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_DISCOVER_TIMEOUT_MS);
    try {
        let response;
        try {
            response = await fetcher(url.toString(), {
                method: 'GET',
                headers: { accept, ...(token ? { authorization: `Bearer ${token}` } : {}) },
                signal: controller.signal,
            });
        }
        catch (error) {
            const timedOut = error instanceof Error && error.name === 'AbortError';
            return {
                ok: false,
                items: [],
                rateLimit: null,
                condition: condition('unavailable', timedOut
                    ? 'GitHub did not answer the search in time.'
                    : `Could not reach GitHub. ${error instanceof Error ? error.message : String(error)}`),
            };
        }
        const rateLimit = readRateLimit(response);
        if (!response.ok) {
            return { ok: false, items: [], rateLimit, condition: await failureCondition(response, rateLimit) };
        }
        let body;
        try {
            body = (await response.json());
        }
        catch {
            return {
                ok: false,
                items: [],
                rateLimit,
                condition: condition('unavailable', 'GitHub returned a search result that could not be read.'),
            };
        }
        const items = Array.isArray(body.items)
            ? body.items.filter((item) => typeof item === 'object' && item !== null)
            : [];
        // GitHub gives up on a search that takes too long and answers 200 with a
        // short — sometimes empty — list. Unstated, that is exactly the silent
        // "no matches" this surface must never show.
        if (body.incomplete_results === true) {
            return {
                ok: true,
                items,
                rateLimit,
                condition: condition('unavailable', 'GitHub stopped this search early, so these results are partial.'),
            };
        }
        return { ok: true, items, rateLimit, condition: null };
    }
    finally {
        clearTimeout(timeout);
    }
}
async function failureCondition(response, rateLimit) {
    const retryAfterSeconds = retryAfterFrom(response, rateLimit);
    if (response.status === 429 || (response.status === 403 && rateLimit?.remaining === 0)) {
        return condition('rate_limited', retryAfterSeconds > 0
            ? `GitHub's search limit is used up. It resets in about ${Math.ceil(retryAfterSeconds / 60)} min.`
            : "GitHub's search limit is used up. Try again shortly.", retryAfterSeconds);
    }
    if (response.status === 401 || response.status === 403) {
        return condition('needs_token', `GitHub rejected the search. ${NEEDS_TOKEN_MESSAGE}`);
    }
    const message = await githubMessage(response);
    return condition('unavailable', message ?? `GitHub replied with HTTP ${response.status}.`);
}
async function githubMessage(response) {
    try {
        const parsed = (await response.json());
        return typeof parsed.message === 'string' && parsed.message ? parsed.message : null;
    }
    catch {
        return null;
    }
}
/**
 * A budget is reported only when GitHub sent both halves of it. A missing
 * `remaining` header must not read as 0, which is the value that decides
 * whether a 403 was exhaustion or a rejected credential.
 */
function readRateLimit(response) {
    const limit = numericHeader(response, 'x-ratelimit-limit');
    const remaining = numericHeader(response, 'x-ratelimit-remaining');
    if (limit === null || remaining === null)
        return null;
    const reset = numericHeader(response, 'x-ratelimit-reset');
    return {
        limit,
        remaining,
        resetAt: reset !== null && reset > 0 ? new Date(reset * 1000).toISOString() : '',
    };
}
function numericHeader(response, name) {
    const raw = response.headers.get(name);
    if (raw === null || raw.trim() === '')
        return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
}
function retryAfterFrom(response, rateLimit) {
    const retryAfter = Number(response.headers.get('retry-after'));
    if (Number.isFinite(retryAfter) && retryAfter > 0)
        return Math.ceil(retryAfter);
    if (rateLimit?.resetAt) {
        const delta = Math.ceil((Date.parse(rateLimit.resetAt) - Date.now()) / 1000);
        if (delta > 0)
            return delta;
    }
    return 0;
}
/** The budget closest to running out, so the surface reports the one that will bite first. */
function tightestLimit(responses) {
    return responses.reduce((tightest, response) => {
        if (!response.rateLimit)
            return tightest;
        return !tightest || response.rateLimit.remaining < tightest.remaining ? response.rateLimit : tightest;
    }, null);
}
function condition(reason, message, retryAfterSeconds = 0) {
    return { reason, message, retryAfterSeconds };
}
function toSearchHit(item) {
    const repo = repoFullName(item);
    const path = typeof item.path === 'string' ? item.path : '';
    if (!repo || !path)
        return null;
    const skillId = path.split('/').slice(0, -1).join('/');
    const fragment = parseSkillFragment(textMatchFragments(item));
    return {
        repo,
        path,
        skillId,
        name: fragment.name || skillId.split('/').slice(-1)[0] || repo,
        description: fragment.description,
        htmlUrl: typeof item.html_url === 'string' ? item.html_url : `${repoUrl(repo)}/blob/HEAD/${path}`,
    };
}
/** Every matched window in the file, so frontmatter split across two of them still reads. */
function textMatchFragments(item) {
    if (!Array.isArray(item.text_matches))
        return '';
    return item.text_matches
        .map((match) => match && typeof match === 'object' && typeof match.fragment === 'string'
        ? match.fragment
        : '')
        .filter((fragment) => fragment.length > 0)
        .join('\n');
}
function toRepoHit(item) {
    const repo = typeof item.full_name === 'string' ? item.full_name : '';
    if (!repo)
        return null;
    return {
        repo,
        description: typeof item.description === 'string' ? item.description : '',
        stars: typeof item.stargazers_count === 'number' ? item.stargazers_count : null,
        htmlUrl: typeof item.html_url === 'string' ? item.html_url : repoUrl(repo),
        curated: false,
    };
}
function repoFullName(item) {
    const repository = item.repository;
    if (!repository || typeof repository !== 'object')
        return '';
    const fullName = repository.full_name;
    return typeof fullName === 'string' ? fullName : '';
}
function repoDescription(item) {
    const repository = item.repository;
    if (!repository || typeof repository !== 'object')
        return '';
    const description = repository.description;
    return typeof description === 'string' ? description : '';
}
function repoUrl(repo) {
    return `https://github.com/${repo}`;
}
function isPresent(value) {
    return value !== null;
}
async function defaultFetch(url, init) {
    if (typeof globalThis.fetch !== 'function')
        throw new Error('fetch is not available.');
    return globalThis.fetch(url, init);
}
