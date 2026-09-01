// Jira issue/comment bodies arrive as markup, not markdown: Jira REST v2 returns
// wiki markup (a string); a site forced to v3, or a Cloud field storing rich
// text, returns ADF (Atlassian Document Format — a JSON node tree). This module
// converts either shape best-effort to markdown for `bodyMarkdown`, and the
// caller ALWAYS keeps the original in `rawBody` — there is no lossy-only path
// (plan §3.1, MC-1635). An unconvertible body still yields a usable item: the
// markdown falls back to the body's plain text and the raw payload is preserved.
// The single entry point the normalizer uses. Branches purely on the runtime
// shape — string ⇒ wiki markup, object ⇒ ADF — never on the connection or a
// version flag, so one site returning either shape is handled without a config.
export function jiraBodyToMarkdown(body) {
    if (body === null || body === undefined)
        return { markdown: '' };
    if (typeof body === 'string') {
        const trimmed = body.trim();
        if (!trimmed)
            return { markdown: '' };
        return { markdown: wikiMarkupToMarkdown(body), raw: body };
    }
    if (typeof body === 'object') {
        const markdown = adfToMarkdown(body).trim();
        return { markdown, raw: JSON.stringify(body) };
    }
    return { markdown: String(body) };
}
// A comment body needs only the markdown (NormalizedIssue.comments carries no
// per-comment raw), so this thin wrapper keeps the call sites honest.
export function jiraCommentBodyToMarkdown(body) {
    return jiraBodyToMarkdown(body).markdown;
}
// ---------------------------------------------------------------------------
// Wiki markup → markdown
// ---------------------------------------------------------------------------
// U+FFFC (OBJECT REPLACEMENT CHARACTER) delimits protected spans: it exists for
// exactly this "stand-in for an extracted object" purpose, never appears in Jira
// markup, and is inert to every inline transform below.
const PLACEHOLDER = '￼';
const PLACEHOLDER_RE = /￼(\d+)￼/g;
// Best-effort conversion of Jira wiki markup. Code and monospace spans are pulled
// out to placeholders BEFORE any inline transform so their contents are never
// re-interpreted, then restored last.
export function wikiMarkupToMarkdown(wiki) {
    const protectedSpans = [];
    const protect = (replacement) => {
        const token = `${PLACEHOLDER}${protectedSpans.length}${PLACEHOLDER}`;
        protectedSpans.push(replacement);
        return token;
    };
    let text = wiki.replace(/\r\n/g, '\n');
    // Fenced blocks: {code}, {code:lang}, {code:title=..|lang=..}, {noformat}.
    text = text.replace(/\{code(?::([^}]*))?\}\n?([\s\S]*?)\{code\}/g, (_m, params, inner) => {
        const lang = extractCodeLang(params);
        return protect(`\n\`\`\`${lang}\n${inner.replace(/\n$/, '')}\n\`\`\`\n`);
    });
    text = text.replace(/\{noformat\}\n?([\s\S]*?)\{noformat\}/g, (_m, inner) => {
        return protect(`\n\`\`\`\n${inner.replace(/\n$/, '')}\n\`\`\`\n`);
    });
    // Inline monospace {{...}} → `...`.
    text = text.replace(/\{\{(.+?)\}\}/g, (_m, inner) => protect(`\`${inner}\``));
    const lines = text.split('\n');
    const out = [];
    for (const line of lines) {
        if (line.startsWith(PLACEHOLDER)) {
            out.push(line); // A protected block occupies its own line; pass through.
            continue;
        }
        out.push(convertWikiLine(line));
    }
    let result = out.join('\n');
    // Restore protected spans. A restored block may itself contain no token, so a
    // single pass suffices.
    result = result.replace(PLACEHOLDER_RE, (_m, idx) => protectedSpans[Number(idx)] ?? '');
    return result.replace(/\n{3,}/g, '\n\n').trim();
}
function extractCodeLang(params) {
    if (!params)
        return '';
    // Params are 'java' or 'title=Foo|language=java' style. Prefer an explicit
    // language/lang key; otherwise a bare first token that looks like a language.
    const parts = params.split('|').map((p) => p.trim());
    for (const part of parts) {
        const match = part.match(/^(?:language|lang)=(.+)$/i);
        if (match)
            return match[1].trim();
    }
    const bare = parts.find((p) => p && !p.includes('='));
    return bare ?? '';
}
// Converts one wiki line's block-level marker + inline spans. Code/monospace are
// already protected, so inline transforms here are safe.
function convertWikiLine(line) {
    // Horizontal rule.
    if (/^-{4,}\s*$/.test(line))
        return '---';
    // Headings h1. .. h6.
    const heading = line.match(/^h([1-6])\.\s+(.*)$/);
    if (heading)
        return `${'#'.repeat(Number(heading[1]))} ${convertInline(heading[2])}`;
    // Blockquote: bq. text
    const bq = line.match(/^bq\.\s+(.*)$/);
    if (bq)
        return `> ${convertInline(bq[1])}`;
    // Table rows: header ||a||b|| or data |a|b|.
    if (/^\s*\|\|.*\|\|\s*$/.test(line)) {
        const cells = splitTableCells(line, '||');
        return `| ${cells.map(convertInline).join(' | ')} |\n| ${cells.map(() => '---').join(' | ')} |`;
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
        const cells = splitTableCells(line, '|');
        return `| ${cells.map(convertInline).join(' | ')} |`;
    }
    // Lists: leading run of *, #, - markers (nesting = marker depth). A marker run
    // must be followed by whitespace to distinguish `* item` from `*bold*`.
    const list = line.match(/^([*#-]+)\s+(.*)$/);
    if (list) {
        const markers = list[1];
        const depth = markers.length - 1;
        const ordered = markers[markers.length - 1] === '#';
        const bullet = ordered ? '1.' : '-';
        return `${'  '.repeat(depth)}${bullet} ${convertInline(list[2])}`;
    }
    return convertInline(line);
}
function splitTableCells(line, delimiter) {
    const trimmed = line.trim();
    const inner = delimiter === '||' ? trimmed.replace(/^\|\|/, '').replace(/\|\|$/, '') : trimmed.replace(/^\|/, '').replace(/\|$/, '');
    return inner.split(delimiter).map((c) => c.trim());
}
// Inline span conversion. Links are handled before emphasis so a `[text|url]`
// containing `_` or `*` is not corrupted.
function convertInline(text) {
    let result = text;
    // Links: [text|url] → [text](url); [url] → <url> (mentions [~acct] → @acct).
    result = result.replace(/\[([^\]|]+)\|([^\]]+)\]/g, (_m, label, target) => {
        return `[${label.trim()}](${target.trim()})`;
    });
    // Bare [url] / [~mention]. The `(?!\()` guard skips a `[text]` that is already
    // the label of a `[text](url)` link produced by the rule above.
    result = result.replace(/\[([^\]|]+)\](?!\()/g, (_m, target) => {
        const value = target.trim();
        if (value.startsWith('~'))
            return `@${value.slice(1)}`;
        return /^[a-z]+:\/\//i.test(value) ? `<${value}>` : `[${value}](${value})`;
    });
    // Strip color macros, keeping their inner text.
    result = result.replace(/\{color:[^}]*\}([\s\S]*?)\{color\}/g, '$1');
    // Bold *text* → **text** (the run-of-markers list case is already handled).
    result = result.replace(/(^|[^*\w])\*(\S(?:[^*\n]*\S)?)\*(?=[^*\w]|$)/g, '$1**$2**');
    // Italic _text_ → *text* at word boundaries (leaves snake_case identifiers).
    result = result.replace(/(^|[^_\w])_(\S(?:[^_\n]*\S)?)_(?=[^_\w]|$)/g, '$1*$2*');
    // Strikethrough -text- → ~~text~~ at boundaries.
    result = result.replace(/(^|[^-\w])-(\S(?:[^-\n]*\S)?)-(?=[^-\w]|$)/g, '$1~~$2~~');
    return result;
}
// Best-effort ADF renderer covering the node types Jira issue bodies actually
// use. Unknown nodes fall through to their concatenated text so nothing is lost.
export function adfToMarkdown(node) {
    const root = asAdfNode(node);
    if (!root)
        return '';
    const blocks = root.content ?? [root];
    return renderAdfNodes(blocks).join('\n\n');
}
function renderAdfNodes(nodes) {
    return nodes.map(renderAdfBlock).filter((block) => block.length > 0);
}
function renderAdfBlock(node) {
    switch (node.type) {
        case 'paragraph':
            return renderAdfInline(node.content ?? []);
        case 'heading': {
            const level = clampHeadingLevel(node.attrs?.level);
            return `${'#'.repeat(level)} ${renderAdfInline(node.content ?? [])}`;
        }
        case 'bulletList':
            return renderAdfList(node.content ?? [], '-');
        case 'orderedList':
            return renderAdfList(node.content ?? [], '1.');
        case 'codeBlock': {
            const lang = typeof node.attrs?.language === 'string' ? node.attrs.language : '';
            return `\`\`\`${lang}\n${collectAdfText(node)}\n\`\`\``;
        }
        case 'blockquote':
            return renderAdfNodes(node.content ?? [])
                .join('\n')
                .split('\n')
                .map((line) => `> ${line}`)
                .join('\n');
        case 'rule':
            return '---';
        default:
            if (node.content && node.content.length > 0)
                return renderAdfNodes(node.content).join('\n\n');
            return node.text ?? '';
    }
}
function renderAdfList(items, bullet) {
    return items
        .map((item) => {
        const body = renderAdfNodes(item.content ?? []).join('\n');
        return `${bullet} ${body}`;
    })
        .join('\n');
}
function renderAdfInline(nodes) {
    return nodes
        .map((child) => {
        if (child.type === 'hardBreak')
            return '\n';
        if (child.type === 'mention') {
            const label = typeof child.attrs?.text === 'string' ? child.attrs.text : '';
            return label.startsWith('@') ? label : `@${label}`;
        }
        if (child.type === 'text')
            return applyAdfMarks(child.text ?? '', child.marks ?? []);
        if (child.content)
            return renderAdfInline(child.content);
        return child.text ?? '';
    })
        .join('');
}
function applyAdfMarks(text, marks) {
    let result = text;
    for (const mark of marks) {
        switch (mark.type) {
            case 'strong':
                result = `**${result}**`;
                break;
            case 'em':
                result = `*${result}*`;
                break;
            case 'code':
                result = `\`${result}\``;
                break;
            case 'strike':
                result = `~~${result}~~`;
                break;
            case 'link': {
                const href = typeof mark.attrs?.href === 'string' ? mark.attrs.href : '';
                if (href)
                    result = `[${result}](${href})`;
                break;
            }
        }
    }
    return result;
}
function collectAdfText(node) {
    if (node.text)
        return node.text;
    return (node.content ?? []).map(collectAdfText).join('');
}
function clampHeadingLevel(level) {
    const n = typeof level === 'number' ? level : 1;
    return Math.min(6, Math.max(1, Math.trunc(n)));
}
function asAdfNode(value) {
    return value && typeof value === 'object' ? value : null;
}
