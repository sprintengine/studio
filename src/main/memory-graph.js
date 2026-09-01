import { readdir, readFile, stat } from 'fs/promises';
import { extname, isAbsolute, join, relative, resolve, sep } from 'path';
import { MAX_IMAGE_DATA_URL_BYTES } from './filesystem-read-limits';
const IMAGE_EXTENSIONS = new Set(['.apng', '.avif', '.bmp', '.gif', '.ico', '.jpg', '.jpeg', '.png', '.svg', '.webp']);
const TEXT_EXTENSIONS = new Set([
    '.css',
    '.csv',
    '.html',
    '.js',
    '.json',
    '.jsx',
    '.md',
    '.mdx',
    '.scss',
    '.ts',
    '.tsx',
    '.txt',
    '.yaml',
    '.yml',
]);
const MARKDOWN_LINK_RE = /!?\[[^\]]*]\(([^)]+)\)/g;
// [[note]] | [[note|alias]] | [[note#section]] | [[brand/multicode-assets]]
// Negative lookbehind on `!` so image embeds (`![[…]]`) are still skipped.
const WIKILINK_RE = /(?<!!)\[\[([^\]\n]+?)\]\]/g;
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const HEADING_RE = /^#\s+(.+)$/m;
const MAX_INDEX_FILES = 5000;
const MAX_MARKDOWN_BYTES = 1024 * 1024;
export function normalizeMemoryRelativeRoot(value) {
    if (typeof value !== 'string')
        return null;
    const normalized = value.trim().replace(/\\/g, '/').replace(/\/+$/u, '');
    if (!normalized || normalized === '.' || isAbsolute(normalized) || /^[A-Za-z]:\//.test(normalized))
        return null;
    return normalized;
}
function normalizePathKey(pathValue) {
    return pathValue.replace(/\\/g, '/').replace(/\/+$/u, '').toLowerCase();
}
function toDisplayRelativePath(rootPath, filePath) {
    return relative(rootPath, filePath).split(sep).join('/');
}
function isPathInside(parentPath, childPath) {
    const parentKey = normalizePathKey(resolve(parentPath));
    const childKey = normalizePathKey(resolve(childPath));
    return childKey === parentKey || childKey.startsWith(`${parentKey}/`);
}
function classifyNode(extension) {
    if (extension === '.md' || extension === '.mdx')
        return 'markdown';
    if (IMAGE_EXTENSIONS.has(extension))
        return 'image';
    if (TEXT_EXTENSIONS.has(extension))
        return 'text';
    return 'asset';
}
function groupForRelativePath(relativePath) {
    const first = relativePath.split('/').filter(Boolean)[0];
    return first && relativePath.includes('/') ? first : 'Root';
}
async function collectFiles(rootPath) {
    const files = [];
    const visit = async (dirPath) => {
        if (files.length >= MAX_INDEX_FILES)
            return;
        const entries = await readdir(dirPath, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === '.obsidian')
                continue;
            const entryPath = join(dirPath, entry.name);
            if (entry.isDirectory()) {
                await visit(entryPath);
                continue;
            }
            if (!entry.isFile())
                continue;
            const stats = await stat(entryPath);
            const extension = extname(entry.name).toLowerCase();
            files.push({
                path: entryPath,
                relativePath: toDisplayRelativePath(rootPath, entryPath),
                name: entry.name,
                extension,
                sizeBytes: stats.size,
            });
            if (files.length >= MAX_INDEX_FILES)
                return;
        }
    };
    await visit(rootPath);
    return files;
}
export async function resolveMemoryRoot(workspaceRoot, relativeRootInput) {
    const relativeRoot = normalizeMemoryRelativeRoot(relativeRootInput);
    if (!workspaceRoot?.trim()) {
        return {
            ok: false,
            status: 'missing-workspace',
            relativeRoot,
            message: 'Open a workspace folder before configuring the Knowledge Graph.',
        };
    }
    if (!relativeRoot) {
        return {
            ok: false,
            status: 'invalid-relative-path',
            relativeRoot: null,
            message: 'Knowledge path must be a non-empty relative path.',
        };
    }
    const rootPath = resolve(workspaceRoot, relativeRoot);
    try {
        const stats = await stat(rootPath);
        if (!stats.isDirectory()) {
            return {
                ok: false,
                status: 'missing-memory-root',
                relativeRoot,
                message: 'Configured knowledge path is not a folder.',
            };
        }
    }
    catch (error) {
        return {
            ok: false,
            status: 'missing-memory-root',
            relativeRoot,
            message: error instanceof Error ? error.message : 'Configured knowledge folder is missing.',
        };
    }
    return { ok: true, rootPath, relativeRoot };
}
function parseMarkdownLinks(content) {
    const links = [];
    for (const match of content.matchAll(MARKDOWN_LINK_RE)) {
        const raw = match[1]?.trim();
        if (!raw)
            continue;
        const href = raw.split(/\s+["'][^"']*["']\s*$/u)[0]?.trim() ?? raw;
        links.push(href);
    }
    return links;
}
function parseWikilinks(content) {
    const links = [];
    for (const match of content.matchAll(WIKILINK_RE)) {
        const raw = match[1]?.trim();
        if (!raw)
            continue;
        // Strip alias (after `|`) and fragment (after `#`).
        const target = raw.split('|')[0]?.split('#')[0]?.trim();
        if (target)
            links.push(target);
    }
    return links;
}
/**
 * Minimal YAML frontmatter reader for the graph: scalar strings, inline arrays
 * `[a, b]`, and block-style arrays prefixed with `-`. Anything richer falls
 * through unparsed rather than crashing the index.
 */
function parseFrontmatter(content) {
    const match = FRONTMATTER_RE.exec(content);
    if (!match)
        return { body: content, data: {} };
    const data = {};
    const lines = match[1].split(/\r?\n/);
    let currentKey = null;
    let currentList = null;
    const stripQuotes = (value) => {
        const trimmed = value.trim();
        if (trimmed.length >= 2) {
            const first = trimmed[0];
            const last = trimmed[trimmed.length - 1];
            if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
                return trimmed.slice(1, -1);
            }
        }
        return trimmed;
    };
    for (const rawLine of lines) {
        const line = rawLine.replace(/\s+$/u, '');
        if (!line.trim()) {
            if (currentKey && currentList) {
                data[currentKey] = currentList;
                currentKey = null;
                currentList = null;
            }
            continue;
        }
        const listItem = /^\s*-\s+(.+)$/.exec(line);
        if (listItem && currentKey) {
            if (!currentList)
                currentList = [];
            currentList.push(stripQuotes(listItem[1]));
            continue;
        }
        const kv = /^([A-Za-z0-9_\-]+)\s*:\s*(.*)$/.exec(line);
        if (!kv)
            continue;
        if (currentKey && currentList) {
            data[currentKey] = currentList;
            currentList = null;
        }
        const key = kv[1];
        const value = kv[2];
        if (!value) {
            currentKey = key;
            currentList = [];
            continue;
        }
        const inlineArray = /^\[(.*)\]$/.exec(value.trim());
        if (inlineArray) {
            data[key] = inlineArray[1]
                .split(',')
                .map((entry) => stripQuotes(entry))
                .filter((entry) => entry.length > 0);
            currentKey = null;
            currentList = null;
            continue;
        }
        data[key] = stripQuotes(value);
        currentKey = null;
        currentList = null;
    }
    if (currentKey && currentList)
        data[currentKey] = currentList;
    return { body: content.slice(match[0].length), data };
}
function frontmatterStringList(value) {
    if (!value)
        return [];
    if (Array.isArray(value))
        return value.map((entry) => entry.trim()).filter(Boolean);
    return value.split(',').map((entry) => entry.trim()).filter(Boolean);
}
function firstHeading(body) {
    const match = HEADING_RE.exec(body);
    return match?.[1]?.trim() || undefined;
}
/**
 * Resolves a wikilink-style href (no extension) to a known file. Tries:
 *   1. <sourceDir>/<href>.md  (and .mdx)
 *   2. <root>/<href>.md       (and .mdx)
 *   3. exact relative match if the href already has an extension
 * Returns the canonical relative path, or null when nothing matches.
 */
function resolveWikilink(href, sourceRelativePath, rootPath, keyByRelativePath) {
    const cleaned = href.replace(/\\/g, '/').replace(/^\/+/u, '').trim();
    if (!cleaned)
        return null;
    const candidates = [];
    const hasExtension = /\.[a-z0-9]+$/i.test(cleaned);
    const sourceDir = sourceRelativePath.includes('/')
        ? sourceRelativePath.split('/').slice(0, -1).join('/')
        : '';
    if (hasExtension) {
        candidates.push(cleaned);
        if (sourceDir)
            candidates.push(`${sourceDir}/${cleaned}`);
    }
    else {
        const exts = ['.md', '.mdx'];
        for (const ext of exts) {
            if (sourceDir)
                candidates.push(`${sourceDir}/${cleaned}${ext}`);
            candidates.push(`${cleaned}${ext}`);
        }
    }
    for (const candidate of candidates) {
        const resolved = resolve(rootPath, candidate);
        if (!isPathInside(rootPath, resolved))
            continue;
        const relativePath = toDisplayRelativePath(rootPath, resolved);
        const matched = keyByRelativePath.get(normalizePathKey(relativePath));
        if (matched)
            return matched;
    }
    return null;
}
function isExternalHref(href) {
    return /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//');
}
function stripHrefDecoration(href) {
    const withoutAnchor = href.split('#')[0] ?? href;
    const withoutQuery = withoutAnchor.split('?')[0] ?? withoutAnchor;
    try {
        return decodeURIComponent(withoutQuery);
    }
    catch {
        return withoutQuery;
    }
}
export async function indexMemoryGraph(workspaceRoot, relativeRootInput) {
    const root = await resolveMemoryRoot(workspaceRoot, relativeRootInput);
    if (!root.ok)
        return root;
    try {
        const files = await collectFiles(root.rootPath);
        const nodeByRelativePath = new Map();
        const keyByRelativePath = new Map();
        files.forEach((file) => {
            const node = {
                id: file.relativePath,
                path: file.path,
                relativePath: file.relativePath,
                name: file.name,
                kind: classifyNode(file.extension),
                extension: file.extension,
                sizeBytes: file.sizeBytes,
                degree: 0,
                inboundDegree: 0,
                group: groupForRelativePath(file.relativePath),
            };
            nodeByRelativePath.set(file.relativePath, node);
            keyByRelativePath.set(normalizePathKey(file.relativePath), file.relativePath);
        });
        const edges = [];
        const edgeKeys = new Set();
        const unresolvedLinks = [];
        const recordEdge = (sourceRelPath, targetKey) => {
            if (sourceRelPath === targetKey)
                return;
            const edgeKey = `${sourceRelPath}${targetKey}`;
            if (edgeKeys.has(edgeKey))
                return;
            edgeKeys.add(edgeKey);
            edges.push({
                id: `${sourceRelPath}->${targetKey}`,
                source: sourceRelPath,
                target: targetKey,
                sourcePath: sourceRelPath,
                targetPath: targetKey,
            });
        };
        for (const file of files) {
            if (file.extension !== '.md' && file.extension !== '.mdx')
                continue;
            if (file.sizeBytes > MAX_MARKDOWN_BYTES)
                continue;
            const raw = await readFile(file.path, 'utf-8');
            const { body, data } = parseFrontmatter(raw);
            const node = nodeByRelativePath.get(file.relativePath);
            if (node) {
                const explicitTitle = typeof data.title === 'string' ? data.title : undefined;
                node.title = explicitTitle || firstHeading(body) || undefined;
                node.type = typeof data.type === 'string' ? data.type : undefined;
                const tags = frontmatterStringList(data.tags);
                if (tags.length > 0)
                    node.tags = tags;
            }
            for (const href of parseMarkdownLinks(body)) {
                if (isExternalHref(href))
                    continue;
                const cleanHref = stripHrefDecoration(href);
                if (!cleanHref)
                    continue;
                const targetPath = resolve(join(root.rootPath, file.relativePath, '..'), cleanHref);
                if (!isPathInside(root.rootPath, targetPath)) {
                    unresolvedLinks.push({
                        sourcePath: file.relativePath,
                        href,
                        resolvedRelativePath: null,
                        reason: 'outside-root',
                    });
                    continue;
                }
                const targetRelativePath = toDisplayRelativePath(root.rootPath, targetPath);
                const targetKey = keyByRelativePath.get(normalizePathKey(targetRelativePath));
                if (!targetKey) {
                    unresolvedLinks.push({
                        sourcePath: file.relativePath,
                        href,
                        resolvedRelativePath: targetRelativePath,
                        reason: 'missing',
                    });
                    continue;
                }
                recordEdge(file.relativePath, targetKey);
            }
            for (const href of parseWikilinks(body)) {
                const targetKey = resolveWikilink(href, file.relativePath, root.rootPath, keyByRelativePath);
                if (!targetKey) {
                    unresolvedLinks.push({
                        sourcePath: file.relativePath,
                        href: `[[${href}]]`,
                        resolvedRelativePath: null,
                        reason: 'missing',
                    });
                    continue;
                }
                recordEdge(file.relativePath, targetKey);
            }
            const relatedRefs = [
                ...frontmatterStringList(data.related),
                ...frontmatterStringList(data['depends-on']),
            ];
            const relatedTargets = [];
            for (const ref of relatedRefs) {
                const targetKey = resolveWikilink(ref, file.relativePath, root.rootPath, keyByRelativePath);
                if (targetKey) {
                    recordEdge(file.relativePath, targetKey);
                    if (!relatedTargets.includes(targetKey))
                        relatedTargets.push(targetKey);
                }
            }
            if (relatedTargets.length > 0 && node)
                node.related = relatedTargets;
        }
        edges.forEach((edge) => {
            const source = nodeByRelativePath.get(edge.source);
            const target = nodeByRelativePath.get(edge.target);
            if (source)
                source.degree += 1;
            if (target) {
                target.degree += 1;
                target.inboundDegree += 1;
            }
        });
        const nodes = [...nodeByRelativePath.values()];
        const groups = [...new Set(nodes.map((node) => node.group))].sort();
        return {
            ok: true,
            rootPath: root.rootPath,
            relativeRoot: root.relativeRoot,
            nodes,
            edges,
            groups,
            unresolvedLinks,
            indexedAt: Date.now(),
        };
    }
    catch (error) {
        return {
            ok: false,
            status: 'inaccessible',
            relativeRoot: root.relativeRoot,
            message: error instanceof Error ? error.message : 'Unable to index knowledge folder.',
        };
    }
}
function imageMimeType(filePath) {
    switch (extname(filePath).toLowerCase()) {
        case '.apng':
            return 'image/apng';
        case '.avif':
            return 'image/avif';
        case '.bmp':
            return 'image/bmp';
        case '.gif':
            return 'image/gif';
        case '.ico':
            return 'image/x-icon';
        case '.jpg':
        case '.jpeg':
            return 'image/jpeg';
        case '.png':
            return 'image/png';
        case '.svg':
            return 'image/svg+xml';
        case '.webp':
            return 'image/webp';
        default:
            return null;
    }
}
export async function readMemoryPreview(workspaceRoot, relativeRootInput, relativePathInput) {
    const root = await resolveMemoryRoot(workspaceRoot, relativeRootInput);
    if (!root.ok)
        return { ok: false, message: root.message };
    const relativePath = relativePathInput.replace(/\\/g, '/').replace(/^\/+/u, '');
    const filePath = resolve(root.rootPath, relativePath);
    if (!isPathInside(root.rootPath, filePath)) {
        return { ok: false, message: 'Knowledge preview path is outside the knowledge root.' };
    }
    try {
        const stats = await stat(filePath);
        if (!stats.isFile())
            return { ok: false, message: 'Knowledge preview target is not a file.' };
        const extension = extname(filePath).toLowerCase();
        const node = {
            id: relativePath,
            path: filePath,
            relativePath,
            name: relativePath.split('/').filter(Boolean).pop() ?? relativePath,
            kind: classifyNode(extension),
            extension,
            sizeBytes: stats.size,
            degree: 0,
            inboundDegree: 0,
            group: groupForRelativePath(relativePath),
        };
        if (node.kind === 'image') {
            const mimeType = imageMimeType(filePath);
            if (!mimeType)
                return { ok: true, node, previewKind: 'unsupported', message: 'Image type is not supported.' };
            if (stats.size > MAX_IMAGE_DATA_URL_BYTES) {
                return { ok: true, node, previewKind: 'unsupported', message: 'Image is too large to preview.' };
            }
            const content = await readFile(filePath);
            return { ok: true, node, previewKind: 'image', dataUrl: `data:${mimeType};base64,${content.toString('base64')}` };
        }
        if (node.kind === 'markdown' || node.kind === 'text') {
            if (stats.size > MAX_MARKDOWN_BYTES) {
                return { ok: true, node, previewKind: 'unsupported', message: 'File is too large to preview.' };
            }
            const content = await readFile(filePath, 'utf-8');
            if (node.kind === 'markdown') {
                const { body, data } = parseFrontmatter(content);
                const title = typeof data.title === 'string' ? data.title : undefined;
                node.title = title || firstHeading(body) || undefined;
                node.type = typeof data.type === 'string' ? data.type : undefined;
                const tags = frontmatterStringList(data.tags);
                if (tags.length > 0)
                    node.tags = tags;
                return { ok: true, node, previewKind: 'markdown', content: body };
            }
            return { ok: true, node, previewKind: 'text', content };
        }
        return { ok: true, node, previewKind: 'unsupported', message: 'Preview is not available for this file type.' };
    }
    catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : 'Unable to read knowledge preview.' };
    }
}
