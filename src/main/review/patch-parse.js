// Tolerant unified-diff / git-format-patch parser. Turns raw patch text into the
// normalized ChangeSetFile[] the review surfaces project. Owned by the change-set
// ingestion service (MC-1676); the branch source feeds it `git diff` output and
// the patch source feeds it pasted text. Node-free apart from the shared review
// types, so it is unit-tested directly (esbuild -> node), never through Electron.
//
// Design: segment the text into per-file blocks, then read each block's headers
// and hunks. Robust to `diff --git` headers, renames/copies, /dev/null add &
// delete markers, binary markers, CRLF line endings, and multi-hunk bodies.
// Authoritative paths come from `---`/`+++`/`rename`/`Binary files` lines; the
// `diff --git a/x b/y` line is only a fallback (it is ambiguous for paths with
// spaces). Hunk bodies are bounded by their declared line counts so trailing
// format-patch signature lines never bleed into a hunk.
const NOT_A_DIFF = "Not a unified diff — expected a 'diff --git' or '---' header.";
export function parsePatch(text) {
    const lines = text.split(/\r?\n/);
    const hasGitHeader = lines.some((line) => line.startsWith('diff --git '));
    const hasUnifiedHeader = lines.some((line) => line.startsWith('--- '));
    if (!hasGitHeader && !hasUnifiedHeader) {
        // An empty diff is a legitimate "no changes" result (a branch identical to its
        // base); non-empty text with no diff structure is a user error worth naming.
        if (text.trim().length === 0) {
            return { ok: true, files: [], stats: { files: 0, additions: 0, deletions: 0 } };
        }
        return { ok: false, error: NOT_A_DIFF };
    }
    const blocks = hasGitHeader ? splitGitBlocks(lines) : splitUnifiedBlocks(lines);
    const files = [];
    for (const block of blocks) {
        const file = parseFileBlock(block);
        if (file)
            files.push(file);
    }
    const stats = files.reduce((acc, file) => ({
        files: acc.files + 1,
        additions: acc.additions + file.additions,
        deletions: acc.deletions + file.deletions,
    }), { files: 0, additions: 0, deletions: 0 });
    return { ok: true, files, stats };
}
// Each `diff --git` line starts a new file; anything before the first is preamble
// (format-patch email headers, commit message) and is dropped.
function splitGitBlocks(lines) {
    const blocks = [];
    let current = null;
    for (const line of lines) {
        if (line.startsWith('diff --git ')) {
            if (current)
                blocks.push(current);
            current = [line];
        }
        else if (current) {
            current.push(line);
        }
    }
    if (current)
        blocks.push(current);
    return blocks;
}
// Plain unified diffs (`diff -u`, no `diff --git`) are segmented by their `--- `
// header. Requiring the immediately following `+++ ` avoids mistaking a deleted
// line that itself renders as `--- ...` for a new file boundary.
function splitUnifiedBlocks(lines) {
    const blocks = [];
    let current = null;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.startsWith('--- ') && lines[i + 1]?.startsWith('+++ ')) {
            if (current)
                blocks.push(current);
            current = [line];
        }
        else if (current) {
            current.push(line);
        }
    }
    if (current)
        blocks.push(current);
    return blocks;
}
function parseFileBlock(block) {
    let oldPath;
    let newPath;
    let renameOld;
    let renameNew;
    let markedNew = false;
    let markedDeleted = false;
    let binary = false;
    let oldIsDevNull = false;
    let newIsDevNull = false;
    const hunks = [];
    let additions = 0;
    let deletions = 0;
    const gitHeader = block[0]?.startsWith('diff --git ') ? block[0] : undefined;
    if (gitHeader) {
        const fallback = parseDiffGitPaths(gitHeader);
        if (fallback) {
            oldPath = fallback.old;
            newPath = fallback.new;
        }
    }
    let i = 0;
    while (i < block.length) {
        const line = block[i];
        if (line.startsWith('new file mode')) {
            markedNew = true;
            i++;
        }
        else if (line.startsWith('deleted file mode')) {
            markedDeleted = true;
            i++;
        }
        else if (line.startsWith('rename from ') || line.startsWith('copy from ')) {
            renameOld = dequote(line.slice(line.indexOf('from ') + 5));
            i++;
        }
        else if (line.startsWith('rename to ') || line.startsWith('copy to ')) {
            renameNew = dequote(line.slice(line.indexOf('to ') + 3));
            i++;
        }
        else if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) {
            binary = true;
            const parsedBinary = parseBinaryFilesLine(line);
            if (parsedBinary) {
                if (parsedBinary.old === null)
                    oldIsDevNull = true;
                else
                    oldPath = parsedBinary.old;
                if (parsedBinary.new === null)
                    newIsDevNull = true;
                else
                    newPath = parsedBinary.new;
            }
            i++;
        }
        else if (line.startsWith('--- ')) {
            const parsedPath = stripDiffPathPrefix(line.slice(4));
            if (parsedPath === null)
                oldIsDevNull = true;
            else
                oldPath = parsedPath;
            i++;
        }
        else if (line.startsWith('+++ ')) {
            const parsedPath = stripDiffPathPrefix(line.slice(4));
            if (parsedPath === null)
                newIsDevNull = true;
            else
                newPath = parsedPath;
            i++;
        }
        else if (line.startsWith('@@')) {
            const header = parseHunkHeader(line);
            if (!header) {
                i++;
                continue;
            }
            const collected = collectHunk(block, i, header);
            hunks.push(collected.hunk);
            for (const bodyLine of collected.hunk.lines) {
                if (bodyLine.kind === 'add')
                    additions++;
                else if (bodyLine.kind === 'del')
                    deletions++;
            }
            i = collected.next;
        }
        else {
            i++;
        }
    }
    if (renameOld)
        oldPath = renameOld;
    if (renameNew)
        newPath = renameNew;
    let status;
    if (renameOld && renameNew)
        status = 'renamed';
    else if (markedNew || oldIsDevNull)
        status = 'added';
    else if (markedDeleted || newIsDevNull)
        status = 'deleted';
    else
        status = 'modified';
    let path;
    let recordedOldPath;
    if (status === 'deleted') {
        path = oldPath ?? newPath;
    }
    else if (status === 'renamed') {
        path = newPath;
        recordedOldPath = oldPath;
    }
    else {
        path = newPath ?? oldPath;
    }
    if (!path)
        return null;
    // A rename without a discernible source is not a valid renamed record; degrade
    // to a plain modification rather than emit a file the validator would reject.
    if (status === 'renamed' && !recordedOldPath)
        status = 'modified';
    const file = {
        path,
        status,
        binary,
        additions: binary ? 0 : additions,
        deletions: binary ? 0 : deletions,
        hunks: binary ? [] : hunks,
    };
    if (status === 'renamed' && recordedOldPath)
        file.oldPath = recordedOldPath;
    return file;
}
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
function parseHunkHeader(line) {
    const match = line.match(HUNK_HEADER);
    if (!match)
        return null;
    return {
        oldStart: Number(match[1]),
        oldLines: match[2] === undefined ? 1 : Number(match[2]),
        newStart: Number(match[3]),
        newLines: match[4] === undefined ? 1 : Number(match[4]),
    };
}
// Consumes a hunk body bounded by its declared old/new line counts, so trailing
// non-body content (the next `@@`, a `diff --git`, or a format-patch signature)
// stops the hunk instead of being swallowed.
function collectHunk(block, headerIndex, header) {
    const lines = [];
    let oldSeen = 0;
    let newSeen = 0;
    let j = headerIndex + 1;
    while (j < block.length && (oldSeen < header.oldLines || newSeen < header.newLines)) {
        const line = block[j];
        if (line.startsWith('\\')) {
            // "\ No newline at end of file" — a note, not a body line.
            j++;
            continue;
        }
        const marker = line[0];
        if (marker === '+') {
            lines.push({ kind: 'add', text: line.slice(1) });
            newSeen++;
        }
        else if (marker === '-') {
            lines.push({ kind: 'del', text: line.slice(1) });
            oldSeen++;
        }
        else if (marker === ' ') {
            lines.push({ kind: 'context', text: line.slice(1) });
            oldSeen++;
            newSeen++;
        }
        else if (line === '') {
            // A bare empty line inside a hunk we still owe counts for: a blank context
            // line some tools emit without the leading space.
            lines.push({ kind: 'context', text: '' });
            oldSeen++;
            newSeen++;
        }
        else {
            break;
        }
        j++;
    }
    return {
        hunk: {
            oldStart: header.oldStart,
            oldLines: header.oldLines,
            newStart: header.newStart,
            newLines: header.newLines,
            lines,
        },
        next: j,
    };
}
function parseDiffGitPaths(line) {
    const rest = line.slice('diff --git '.length);
    if (rest.startsWith('"')) {
        const match = rest.match(/^("(?:[^"\\]|\\.)*") ("(?:[^"\\]|\\.)*")$/);
        if (!match)
            return null;
        const oldPath = stripDiffPathPrefix(match[1]);
        const newPath = stripDiffPathPrefix(match[2]);
        if (oldPath === null || newPath === null)
            return null;
        return { old: oldPath, new: newPath };
    }
    const match = rest.match(/^a\/(.*) b\/(.*)$/);
    if (!match)
        return null;
    return { old: match[1], new: match[2] };
}
function parseBinaryFilesLine(line) {
    const match = line.match(/^Binary files (.+) and (.+) differ$/);
    if (!match)
        return null;
    return { old: stripDiffPathPrefix(match[1]), new: stripDiffPathPrefix(match[2]) };
}
// Strips the `a/`|`b/` prefix and returns null for `/dev/null`. Also drops the
// trailing tab+timestamp a traditional (non-git) unified diff appends to headers.
function stripDiffPathPrefix(raw) {
    let value = dequote(raw);
    const tabIndex = value.indexOf('\t');
    if (tabIndex !== -1)
        value = value.slice(0, tabIndex);
    value = value.trim();
    if (value === '/dev/null')
        return null;
    if (value.startsWith('a/') || value.startsWith('b/'))
        value = value.slice(2);
    return value;
}
const QUOTE_ESCAPES = { '"': '"', '\\': '\\', t: '\t', n: '\n', r: '\r' };
// Git C-quotes paths containing special characters (`"a/pa\tth"`). Unwrap the
// common escapes; octal escapes for non-ASCII bytes are rare and left as written.
function dequote(raw) {
    const value = raw.trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
        return value.slice(1, -1).replace(/\\(["\\tnr])/g, (_, char) => QUOTE_ESCAPES[char] ?? char);
    }
    return value;
}
