import { spawn } from 'child_process';
import { stat } from 'fs/promises';
import { basename, dirname, join, sep } from 'path';
import { rgPath } from '@vscode/ripgrep';
const FILE_SEARCH_DEFAULT_LIMIT = 200;
const FILE_SEARCH_MAX_LIMIT = 500;
const CONTENT_SEARCH_DEFAULT_LIMIT = 200;
const CONTENT_SEARCH_MAX_LIMIT = 500;
const FILE_SEARCH_DEFAULT_EXCLUDES = [
    '.git',
    '.hg',
    '.svn',
    'node_modules',
    'dist',
    'out',
    'build',
    '.next',
    '.turbo',
    'coverage',
];
const activeFileSearches = new Map();
const cancelledFileSearches = new WeakSet();
const activeContentSearches = new Map();
const cancelledContentSearches = new WeakSet();
function normalizeFileSearchLimit(limit) {
    if (typeof limit !== 'number' || !Number.isFinite(limit))
        return FILE_SEARCH_DEFAULT_LIMIT;
    return Math.min(Math.max(Math.floor(limit), 1), FILE_SEARCH_MAX_LIMIT);
}
function normalizeContentSearchLimit(limit) {
    if (typeof limit !== 'number' || !Number.isFinite(limit))
        return CONTENT_SEARCH_DEFAULT_LIMIT;
    return Math.min(Math.max(Math.floor(limit), 1), CONTENT_SEARCH_MAX_LIMIT);
}
function normalizeSearchExcludePatterns(excludes) {
    if (!Array.isArray(excludes))
        return [];
    const seen = new Set();
    const patterns = [];
    excludes.forEach((exclude) => {
        if (typeof exclude !== 'string')
            return;
        const pattern = exclude.trim().replace(/\\/g, '/').replace(/^!+/u, '');
        if (!pattern || pattern.length > 200 || seen.has(pattern))
            return;
        seen.add(pattern);
        patterns.push(pattern);
    });
    return patterns.slice(0, 100);
}
function normalizeSearchPath(value) {
    return value.replace(/\\/g, '/').toLowerCase();
}
function hasGlobSyntax(pattern) {
    return /[*?[\]{}]/u.test(pattern);
}
function searchExcludeToRipgrepGlobs(pattern) {
    if (!hasGlobSyntax(pattern) && !pattern.includes('/')) {
        return [`!**/${pattern}`, `!**/${pattern}/**`];
    }
    return pattern.startsWith('**/')
        ? [`!${pattern}`]
        : [`!${pattern}`, `!**/${pattern}`];
}
function searchExcludeArgs(userExcludes) {
    const defaultExcludeArgs = FILE_SEARCH_DEFAULT_EXCLUDES.flatMap((pattern) => ['-g', `!**/${pattern}/**`]);
    const userExcludeArgs = userExcludes.flatMap((pattern) => searchExcludeToRipgrepGlobs(pattern).flatMap((glob) => ['-g', glob]));
    return [...defaultExcludeArgs, ...userExcludeArgs];
}
function toFileSearchEntry(rootPath, relativePath) {
    const normalizedRelativePath = relativePath.replace(/\\/g, sep);
    const fullPath = join(rootPath, normalizedRelativePath);
    const parentRelativePath = dirname(normalizedRelativePath);
    return {
        name: basename(fullPath),
        path: fullPath,
        parentPath: parentRelativePath === '.' ? rootPath : join(rootPath, parentRelativePath),
        isDir: false,
    };
}
function sortFileSearchResults(results, query) {
    const normalizedQuery = normalizeSearchPath(query);
    return [...results].sort((a, b) => {
        const aName = normalizeSearchPath(a.name);
        const bName = normalizeSearchPath(b.name);
        const aNameIndex = aName.indexOf(normalizedQuery);
        const bNameIndex = bName.indexOf(normalizedQuery);
        const aPath = normalizeSearchPath(a.path);
        const bPath = normalizeSearchPath(b.path);
        const aScore = aNameIndex === -1 ? 10_000 + aPath.indexOf(normalizedQuery) : aNameIndex;
        const bScore = bNameIndex === -1 ? 10_000 + bPath.indexOf(normalizedQuery) : bNameIndex;
        return aScore - bScore || a.path.length - b.path.length || a.path.localeCompare(b.path);
    });
}
function cancelActiveFileSearch(senderId) {
    const activeSearch = activeFileSearches.get(senderId);
    if (!activeSearch)
        return;
    activeFileSearches.delete(senderId);
    cancelledFileSearches.add(activeSearch);
    try {
        activeSearch.kill();
    }
    catch {
        // Process may already be exiting.
    }
}
export function cancelActiveContentSearch(senderId) {
    const activeSearch = activeContentSearches.get(senderId);
    if (!activeSearch)
        return;
    activeContentSearches.delete(senderId);
    cancelledContentSearches.add(activeSearch);
    try {
        activeSearch.kill();
    }
    catch {
        // Process may already be exiting.
    }
}
async function searchFilesWithRipgrep(senderId, rootPath, query, limit, userExcludes) {
    const normalizedQuery = normalizeSearchPath(query);
    const results = [];
    let stdoutBuffer = '';
    let stderrBuffer = '';
    let truncated = false;
    const excludeArgs = searchExcludeArgs(userExcludes);
    return new Promise((resolve) => {
        let settled = false;
        const child = spawn(rgPath, [
            '--files',
            '--color',
            'never',
            '--no-messages',
            ...excludeArgs,
        ], {
            cwd: rootPath,
            windowsHide: true,
        });
        activeFileSearches.set(senderId, child);
        const finish = (result) => {
            if (settled)
                return;
            settled = true;
            if (activeFileSearches.get(senderId) === child) {
                activeFileSearches.delete(senderId);
            }
            resolve(result);
        };
        const consumeLine = (relativePath) => {
            if (!relativePath)
                return;
            if (!normalizeSearchPath(relativePath).includes(normalizedQuery))
                return;
            results.push(toFileSearchEntry(rootPath, relativePath));
            if (results.length > limit) {
                truncated = true;
                results.length = limit;
                finish({ ok: true, results: sortFileSearchResults(results, query), truncated, engine: 'ripgrep' });
                try {
                    child.kill();
                }
                catch {
                    // Process may already have exited after producing enough results.
                }
            }
        };
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk) => {
            if (settled)
                return;
            stdoutBuffer += chunk;
            const lines = stdoutBuffer.split(/\r?\n/u);
            stdoutBuffer = lines.pop() ?? '';
            lines.forEach(consumeLine);
        });
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk) => {
            stderrBuffer += chunk;
        });
        child.on('error', (error) => {
            if (cancelledFileSearches.has(child)) {
                finish({ ok: true, results: [], truncated: false, engine: 'ripgrep' });
                return;
            }
            finish({
                ok: false,
                message: error instanceof Error ? error.message : String(error),
                engine: 'ripgrep',
            });
        });
        child.on('close', (code) => {
            if (settled)
                return;
            if (cancelledFileSearches.has(child)) {
                finish({ ok: true, results: [], truncated: false, engine: 'ripgrep' });
                return;
            }
            if (stdoutBuffer)
                consumeLine(stdoutBuffer);
            if (settled)
                return;
            if (code === 0 || code === 1) {
                finish({ ok: true, results: sortFileSearchResults(results, query), truncated, engine: 'ripgrep' });
                return;
            }
            finish({
                ok: false,
                message: stderrBuffer.trim() || `ripgrep exited with code ${code ?? 'unknown'}.`,
                engine: 'ripgrep',
            });
        });
    });
}
function withFileSearchDiagnostics(result, startedAt) {
    if (!result.ok)
        return result;
    return {
        ...result,
        elapsedMs: Date.now() - startedAt,
        resultCount: result.results.length,
    };
}
function toContentSearchEntry(rootPath, message) {
    if (!message || typeof message !== 'object')
        return null;
    const envelope = message;
    if (envelope.type !== 'match')
        return null;
    const relativePath = typeof envelope.data?.path?.text === 'string'
        ? envelope.data.path.text.replace(/^\.[\\/]/u, '')
        : '';
    const lineText = typeof envelope.data?.lines?.text === 'string'
        ? envelope.data.lines.text.replace(/\r?\n$/u, '')
        : '';
    const lineNumber = typeof envelope.data?.line_number === 'number'
        ? envelope.data.line_number
        : 0;
    const firstMatch = envelope.data?.submatches?.[0];
    const column = typeof firstMatch?.start === 'number' ? firstMatch.start + 1 : 1;
    const matchText = typeof firstMatch?.match?.text === 'string' ? firstMatch.match.text : '';
    if (!relativePath || lineNumber < 1)
        return null;
    const normalizedRelativePath = relativePath.replace(/\\/g, sep);
    const fullPath = join(rootPath, normalizedRelativePath);
    const parentRelativePath = dirname(normalizedRelativePath);
    return {
        name: basename(fullPath),
        path: fullPath,
        parentPath: parentRelativePath === '.' ? rootPath : join(rootPath, parentRelativePath),
        lineNumber,
        column,
        lineText,
        matchText,
    };
}
async function searchContentWithRipgrep(senderId, rootPath, query, limit, userExcludes) {
    const results = [];
    let stdoutBuffer = '';
    let stderrBuffer = '';
    let truncated = false;
    return new Promise((resolve) => {
        let settled = false;
        const child = spawn(rgPath, [
            '--json',
            '--color',
            'never',
            '--no-messages',
            '--line-number',
            '--column',
            '--fixed-strings',
            ...searchExcludeArgs(userExcludes),
            '--',
            query,
            '.',
        ], {
            cwd: rootPath,
            windowsHide: true,
        });
        activeContentSearches.set(senderId, child);
        const finish = (result) => {
            if (settled)
                return;
            settled = true;
            if (activeContentSearches.get(senderId) === child) {
                activeContentSearches.delete(senderId);
            }
            resolve(result);
        };
        const consumeLine = (line) => {
            if (!line)
                return;
            let message;
            try {
                message = JSON.parse(line);
            }
            catch {
                return;
            }
            const entry = toContentSearchEntry(rootPath, message);
            if (!entry)
                return;
            results.push(entry);
            if (results.length > limit) {
                truncated = true;
                results.length = limit;
                finish({ ok: true, results, truncated, engine: 'ripgrep' });
                try {
                    child.kill();
                }
                catch {
                    // Process may already have exited after producing enough results.
                }
            }
        };
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk) => {
            if (settled)
                return;
            stdoutBuffer += chunk;
            const lines = stdoutBuffer.split(/\r?\n/u);
            stdoutBuffer = lines.pop() ?? '';
            lines.forEach(consumeLine);
        });
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk) => {
            stderrBuffer += chunk;
        });
        child.on('error', (error) => {
            if (cancelledContentSearches.has(child)) {
                finish({ ok: true, results: [], truncated: false, engine: 'ripgrep' });
                return;
            }
            finish({
                ok: false,
                message: error instanceof Error ? error.message : String(error),
                engine: 'ripgrep',
            });
        });
        child.on('close', (code) => {
            if (settled)
                return;
            if (cancelledContentSearches.has(child)) {
                finish({ ok: true, results: [], truncated: false, engine: 'ripgrep' });
                return;
            }
            if (stdoutBuffer)
                consumeLine(stdoutBuffer);
            if (settled)
                return;
            if (code === 0 || code === 1) {
                finish({ ok: true, results, truncated, engine: 'ripgrep' });
                return;
            }
            finish({
                ok: false,
                message: stderrBuffer.trim() || `ripgrep exited with code ${code ?? 'unknown'}.`,
                engine: 'ripgrep',
            });
        });
    });
}
function withContentSearchDiagnostics(result, startedAt) {
    if (!result.ok)
        return result;
    return {
        ...result,
        elapsedMs: Date.now() - startedAt,
        resultCount: result.results.length,
    };
}
export async function searchFiles(senderId, input) {
    const startedAt = Date.now();
    const rootPath = typeof input.rootPath === 'string' ? input.rootPath : '';
    const query = typeof input.query === 'string' ? input.query.trim() : '';
    const limit = normalizeFileSearchLimit(input.limit);
    const userExcludes = normalizeSearchExcludePatterns(input.excludes);
    if (!rootPath || !query) {
        return withFileSearchDiagnostics({ ok: true, results: [], truncated: false, engine: 'ripgrep' }, startedAt);
    }
    try {
        const rootStats = await stat(rootPath);
        if (!rootStats.isDirectory()) {
            return { ok: false, message: 'Search root is not a directory.', engine: null };
        }
    }
    catch (error) {
        return {
            ok: false,
            message: error instanceof Error ? error.message : String(error),
            engine: null,
        };
    }
    cancelActiveFileSearch(senderId);
    const ripgrepResult = await searchFilesWithRipgrep(senderId, rootPath, query, limit, userExcludes);
    if (ripgrepResult.ok)
        return withFileSearchDiagnostics(ripgrepResult, startedAt);
    return ripgrepResult;
}
export async function searchContent(senderId, input) {
    const startedAt = Date.now();
    const rootPath = typeof input.rootPath === 'string' ? input.rootPath : '';
    const query = typeof input.query === 'string' ? input.query.trim() : '';
    const limit = normalizeContentSearchLimit(input.limit);
    const userExcludes = normalizeSearchExcludePatterns(input.excludes);
    if (!rootPath || !query) {
        return withContentSearchDiagnostics({ ok: true, results: [], truncated: false, engine: 'ripgrep' }, startedAt);
    }
    try {
        const rootStats = await stat(rootPath);
        if (!rootStats.isDirectory()) {
            return { ok: false, message: 'Search root is not a directory.', engine: null };
        }
    }
    catch (error) {
        return {
            ok: false,
            message: error instanceof Error ? error.message : String(error),
            engine: null,
        };
    }
    cancelActiveContentSearch(senderId);
    return withContentSearchDiagnostics(await searchContentWithRipgrep(senderId, rootPath, query, limit, userExcludes), startedAt);
}
