var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// src/renderer/canvas/anchorLabel.ts
function anchorRangeLabel(anchor) {
  return anchor.startLine === anchor.endLine ? `L${anchor.startLine}` : `L${anchor.startLine}\u2013${anchor.endLine}`;
}
var init_anchorLabel = __esm({
  "src/renderer/canvas/anchorLabel.ts"() {
    "use strict";
  }
});

// src/renderer/canvas/commentModel.ts
function isCommentEditable(comment) {
  return comment.sync.state === "pending" || comment.sync.state === "failed";
}
function newReviewComment(input) {
  const anchor = input.headSha ? { ...input.anchor, anchoredAtSha: input.headSha } : { ...input.anchor };
  return {
    id: input.id,
    path: input.path,
    anchor,
    body: input.body,
    createdAt: input.createdAt,
    sync: { state: "pending" }
  };
}
function addComment(comments, comment) {
  return [...comments, comment];
}
function editComment(comments, id, body) {
  return comments.map(
    (comment) => comment.id === id && isCommentEditable(comment) ? { ...comment, body } : comment
  );
}
function deleteComment(comments, id) {
  return comments.filter((comment) => !(comment.id === id && isCommentEditable(comment)));
}
function commentsForFile(comments, path) {
  return comments.filter((comment) => comment.path === path);
}
function postableComments(comments) {
  return comments.filter((comment) => comment.sync.state === "pending" || comment.sync.state === "failed");
}
function pendingCommentCount(comments) {
  return postableComments(comments).length;
}
function canPostReview(changeset, comments) {
  return isPullRequestReviewSource(changeset) && pendingCommentCount(comments) > 0;
}
function hasPostedComments(comments) {
  return comments.some((comment) => comment.sync.state === "posted");
}
function markCommentsPosting(comments) {
  return comments.map(
    (comment) => comment.sync.state === "pending" || comment.sync.state === "failed" ? { ...comment, sync: { state: "posting" } } : comment
  );
}
function applyPostOutcomes(comments, outcomes) {
  const byId = new Map(outcomes.map((outcome) => [outcome.id, outcome]));
  return comments.map((comment) => {
    const outcome = byId.get(comment.id);
    if (!outcome) return comment;
    const { anchorStatus: _prior, ...rest } = comment;
    return outcome.anchorStatus ? { ...rest, sync: outcome.sync, anchorStatus: outcome.anchorStatus } : { ...rest, sync: outcome.sync };
  });
}
function applyPostFailure(comments, postedIds, error) {
  const batch = new Set(postedIds);
  return comments.map(
    (comment) => batch.has(comment.id) ? { ...comment, sync: { state: "failed", error } } : comment
  );
}
function commentSyncChip(comment) {
  switch (comment.sync.state) {
    case "posted":
      return { label: "Posted", tone: "good" };
    case "posting":
      return { label: "Posting\u2026", tone: "neutral" };
    case "failed":
      return { label: "Failed", tone: "error" };
    case "pending":
    default:
      return { label: "Pending", tone: "neutral" };
  }
}
function commentLocationLabel(comment) {
  return `${comment.path} \xB7 ${anchorRangeLabel(comment.anchor)}`;
}
function commentCitation(comment) {
  const { anchor } = comment;
  const lines = anchor.startLine === anchor.endLine ? `L${anchor.startLine}` : `L${anchor.startLine}-${anchor.endLine}`;
  return `${comment.path}:${lines}`;
}
function commentsToMarkdown(comments) {
  return comments.map((comment) => `\`${commentCitation(comment)}\`
${comment.body.trim()}`).join("\n\n");
}
function isPullRequestReviewSource(changeset) {
  return changeset.source.kind === "pull-request";
}
function pullRequestLabel(changeset) {
  const { source } = changeset;
  return source.kind === "pull-request" ? `${source.owner}/${source.repo} #${source.number}` : null;
}
var init_commentModel = __esm({
  "src/renderer/canvas/commentModel.ts"() {
    "use strict";
    init_anchorLabel();
  }
});

// src/renderer/app/editor.ts
function detectLanguage(filename) {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  const map = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    py: "python",
    rs: "rust",
    go: "go",
    java: "java",
    cs: "csharp",
    cpp: "cpp",
    c: "c",
    h: "c",
    rb: "ruby",
    php: "php",
    html: "html",
    css: "css",
    scss: "scss",
    json: "json",
    md: "markdown",
    yaml: "yaml",
    yml: "yaml",
    toml: "ini",
    sh: "shell",
    bash: "shell",
    sql: "sql",
    xml: "xml"
  };
  return map[ext] ?? "plaintext";
}
function isMacPlatform() {
  if (typeof navigator === "undefined") return false;
  const platform = navigator.userAgentData?.platform;
  const source = platform ?? navigator.platform ?? navigator.userAgent ?? "";
  return /mac/i.test(source);
}
function primaryModifierLabel() {
  return isMacPlatform() ? "Cmd" : "Ctrl";
}
var MONO_FONT_STACK;
var init_editor = __esm({
  "src/renderer/app/editor.ts"() {
    "use strict";
    MONO_FONT_STACK = '"JetBrains Mono", ui-monospace, SFMono-Regular, "SF Mono", "Cascadia Code", Menlo, Consolas, monospace';
  }
});

// src/renderer/canvas/diffModel.ts
function buildDiffFileModel(file) {
  const rows = [];
  let modifiedEditorLine = 0;
  let originalEditorLine = 0;
  for (const hunk of file.hunks) {
    let newLine = hunk.newStart;
    let oldLine = hunk.oldStart;
    for (const line of hunk.lines) {
      if (line.kind === "context") {
        rows.push({
          kind: "context",
          text: line.text,
          newLine,
          oldLine,
          modifiedEditorLine: ++modifiedEditorLine,
          originalEditorLine: ++originalEditorLine
        });
        newLine += 1;
        oldLine += 1;
      } else if (line.kind === "add") {
        rows.push({
          kind: "add",
          text: line.text,
          newLine,
          oldLine: null,
          modifiedEditorLine: ++modifiedEditorLine,
          originalEditorLine: null
        });
        newLine += 1;
      } else {
        rows.push({
          kind: "del",
          text: line.text,
          newLine: null,
          oldLine,
          modifiedEditorLine: null,
          originalEditorLine: ++originalEditorLine
        });
        oldLine += 1;
      }
    }
  }
  const modifiedRows = rows.filter((row) => row.modifiedEditorLine !== null);
  const originalRows = rows.filter((row) => row.originalEditorLine !== null);
  return {
    path: file.path,
    language: detectLanguage(file.path),
    modified: modifiedRows.map((row) => row.text).join("\n"),
    original: originalRows.map((row) => row.text).join("\n"),
    rows,
    modifiedRealLines: modifiedRows.map((row) => row.newLine),
    originalRealLines: originalRows.map((row) => row.oldLine)
  };
}
function editorLineForRealLine(model, side, realLine) {
  const table = side === "new" ? model.modifiedRealLines : model.originalRealLines;
  const index = table.indexOf(realLine);
  return index === -1 ? null : index + 1;
}
function modifiedZoneLineForAnchor(model, anchor) {
  if (anchor.side === "new") {
    return editorLineForRealLine(model, "new", anchor.endLine);
  }
  const endIndex = model.rows.findIndex((row) => row.oldLine === anchor.endLine);
  if (endIndex === -1) return null;
  for (let i = endIndex; i >= 0; i -= 1) {
    const line = model.rows[i].modifiedEditorLine;
    if (line !== null) return line;
  }
  return model.modifiedRealLines.length > 0 ? 0 : null;
}
var init_diffModel = __esm({
  "src/renderer/canvas/diffModel.ts"() {
    "use strict";
    init_editor();
  }
});

// src/renderer/canvas/annotationZones.ts
function placeAnnotations(annotations, model) {
  const zones = [];
  const orphans = [];
  for (const annotation of annotations) {
    const afterLineNumber = modifiedZoneLineForAnchor(model, annotation.anchor);
    if (afterLineNumber === null) orphans.push(annotation);
    else zones.push({ annotation, afterLineNumber });
  }
  return { zones, orphans };
}
function hoverLinesForAnnotation(annotation, model) {
  if (annotation.anchor.side !== "new") return [];
  const lines = [];
  for (let real = annotation.anchor.startLine; real <= annotation.anchor.endLine; real += 1) {
    if (model.modifiedRealLines.includes(real)) lines.push(real);
  }
  return lines;
}
var ZONE_CONTENT_INSET;
var init_annotationZones = __esm({
  "src/renderer/canvas/annotationZones.ts"() {
    "use strict";
    init_diffModel();
    ZONE_CONTENT_INSET = "pl-[55px]";
  }
});

// src/renderer/canvas/AnnotationRibbon.tsx
import { useEffect as useEffect4, useLayoutEffect, useRef as useRef4, useState as useState4 } from "react";
import { GhostButton as GhostButton2 } from "@sprintengine/module-sdk/ui";
import { LinkButton } from "@sprintengine/module-sdk/ui";
import { Fragment, jsx as jsx4, jsxs as jsxs4 } from "react/jsx-runtime";
function AnnotationRibbon({ annotation, onAskGuide, onMeasured }) {
  const [open, setOpen] = useState4(false);
  const ref = useRef4(null);
  useLayoutEffect(() => {
    if (ref.current) onMeasured(ref.current.scrollHeight);
  }, [open, annotation, onMeasured]);
  useEffect4(() => {
    const node = ref.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => onMeasured(node.scrollHeight));
    observer.observe(node);
    return () => observer.disconnect();
  }, [onMeasured]);
  const expandable = Boolean(annotation.detail);
  const headLine = /* @__PURE__ */ jsxs4(Fragment, { children: [
    expandable ? /* @__PURE__ */ jsx4(
      "svg",
      {
        viewBox: "0 0 16 16",
        className: "icon-xs mr-1 inline-block shrink-0 align-[-1px] text-[color:var(--text-subtle)] transition-transform",
        style: { transform: open ? "rotate(90deg)" : "none" },
        fill: "none",
        "aria-hidden": "true",
        children: /* @__PURE__ */ jsx4("path", { d: "M6 4l4 4-4 4", stroke: "currentColor", strokeWidth: "1.5", strokeLinecap: "round", strokeLinejoin: "round" })
      }
    ) : null,
    /* @__PURE__ */ jsx4("span", { className: "font-medium text-[color:var(--text-strong)]", children: annotation.title }),
    /* @__PURE__ */ jsxs4("span", { className: "text-[color:var(--text-default)]", children: [
      " \u2014 ",
      annotation.summary
    ] }),
    /* @__PURE__ */ jsx4("span", { className: "ml-2 font-mono text-micro tabular-nums text-[color:var(--text-subtle)]", children: anchorRangeLabel(annotation.anchor) })
  ] });
  return /* @__PURE__ */ jsxs4(
    "div",
    {
      ref,
      className: `flex gap-2.5 border-t border-[color:var(--border-subtle)] bg-[color:var(--bg-hover)] py-2.5 ${ZONE_CONTENT_INSET} pr-4`,
      children: [
        /* @__PURE__ */ jsx4(SparkMark, {}),
        /* @__PURE__ */ jsxs4("div", { className: "min-w-0 flex-1 text-body leading-5", children: [
          expandable ? (
            // The head line is PROSE that happens to open something, so it is the
            // kit's inline link, not a box: it wraps with the sentence, takes the
            // ribbon's own type, and states `aria-expanded` for the detail below.
            // No underline — the chevron is the affordance.
            /* @__PURE__ */ jsx4(
              LinkButton,
              {
                ink: "quiet",
                underline: "never",
                size: "inherit",
                onClick: () => setOpen((value) => !value),
                "aria-expanded": open,
                children: headLine
              }
            )
          ) : /* @__PURE__ */ jsx4("p", { className: "text-body leading-5 text-[color:var(--text-default)]", children: headLine }),
          open && annotation.detail ? /* @__PURE__ */ jsx4("p", { className: "mt-1.5 max-w-[72ch] text-body leading-5 text-[color:var(--text-muted)]", children: annotation.detail }) : null,
          open ? /* @__PURE__ */ jsx4("div", { className: "mt-2", children: /* @__PURE__ */ jsx4(GhostButton2, { onClick: () => onAskGuide(annotation), children: "Ask the guide" }) }) : null
        ] })
      ]
    }
  );
}
var SparkMark;
var init_AnnotationRibbon = __esm({
  "src/renderer/canvas/AnnotationRibbon.tsx"() {
    "use strict";
    init_anchorLabel();
    init_annotationZones();
    SparkMark = () => /* @__PURE__ */ jsx4(
      "span",
      {
        className: "mt-0.5 inline-flex size-icon-sm shrink-0 items-center justify-center rounded-xs bg-[color:var(--accent-primary-soft-strong)] text-[color:var(--accent-primary)]",
        "aria-hidden": "true",
        children: /* @__PURE__ */ jsx4("svg", { viewBox: "0 0 16 16", className: "icon-xs", fill: "currentColor", children: /* @__PURE__ */ jsx4("path", { d: "M8 1l1.6 4.4L14 7l-4.4 1.6L8 13l-1.6-4.4L2 7l4.4-1.6z" }) })
      }
    );
  }
});

// src/renderer/canvas/CommentComposer.tsx
import { useEffect as useEffect5, useRef as useRef5, useState as useState5 } from "react";
import { PrimaryButton, GhostButton as GhostButton3 } from "@sprintengine/module-sdk/ui";
import { Textarea } from "@sprintengine/module-sdk/ui";
import { KbdChord } from "@sprintengine/module-sdk/ui";
import { Fragment as Fragment2, jsx as jsx5, jsxs as jsxs5 } from "react/jsx-runtime";
function CommentComposer({
  placeholder,
  submitLabel,
  initialBody = "",
  anchorLabel,
  hint,
  onSubmit,
  onCancel
}) {
  const [body, setBody] = useState5(initialBody);
  const ref = useRef5(null);
  useEffect5(() => {
    const node = ref.current;
    if (!node) return;
    node.focus();
    node.setSelectionRange(node.value.length, node.value.length);
  }, []);
  const trimmed = body.trim();
  const submit = () => {
    if (!trimmed) return;
    onSubmit(trimmed);
  };
  return /* @__PURE__ */ jsxs5("div", { className: `border-t border-[color:var(--border-subtle)] bg-[color:var(--bg-surface)] py-2.5 ${ZONE_CONTENT_INSET} pr-4`, children: [
    /* @__PURE__ */ jsx5(
      Textarea,
      {
        ref,
        value: body,
        onChange: (event) => setBody(event.target.value),
        onKeyDown: (event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            submit();
          } else if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
          }
        },
        placeholder,
        rows: 3,
        size: "sm",
        resize: "y",
        className: "max-w-[560px]"
      }
    ),
    /* @__PURE__ */ jsxs5("div", { className: "mt-2 flex flex-wrap items-center gap-2", children: [
      /* @__PURE__ */ jsx5(PrimaryButton, { onClick: submit, disabled: !trimmed, children: submitLabel }),
      /* @__PURE__ */ jsx5(GhostButton3, { onClick: onCancel, children: "Cancel" }),
      /* @__PURE__ */ jsxs5("span", { className: "ml-auto flex items-center gap-2.5 text-micro text-[color:var(--text-subtle)]", children: [
        /* @__PURE__ */ jsxs5("span", { className: "inline-flex items-center gap-1", children: [
          /* @__PURE__ */ jsx5(KbdChord, { keys: [PRIMARY_KEY, "Enter"] }),
          " submit"
        ] }),
        /* @__PURE__ */ jsxs5("span", { className: "inline-flex items-center gap-1", children: [
          /* @__PURE__ */ jsx5(KbdChord, { keys: ["Shift", "Enter"] }),
          " new line"
        ] })
      ] })
    ] }),
    anchorLabel || hint ? /* @__PURE__ */ jsxs5("p", { className: "mt-1.5 text-micro leading-4 text-[color:var(--text-subtle)]", children: [
      anchorLabel ? /* @__PURE__ */ jsxs5(Fragment2, { children: [
        "Anchored to ",
        /* @__PURE__ */ jsx5("span", { className: "font-medium text-[color:var(--text-default)]", children: anchorLabel })
      ] }) : null,
      anchorLabel && hint ? " \xB7 " : null,
      hint
    ] }) : null
  ] });
}
var PRIMARY_KEY;
var init_CommentComposer = __esm({
  "src/renderer/canvas/CommentComposer.tsx"() {
    "use strict";
    init_editor();
    init_annotationZones();
    PRIMARY_KEY = primaryModifierLabel();
  }
});

// src/renderer/canvas/CommentThread.tsx
import { useState as useState6 } from "react";
import { GhostButton as GhostButton4 } from "@sprintengine/module-sdk/ui";
import { InlineNotice } from "@sprintengine/module-sdk/ui";
import { StatusDot } from "@sprintengine/module-sdk/ui";
import { jsx as jsx6, jsxs as jsxs6 } from "react/jsx-runtime";
function CommentSyncBadge({ comment, context }) {
  const chip = commentSyncChip(comment);
  return /* @__PURE__ */ jsxs6("span", { className: "inline-flex items-center gap-1.5 text-micro text-[color:var(--text-subtle)]", children: [
    /* @__PURE__ */ jsx6(StatusDot, { tone: chip.tone }),
    /* @__PURE__ */ jsxs6("span", { children: [
      chip.label,
      context ? /* @__PURE__ */ jsxs6("span", { className: "text-[color:var(--text-subtle)]", children: [
        " \xB7 ",
        context
      ] }) : null
    ] })
  ] });
}
function CommentThread({ comment, onEdit, onDelete }) {
  const [editing, setEditing] = useState6(false);
  const editable = isCommentEditable(comment);
  if (editing) {
    return /* @__PURE__ */ jsx6(
      CommentComposer,
      {
        submitLabel: "Save",
        placeholder: "Edit your comment\u2026",
        initialBody: comment.body,
        onSubmit: (body) => {
          onEdit(comment.id, body);
          setEditing(false);
        },
        onCancel: () => setEditing(false)
      }
    );
  }
  return /* @__PURE__ */ jsxs6("div", { className: `border-t border-[color:var(--border-subtle)] bg-[color:var(--bg-surface)] py-2.5 ${ZONE_CONTENT_INSET} pr-4`, children: [
    /* @__PURE__ */ jsxs6("div", { className: "mb-1 flex items-center gap-2", children: [
      /* @__PURE__ */ jsx6("span", { className: "text-micro font-medium text-[color:var(--text-strong)]", children: "You" }),
      /* @__PURE__ */ jsx6(CommentSyncBadge, { comment, context: comment.sync.state === "pending" ? "will post to PR" : void 0 })
    ] }),
    /* @__PURE__ */ jsx6("p", { className: "max-w-[72ch] whitespace-pre-wrap text-body leading-5 text-[color:var(--text-default)]", children: comment.body }),
    comment.sync.state === "failed" ? /* @__PURE__ */ jsx6(InlineNotice, { tone: "error", className: "mt-1.5 max-w-[72ch]", children: comment.sync.error }) : null,
    editable ? /* @__PURE__ */ jsxs6("div", { className: "mt-1.5 flex gap-1", children: [
      /* @__PURE__ */ jsx6(GhostButton4, { onClick: () => setEditing(true), children: "Edit" }),
      /* @__PURE__ */ jsx6(GhostButton4, { onClick: () => onDelete(comment.id), children: "Delete" })
    ] }) : null
  ] });
}
var init_CommentThread = __esm({
  "src/renderer/canvas/CommentThread.tsx"() {
    "use strict";
    init_annotationZones();
    init_commentModel();
    init_CommentComposer();
  }
});

// src/renderer/canvas/commentGutter.ts
function commentableLines(model, side) {
  const map = /* @__PURE__ */ new Map();
  for (const row of model.rows) {
    if (side === "new" && (row.kind === "add" || row.kind === "context") && row.modifiedEditorLine && row.newLine) {
      map.set(row.modifiedEditorLine, row.newLine);
    } else if (side === "old" && row.kind === "del" && row.originalEditorLine && row.oldLine) {
      map.set(row.originalEditorLine, row.oldLine);
    }
  }
  return map;
}
function wireSide(editor, monaco, side, lines, actionScope, requestComment) {
  let decorations = [];
  const clear = () => {
    decorations = editor.deltaDecorations(decorations, []);
  };
  const anchorForLine = (editorLine) => {
    if (!editorLine) return null;
    const real = lines.get(editorLine);
    return real === void 0 ? null : { side, startLine: real, endLine: real };
  };
  editor.onMouseMove((event) => {
    const line = event.target.position?.lineNumber;
    if (!line || !lines.has(line)) {
      clear();
      return;
    }
    decorations = editor.deltaDecorations(decorations, [
      {
        range: new monaco.Range(line, 1, line, 1),
        options: {
          glyphMarginClassName: "mcrev-comment-glyph",
          glyphMarginHoverMessage: { value: "Comment on this line" }
        }
      }
    ]);
  });
  editor.onMouseLeave(() => clear());
  editor.onMouseDown((event) => {
    if (event.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) return;
    const anchor = anchorForLine(event.target.position?.lineNumber);
    if (anchor) requestComment(anchor);
  });
  editor.addAction({
    id: `review-comment-on-line-${actionScope}`,
    label: "Comment on this line",
    keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.KeyC],
    run: (ed) => {
      const anchor = anchorForLine(ed.getPosition()?.lineNumber);
      if (anchor) requestComment(anchor);
    }
  });
}
function wireCommentGutter(editor, monaco, model, requestComment) {
  wireSide(editor.getModifiedEditor(), monaco, "new", commentableLines(model, "new"), "modified", requestComment);
  wireSide(editor.getOriginalEditor(), monaco, "old", commentableLines(model, "old"), "original", requestComment);
}
var init_commentGutter = __esm({
  "src/renderer/canvas/commentGutter.ts"() {
    "use strict";
  }
});

// src/renderer/canvas/ReviewDiffEditor.tsx
var ReviewDiffEditor_exports = {};
__export(ReviewDiffEditor_exports, {
  default: () => ReviewDiffEditor_default
});
import { useCallback as useCallback4, useEffect as useEffect6, useLayoutEffect as useLayoutEffect2, useMemo as useMemo3, useRef as useRef6, useState as useState7 } from "react";
import { createPortal } from "react-dom";
import { DiffEditor } from "@monaco-editor/react";
import { jsx as jsx7, jsxs as jsxs7 } from "react/jsx-runtime";
function composerAnchorLabel(anchor) {
  return anchor.side === "old" ? `removed line ${anchor.startLine}` : `line ${anchor.startLine}`;
}
function MeasuredZone({ onMeasured, children }) {
  const ref = useRef6(null);
  const cb = useRef6(onMeasured);
  cb.current = onMeasured;
  useLayoutEffect2(() => {
    if (ref.current) cb.current(ref.current.scrollHeight);
  });
  useEffect6(() => {
    const node = ref.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => cb.current(node.scrollHeight));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return /* @__PURE__ */ jsx7("div", { ref, children });
}
function ReviewDiffEditor({
  file,
  annotations,
  diffView,
  monacoTheme,
  onRequestComment,
  onAskGuide,
  onOrphans,
  registerReveal,
  comments = [],
  onCreateComment,
  onEditComment,
  onDeleteComment
}) {
  const model = useMemo3(() => buildDiffFileModel(file), [file]);
  const editorRef = useRef6(null);
  const hunksRef = useRef6([]);
  const hunkIndexRef = useRef6(0);
  const [zones, setZones] = useState7([]);
  const [editorReady, setEditorReady] = useState7(false);
  const [composerAnchor, setComposerAnchor] = useState7(null);
  const commentsEnabled = Boolean(onCreateComment);
  const { placements, orphans } = useMemo3(() => {
    const placed = placeAnnotations(annotations, model);
    return { placements: placed.zones, orphans: placed.orphans };
  }, [annotations, model]);
  useEffect6(() => {
    if (orphans.length > 0) {
      for (const orphan of orphans) {
        console.warn(
          `[review] annotation "${orphan.id}" anchor ${orphan.anchor.side} ${orphan.anchor.startLine}-${orphan.anchor.endLine} is outside ${file.path}; rendering in the side panel without a zone.`
        );
      }
    }
    onOrphans(file.path, orphans);
  }, [orphans, file.path, onOrphans]);
  const revealHunk = useCallback4((index) => {
    const editor = editorRef.current;
    const hunks = hunksRef.current;
    if (!editor || hunks.length === 0) return;
    const clamped = Math.min(Math.max(index, 0), hunks.length - 1);
    const hunk = hunks[clamped];
    hunkIndexRef.current = clamped;
    if (hunk.modifiedEndLineNumber === 0) {
      editor.getOriginalEditor().revealLineInCenter(Math.max(1, hunk.originalStartLineNumber));
    } else {
      editor.getModifiedEditor().revealLineInCenter(Math.max(1, hunk.modifiedStartLineNumber));
    }
  }, []);
  const applyLineNumbers = useCallback4(
    (editor) => {
      const forSide = (real) => (editorLine) => {
        const value = real[editorLine - 1];
        return value === void 0 ? "" : String(value);
      };
      editor.getModifiedEditor().updateOptions({ lineNumbers: forSide(model.modifiedRealLines) });
      editor.getOriginalEditor().updateOptions({ lineNumbers: forSide(model.originalRealLines) });
    },
    [model]
  );
  const applyHintDecorations = useCallback4(
    (editor, monaco) => {
      const modified = editor.getModifiedEditor();
      const decorations = [];
      for (const annotation of annotations) {
        const lines = hoverLinesForAnnotation(annotation, model);
        for (const real of lines) {
          const editorLine = model.modifiedRealLines.indexOf(real) + 1;
          if (editorLine <= 0) continue;
          decorations.push({
            range: new monaco.Range(editorLine, 1, editorLine, 1),
            options: {
              isWholeLine: true,
              inlineClassName: "mcrev-hint-line",
              hoverMessage: { value: `**Guide**

${annotation.hoverTip}` }
            }
          });
        }
      }
      modified.createDecorationsCollection(decorations);
    },
    [annotations, model]
  );
  const requestCommentRef = useRef6(() => {
  });
  requestCommentRef.current = (anchor) => {
    if (commentsEnabled) setComposerAnchor(anchor);
    else onRequestComment(file.path, anchor.startLine);
  };
  const mountZones = useCallback4(
    (editor) => {
      const mounted = [];
      editor.getModifiedEditor().changeViewZones((accessor) => {
        for (const placement of placements) {
          const domNode = document.createElement("div");
          domNode.style.width = "100%";
          domNode.style.zIndex = "5";
          const zone = {
            afterLineNumber: placement.afterLineNumber,
            afterColumn: 1,
            heightInPx: 1,
            domNode
          };
          const zoneId = accessor.addZone(zone);
          mounted.push({ placement, domNode, zone, zoneId });
        }
      });
      setZones(mounted);
    },
    [placements]
  );
  const resizeZone = useCallback4((mounted, height) => {
    const editor = editorRef.current;
    if (!editor || height <= 0 || mounted.zone.heightInPx === height) return;
    mounted.zone.heightInPx = height;
    editor.getModifiedEditor().changeViewZones((accessor) => accessor.layoutZone(mounted.zoneId));
  }, []);
  const dynamicZonesRef = useRef6(/* @__PURE__ */ new Map());
  const modelRef = useRef6(null);
  const zoneSigRef = useRef6("");
  const [dynamicZones, setDynamicZones] = useState7([]);
  const resizeDynamic = useCallback4((key, height) => {
    const editor = editorRef.current;
    const zone = dynamicZonesRef.current.get(key);
    if (!editor || !zone || height <= 0 || zone.zone.heightInPx === height) return;
    zone.zone.heightInPx = height;
    editor.getModifiedEditor().changeViewZones((accessor) => accessor.layoutZone(zone.zoneId));
  }, []);
  useEffect6(() => {
    const editor = editorRef.current;
    if (!editor || !editorReady) return;
    const modified = editor.getModifiedEditor();
    const current = dynamicZonesRef.current;
    const modelChanged = modelRef.current !== model;
    if (modelChanged) {
      modelRef.current = model;
      current.clear();
    }
    const desired = [];
    for (const comment of comments) {
      const afterLineNumber = modifiedZoneLineForAnchor(model, comment.anchor);
      if (afterLineNumber === null) continue;
      desired.push({ key: `thread:${comment.id}`, afterLineNumber, descriptor: { kind: "thread", comment } });
    }
    if (composerAnchor !== null) {
      const afterLineNumber = modifiedZoneLineForAnchor(model, composerAnchor);
      if (afterLineNumber !== null) {
        desired.push({ key: "composer", afterLineNumber, descriptor: { kind: "composer", anchor: composerAnchor } });
      }
    }
    const signature = JSON.stringify(
      desired.map(
        (entry) => entry.descriptor.kind === "thread" ? [entry.key, entry.afterLineNumber, entry.descriptor.comment.body, entry.descriptor.comment.sync.state] : [entry.key, entry.afterLineNumber, entry.descriptor.anchor.side, entry.descriptor.anchor.startLine]
      )
    );
    if (!modelChanged && signature === zoneSigRef.current) return;
    zoneSigRef.current = signature;
    const desiredByKey = new Map(desired.map((entry) => [entry.key, entry]));
    modified.changeViewZones((accessor) => {
      for (const [key, zone] of current) {
        const want = desiredByKey.get(key);
        if (!want || want.afterLineNumber !== zone.afterLineNumber) {
          accessor.removeZone(zone.zoneId);
          current.delete(key);
        }
      }
      for (const entry of desired) {
        const existing = current.get(entry.key);
        if (existing) {
          existing.descriptor = entry.descriptor;
          continue;
        }
        const domNode = document.createElement("div");
        domNode.style.width = "100%";
        domNode.style.zIndex = "6";
        const zone = {
          afterLineNumber: entry.afterLineNumber,
          afterColumn: 1,
          heightInPx: 1,
          domNode
        };
        const zoneId = accessor.addZone(zone);
        current.set(entry.key, { key: entry.key, afterLineNumber: entry.afterLineNumber, descriptor: entry.descriptor, domNode, zone, zoneId });
      }
    });
    setDynamicZones([...current.values()]);
  }, [comments, composerAnchor, model, editorReady]);
  const handleMount = useCallback4(
    (editor, monaco) => {
      editorRef.current = editor;
      applyLineNumbers(editor);
      applyHintDecorations(editor, monaco);
      wireCommentGutter(editor, monaco, model, (anchor) => requestCommentRef.current(anchor));
      editor.getModifiedEditor().onDidChangeModelContent(() => applyLineNumbers(editor));
      editor.onDidUpdateDiff(() => {
        hunksRef.current = editor.getLineChanges() ?? [];
      });
      editor.getModifiedEditor().onKeyDown((event) => {
        if (event.browserEvent.key !== "F7") return;
        event.preventDefault();
        event.stopPropagation();
        revealHunk(hunkIndexRef.current + (event.browserEvent.shiftKey ? -1 : 1));
      });
      mountZones(editor);
      registerReveal?.(file.path, (realLine) => {
        const editorLine = model.modifiedRealLines.indexOf(realLine) + 1;
        editor.getModifiedEditor().revealLineInCenter(editorLine > 0 ? editorLine : 1);
      });
      setEditorReady(true);
    },
    [applyLineNumbers, applyHintDecorations, revealHunk, mountZones, registerReveal, file.path, model]
  );
  useEffect6(() => {
    return () => registerReveal?.(file.path, null);
  }, [registerReveal, file.path]);
  useEffect6(() => {
    editorRef.current?.updateOptions({ renderSideBySide: diffView === "side-by-side" });
  }, [diffView]);
  const editorHeight = useMemo3(() => {
    const lines = Math.max(model.modifiedRealLines.length, model.originalRealLines.length, 1);
    return Math.min(560, Math.max(120, lines * 20 + 20));
  }, [model]);
  return /* @__PURE__ */ jsxs7("div", { style: { height: editorHeight }, children: [
    /* @__PURE__ */ jsx7(
      DiffEditor,
      {
        height: "100%",
        theme: monacoTheme,
        original: model.original,
        modified: model.modified,
        language: model.language,
        keepCurrentOriginalModel: false,
        keepCurrentModifiedModel: false,
        options: {
          readOnly: true,
          renderSideBySide: diffView === "side-by-side",
          glyphMargin: true,
          fontSize: 12.5,
          fontFamily: MONO_FONT_STACK,
          lineHeight: 20,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          automaticLayout: true,
          contextmenu: false,
          renderOverviewRuler: false,
          scrollbar: { alwaysConsumeMouseWheel: false }
        },
        onMount: handleMount
      }
    ),
    zones.map(
      (mounted) => createPortal(
        /* @__PURE__ */ jsx7(
          AnnotationRibbon,
          {
            annotation: mounted.placement.annotation,
            onAskGuide,
            onMeasured: (height) => resizeZone(mounted, height)
          }
        ),
        mounted.domNode,
        mounted.placement.annotation.id
      )
    ),
    dynamicZones.map((zone) => {
      const descriptor = zone.descriptor;
      return createPortal(
        /* @__PURE__ */ jsx7(MeasuredZone, { onMeasured: (height) => resizeDynamic(zone.key, height), children: descriptor.kind === "thread" ? /* @__PURE__ */ jsx7(
          CommentThread,
          {
            comment: descriptor.comment,
            onEdit: onEditComment ?? (() => {
            }),
            onDelete: onDeleteComment ?? (() => {
            })
          }
        ) : /* @__PURE__ */ jsx7(
          CommentComposer,
          {
            submitLabel: "Add comment",
            placeholder: `Comment on ${file.path}\u2026`,
            anchorLabel: composerAnchorLabel(descriptor.anchor),
            hint: "Comments collect in Your review and post together.",
            onSubmit: (body) => {
              onCreateComment?.(file.path, descriptor.anchor, body);
              setComposerAnchor(null);
            },
            onCancel: () => setComposerAnchor(null)
          }
        ) }),
        zone.domNode,
        zone.key
      );
    })
  ] });
}
var ReviewDiffEditor_default;
var init_ReviewDiffEditor = __esm({
  "src/renderer/canvas/ReviewDiffEditor.tsx"() {
    "use strict";
    init_editor();
    init_diffModel();
    init_annotationZones();
    init_AnnotationRibbon();
    init_CommentThread();
    init_CommentComposer();
    init_commentGutter();
    ReviewDiffEditor_default = ReviewDiffEditor;
  }
});

// src/shared/ipc.ts
var REVIEW_CHANNELS = {
  detectSource: "review:detect-source",
  ingestSource: "review:ingest-source",
  readChangeset: "review:read-changeset",
  readBrief: "review:read-brief",
  readState: "review:read-state",
  writeState: "review:write-state",
  list: "review:list",
  matchPrProject: "review:match-pr-project",
  probeChangeset: "review:probe-changeset",
  startBriefRun: "review:start-brief-run",
  stopBriefRun: "review:stop-brief-run",
  briefRunStatus: "review:brief-run-status",
  askGuide: "review:ask-guide",
  postReview: "review:post-review",
  listBranches: "review:list-branches"
};

// src/renderer/ipc.ts
var boundHost = null;
function bindHost(host) {
  boundHost = host;
}
function reviewHost() {
  if (!boundHost) {
    throw new Error("Reviews: the renderer host is not bound yet (registerRenderer has not run).");
  }
  return boundHost;
}
var REFUSAL_MESSAGE = {
  permission_missing: "Reviews is not allowed to talk to its own background half. Reinstall the extension so it can ask for the ipc:invoke permission again.",
  not_bridgeable: "Reviews asked for a channel the app will not route. The installed extension and the app are out of step \u2014 update one of them.",
  unknown_channel: "Reviews asked for a channel its background half never registered. The extension is only half loaded; restart the app."
};
function describeInvokeFailure(channel, error) {
  const code = error?.code;
  if (typeof code === "string" && code in REFUSAL_MESSAGE) {
    const refusal = new Error(`${REFUSAL_MESSAGE[code]} (${channel})`);
    refusal.code = code;
    return refusal;
  }
  if (error instanceof Error) return error;
  return new Error(String(error));
}
async function invoke(channel, payload) {
  try {
    return await reviewHost().invoke(channel, payload);
  } catch (error) {
    throw describeInvokeFailure(channel, error);
  }
}
function reviewDetectSource(input) {
  return invoke(REVIEW_CHANNELS.detectSource, input);
}
function reviewIngestSource(input, target) {
  return invoke(REVIEW_CHANNELS.ingestSource, { input, target });
}
function reviewReadChangeset(target) {
  return invoke(REVIEW_CHANNELS.readChangeset, target);
}
function reviewReadBrief(target) {
  return invoke(REVIEW_CHANNELS.readBrief, target);
}
function reviewProbeChangeset(input) {
  return invoke(REVIEW_CHANNELS.probeChangeset, input);
}
function reviewStartBriefRun(input) {
  return invoke(REVIEW_CHANNELS.startBriefRun, input);
}
function reviewStopBriefRun(target) {
  return invoke(REVIEW_CHANNELS.stopBriefRun, target);
}
async function reviewBriefRunStatus(target) {
  const result = await invoke(REVIEW_CHANNELS.briefRunStatus, target);
  return result.status;
}
function reviewAskGuide(input) {
  return invoke(REVIEW_CHANNELS.askGuide, input);
}
function reviewPostReview(input) {
  return invoke(REVIEW_CHANNELS.postReview, input);
}
function reviewReadState(target) {
  return invoke(REVIEW_CHANNELS.readState, target);
}
function reviewWriteState(payload) {
  return invoke(REVIEW_CHANNELS.writeState, payload);
}
function reviewList(roots) {
  return invoke(REVIEW_CHANNELS.list, { roots });
}
function reviewMatchPrProject(url, roots) {
  return invoke(REVIEW_CHANNELS.matchPrProject, { url, roots });
}
function reviewListBranches(projectRoot) {
  return invoke(REVIEW_CHANNELS.listBranches, { projectRoot });
}

// src/renderer/styles/review.css
var review_default = "/* The review-only rules, copied from the app's src/renderer/src/assets/index.css\n * (~line 3138-3183) and renamed `review-*` -> `mcrev-*` at extraction. A module's\n * class names share one global namespace with the app and every other module, so\n * they carry the module's own prefix; the JSX and the Monaco decorations that ask\n * for them were renamed with them.\n *\n * Token-only, and only what Tailwind cannot express: two Monaco decoration classes\n * (Monaco owns those elements, so there is no JSX to put a utility on) and one\n * keyframed pane entrance. Everything else the review surface draws is a utility.\n */\n\n/* Guide hover-tip lines: a dotted accent underline + help cursor. The hover\n   content rides a Monaco decoration hoverMessage, so no provider is needed. */\n.monaco-editor .mcrev-hint-line {\n  text-decoration: underline dotted var(--accent-primary);\n  text-underline-offset: 3px;\n  text-decoration-thickness: 1px;\n  cursor: help;\n}\n\n/* Comment gutter affordance: a small accent \"+\" on the hovered changed line. */\n.monaco-editor .mcrev-comment-glyph {\n  cursor: pointer;\n}\n.monaco-editor .mcrev-comment-glyph::before {\n  content: '+';\n  display: block;\n  text-align: center;\n  font-weight: 600;\n  color: var(--accent-primary);\n}\n\n/* Step-pane continuity: content fades and settles when the active pane changes,\n   never a hard swap. One easing, the normal duration, reduced-motion honored. */\n.mcrev-pane-enter {\n  animation: mcrev-pane-in var(--motion-normal) var(--motion-ease);\n}\n@keyframes mcrev-pane-in {\n  from {\n    opacity: 0;\n    transform: translateY(4px);\n  }\n  to {\n    opacity: 1;\n    transform: none;\n  }\n}\n@media (prefers-reduced-motion: reduce) {\n  .mcrev-pane-enter {\n    animation: none;\n  }\n}\n";

// src/renderer/styles/utilities.css
var utilities_default = `/*! tailwindcss v4.3.3 | MIT License | https://tailwindcss.com */
@layer properties{@supports (((-webkit-hyphens:none)) and (not (margin-trim:inline))) or ((-moz-orient:inline) and (not (color:rgb(from red r g b)))){*,:before,:after,::backdrop{--tw-rotate-x:initial;--tw-rotate-y:initial;--tw-rotate-z:initial;--tw-skew-x:initial;--tw-skew-y:initial;--tw-space-y-reverse:0;--tw-border-style:solid;--tw-leading:initial;--tw-font-weight:initial;--tw-tracking:initial;--tw-ordinal:initial;--tw-slashed-zero:initial;--tw-numeric-figure:initial;--tw-numeric-spacing:initial;--tw-numeric-fraction:initial;--tw-shadow:0 0 #0000;--tw-shadow-color:initial;--tw-shadow-alpha:100%;--tw-inset-shadow:0 0 #0000;--tw-inset-shadow-color:initial;--tw-inset-shadow-alpha:100%;--tw-ring-color:initial;--tw-ring-shadow:0 0 #0000;--tw-inset-ring-color:initial;--tw-inset-ring-shadow:0 0 #0000;--tw-ring-inset:initial;--tw-ring-offset-width:0px;--tw-ring-offset-color:#fff;--tw-ring-offset-shadow:0 0 #0000;--tw-outline-style:solid;--tw-blur:initial;--tw-brightness:initial;--tw-contrast:initial;--tw-grayscale:initial;--tw-hue-rotate:initial;--tw-invert:initial;--tw-opacity:initial;--tw-saturate:initial;--tw-sepia:initial;--tw-drop-shadow:initial;--tw-drop-shadow-color:initial;--tw-drop-shadow-alpha:100%;--tw-drop-shadow-size:initial;--tw-duration:initial;--tw-ease:initial;--tw-content:""}}}:root,:host{--text-micro:var(--text-size-2xs);--text-meta:var(--text-size-xs);--text-body:var(--text-size-sm);--text-heading:var(--text-size-md);--text-title:var(--text-size-lg);--spacing-icon-sm:var(--icon-sm)}@layer utilities{.\\@container{container-type:inline-size}.collapse{visibility:collapse}.invisible{visibility:hidden}.visible{visibility:visible}.sr-only{clip-path:inset(50%);white-space:nowrap;border-width:0;width:1px;height:1px;margin:-1px;padding:0;position:absolute;overflow:hidden}.absolute{position:absolute}.fixed{position:fixed}.relative{position:relative}.static{position:static}.container{width:100%}@media (min-width:40rem){.container{max-width:40rem}}@media (min-width:48rem){.container{max-width:48rem}}@media (min-width:64rem){.container{max-width:64rem}}@media (min-width:80rem){.container{max-width:80rem}}@media (min-width:96rem){.container{max-width:96rem}}.mt-0\\.5{margin-top:calc(var(--spacing,.25rem) * .5)}.mt-1{margin-top:var(--spacing,.25rem)}.mt-1\\.5{margin-top:calc(var(--spacing,.25rem) * 1.5)}.mt-2{margin-top:calc(var(--spacing,.25rem) * 2)}.mt-3{margin-top:calc(var(--spacing,.25rem) * 3)}.mt-auto{margin-top:auto}.mt-px{margin-top:1px}.mr-1{margin-right:var(--spacing,.25rem)}.mb-0\\.5{margin-bottom:calc(var(--spacing,.25rem) * .5)}.mb-1{margin-bottom:var(--spacing,.25rem)}.mb-1\\.5{margin-bottom:calc(var(--spacing,.25rem) * 1.5)}.mb-2{margin-bottom:calc(var(--spacing,.25rem) * 2)}.mb-2\\.5{margin-bottom:calc(var(--spacing,.25rem) * 2.5)}.mb-3{margin-bottom:calc(var(--spacing,.25rem) * 3)}.mb-4{margin-bottom:calc(var(--spacing,.25rem) * 4)}.mb-5{margin-bottom:calc(var(--spacing,.25rem) * 5)}.ml-2{margin-left:calc(var(--spacing,.25rem) * 2)}.ml-auto{margin-left:auto}.block{display:block}.contents{display:contents}.flex{display:flex}.grid{display:grid}.hidden{display:none}.inline{display:inline}.inline-block{display:inline-block}.inline-flex{display:inline-flex}.table{display:table}.size-icon-sm{width:var(--spacing-icon-sm);height:var(--spacing-icon-sm)}.icon-lg{width:var(--icon-lg);height:var(--icon-lg)}.icon-sm{width:var(--icon-sm);height:var(--icon-sm)}.icon-xs{width:var(--icon-xs);height:var(--icon-xs)}.h-\\[3px\\]{height:3px}.h-\\[19px\\]{height:19px}.h-\\[46px\\]{height:46px}.h-auto{height:auto}.h-full{height:100%}.min-h-0{min-height:0}.min-h-\\[38px\\]{min-height:38px}.min-h-\\[120px\\]{min-height:120px}.w-\\[19px\\]{width:19px}.w-full{width:100%}.max-w-2xl{max-width:var(--container-2xl,42rem)}.max-w-\\[66ch\\]{max-width:66ch}.max-w-\\[72ch\\]{max-width:72ch}.max-w-\\[76ch\\]{max-width:76ch}.max-w-\\[80ch\\]{max-width:80ch}.max-w-\\[560px\\]{max-width:560px}.max-w-\\[680px\\]{max-width:680px}.max-w-md{max-width:var(--container-md,28rem)}.max-w-xl{max-width:var(--container-xl,36rem)}.min-w-0{min-width:0}.flex-1{flex:1}.shrink-0{flex-shrink:0}.grow{flex-grow:1}.transform{transform:var(--tw-rotate-x,) var(--tw-rotate-y,) var(--tw-rotate-z,) var(--tw-skew-x,) var(--tw-skew-y,)}.cursor-pointer{cursor:pointer}.resize{resize:both}.grid-cols-\\[210px_minmax\\(0\\,1fr\\)\\]{grid-template-columns:210px minmax(0,1fr)}.flex-col{flex-direction:column}.flex-wrap{flex-wrap:wrap}.items-baseline{align-items:baseline}.items-center{align-items:center}.items-start{align-items:flex-start}.justify-between{justify-content:space-between}.justify-center{justify-content:center}.justify-end{justify-content:flex-end}.gap-1{gap:var(--spacing,.25rem)}.gap-1\\.5{gap:calc(var(--spacing,.25rem) * 1.5)}.gap-2{gap:calc(var(--spacing,.25rem) * 2)}.gap-2\\.5{gap:calc(var(--spacing,.25rem) * 2.5)}.gap-3{gap:calc(var(--spacing,.25rem) * 3)}:where(.space-y-4>:not(:last-child)){--tw-space-y-reverse:0;margin-block-start:calc(calc(var(--spacing,.25rem) * 4) * var(--tw-space-y-reverse));margin-block-end:calc(calc(var(--spacing,.25rem) * 4) * calc(1 - var(--tw-space-y-reverse)))}.gap-x-4{column-gap:calc(var(--spacing,.25rem) * 4)}.gap-y-1{row-gap:var(--spacing,.25rem)}.truncate{text-overflow:ellipsis;white-space:nowrap;overflow:hidden}.overflow-hidden{overflow:hidden}.overflow-x-auto{overflow-x:auto}.overflow-y-auto{overflow-y:auto}.rounded-\\[6px\\]{border-radius:6px}.rounded-full{border-radius:3.40282e38px}.rounded-md{border-radius:var(--radius-md,.375rem)}.rounded-sm{border-radius:var(--radius-sm,.25rem)}.rounded-xs{border-radius:var(--radius-xs,.125rem)}.border{border-style:var(--tw-border-style);border-width:1px}.border-t{border-top-style:var(--tw-border-style);border-top-width:1px}.border-r{border-right-style:var(--tw-border-style);border-right-width:1px}.border-b{border-bottom-style:var(--tw-border-style);border-bottom-width:1px}.border-l{border-left-style:var(--tw-border-style);border-left-width:1px}.border-\\[color\\:var\\(--border-default\\)\\]{border-color:var(--border-default)}.border-\\[color\\:var\\(--border-strong\\)\\]{border-color:var(--border-strong)}.border-\\[color\\:var\\(--border-subtle\\)\\]{border-color:var(--border-subtle)}.bg-\\[color\\:var\\(--accent-primary\\)\\]{background-color:var(--accent-primary)}.bg-\\[color\\:var\\(--accent-primary-soft-strong\\)\\]{background-color:var(--accent-primary-soft-strong)}.bg-\\[color\\:var\\(--bg-active\\)\\]{background-color:var(--bg-active)}.bg-\\[color\\:var\\(--bg-hover\\)\\]{background-color:var(--bg-hover)}.bg-\\[color\\:var\\(--bg-surface\\)\\]{background-color:var(--bg-surface)}.bg-\\[color\\:var\\(--bg-surface-raised\\)\\]{background-color:var(--bg-surface-raised)}.\\[fill\\:var\\(--bg-hover\\)\\]{fill:var(--bg-hover)}.\\[fill\\:var\\(--bg-surface\\)\\]{fill:var(--bg-surface)}.\\[fill\\:var\\(--border-strong\\)\\]{fill:var(--border-strong)}.\\[fill\\:var\\(--text-muted\\)\\]{fill:var(--text-muted)}.\\[fill\\:var\\(--text-strong\\)\\]{fill:var(--text-strong)}.\\[fill\\:var\\(--text-subtle\\)\\]{fill:var(--text-subtle)}.\\[stroke\\:var\\(--border-default\\)\\]{stroke:var(--border-default)}.\\[stroke\\:var\\(--border-strong\\)\\]{stroke:var(--border-strong)}.px-1{padding-inline:var(--spacing,.25rem)}.px-3{padding-inline:calc(var(--spacing,.25rem) * 3)}.px-4{padding-inline:calc(var(--spacing,.25rem) * 4)}.px-5{padding-inline:calc(var(--spacing,.25rem) * 5)}.px-6{padding-inline:calc(var(--spacing,.25rem) * 6)}.py-1\\.5{padding-block:calc(var(--spacing,.25rem) * 1.5)}.py-2{padding-block:calc(var(--spacing,.25rem) * 2)}.py-2\\.5{padding-block:calc(var(--spacing,.25rem) * 2.5)}.py-3{padding-block:calc(var(--spacing,.25rem) * 3)}.py-4{padding-block:calc(var(--spacing,.25rem) * 4)}.py-5{padding-block:calc(var(--spacing,.25rem) * 5)}.py-6{padding-block:calc(var(--spacing,.25rem) * 6)}.pt-1{padding-top:var(--spacing,.25rem)}.pt-3{padding-top:calc(var(--spacing,.25rem) * 3)}.pr-4{padding-right:calc(var(--spacing,.25rem) * 4)}.pb-2\\.5{padding-bottom:calc(var(--spacing,.25rem) * 2.5)}.pl-\\[55px\\]{padding-left:55px}.align-\\[-1px\\]{vertical-align:-1px}.font-mono{font-family:var(--font-mono,ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace)}.text-body{font-size:var(--text-body)}.text-heading{font-size:var(--text-heading)}.text-meta{font-size:var(--text-meta)}.text-micro{font-size:var(--text-micro)}.text-title{font-size:var(--text-title)}.leading-4{--tw-leading:calc(var(--spacing,.25rem) * 4);line-height:calc(var(--spacing,.25rem) * 4)}.leading-5{--tw-leading:calc(var(--spacing,.25rem) * 5);line-height:calc(var(--spacing,.25rem) * 5)}.leading-6{--tw-leading:calc(var(--spacing,.25rem) * 6);line-height:calc(var(--spacing,.25rem) * 6)}.leading-\\[1\\.55\\]{--tw-leading:1.55;line-height:1.55}.leading-tight{--tw-leading:var(--leading-tight,1.25);line-height:var(--leading-tight,1.25)}.font-medium{--tw-font-weight:var(--font-weight-medium,500);font-weight:var(--font-weight-medium,500)}.font-semibold{--tw-font-weight:var(--font-weight-semibold,600);font-weight:var(--font-weight-semibold,600)}.tracking-tight{--tw-tracking:var(--tracking-tight,-.025em);letter-spacing:var(--tracking-tight,-.025em)}.whitespace-pre-wrap{white-space:pre-wrap}.text-\\[color\\:var\\(--accent-primary\\)\\]{color:var(--accent-primary)}.text-\\[color\\:var\\(--text-default\\)\\]{color:var(--text-default)}.text-\\[color\\:var\\(--text-muted\\)\\]{color:var(--text-muted)}.text-\\[color\\:var\\(--text-on-accent\\)\\]{color:var(--text-on-accent)}.text-\\[color\\:var\\(--text-strong\\)\\]{color:var(--text-strong)}.text-\\[color\\:var\\(--text-subtle\\)\\]{color:var(--text-subtle)}.text-\\[color\\:var\\(--tone-error\\)\\]{color:var(--tone-error)}.text-\\[color\\:var\\(--tone-good\\)\\]{color:var(--tone-good)}.tabular-nums{--tw-numeric-spacing:tabular-nums;font-variant-numeric:var(--tw-ordinal,) var(--tw-slashed-zero,) var(--tw-numeric-figure,) var(--tw-numeric-spacing,) var(--tw-numeric-fraction,)}.underline{text-decoration-line:underline}.ring{--tw-ring-shadow:var(--tw-ring-inset,) 0 0 0 calc(1px + var(--tw-ring-offset-width)) var(--tw-ring-color,currentcolor);box-shadow:var(--tw-inset-shadow), var(--tw-inset-ring-shadow), var(--tw-ring-offset-shadow), var(--tw-ring-shadow), var(--tw-shadow)}.outline{outline-style:var(--tw-outline-style);outline-width:1px}.filter{filter:var(--tw-blur,) var(--tw-brightness,) var(--tw-contrast,) var(--tw-grayscale,) var(--tw-hue-rotate,) var(--tw-invert,) var(--tw-saturate,) var(--tw-sepia,) var(--tw-drop-shadow,)}.transition-\\[fill\\,stroke\\]{transition-property:fill,stroke;transition-timing-function:var(--tw-ease,var(--default-transition-timing-function,cubic-bezier(.4, 0, .2, 1)));transition-duration:var(--tw-duration,var(--default-transition-duration,.15s))}.transition-\\[width\\]{transition-property:width;transition-timing-function:var(--tw-ease,var(--default-transition-timing-function,cubic-bezier(.4, 0, .2, 1)));transition-duration:var(--tw-duration,var(--default-transition-duration,.15s))}.transition-transform{transition-property:transform,translate,scale,rotate;transition-timing-function:var(--tw-ease,var(--default-transition-timing-function,cubic-bezier(.4, 0, .2, 1)));transition-duration:var(--tw-duration,var(--default-transition-duration,.15s))}.duration-\\[var\\(--motion-deliberate\\)\\]{--tw-duration:var(--motion-deliberate);transition-duration:var(--motion-deliberate)}.duration-\\[var\\(--motion-fast\\)\\]{--tw-duration:var(--motion-fast);transition-duration:var(--motion-fast)}.ease-\\[var\\(--motion-ease\\)\\]{--tw-ease:var(--motion-ease);transition-timing-function:var(--motion-ease)}.select-all{-webkit-user-select:all;user-select:all}@media (hover:hover){.group-hover\\:\\[fill\\:var\\(--accent-primary-soft\\)\\]:is(:where(.group):hover *){fill:var(--accent-primary-soft)}.group-hover\\:\\[stroke\\:var\\(--accent-primary\\)\\]:is(:where(.group):hover *){stroke:var(--accent-primary)}}.before\\:absolute:before{content:var(--tw-content);position:absolute}.before\\:top-3\\.5:before{content:var(--tw-content);top:calc(var(--spacing,.25rem) * 3.5)}.before\\:bottom-3\\.5:before{content:var(--tw-content);bottom:calc(var(--spacing,.25rem) * 3.5)}.before\\:left-\\[18px\\]:before{content:var(--tw-content);left:18px}.before\\:w-px:before{content:var(--tw-content);width:1px}.before\\:bg-\\[color\\:var\\(--border-subtle\\)\\]:before{content:var(--tw-content);background-color:var(--border-subtle)}.before\\:content-\\[\\'\\'\\]:before{--tw-content:"";content:var(--tw-content)}.last\\:border-b-0:last-child{border-bottom-style:var(--tw-border-style);border-bottom-width:0}.focus-visible\\:focus-ring:focus-visible{outline:var(--focus-ring);outline-offset:var(--focus-ring-offset)}.focus-visible\\:focus-ring-inset:focus-visible{outline:var(--focus-ring);outline-offset:calc(-1 * var(--focus-ring-offset))}@media (prefers-reduced-motion:reduce){.motion-reduce\\:transition-none{transition-property:none}}@container (min-width:940px){.\\@\\[940px\\]\\:block{display:block}.\\@\\[940px\\]\\:grid-cols-\\[244px_minmax\\(0\\,1fr\\)_276px\\]{grid-template-columns:244px minmax(0,1fr) 276px}}}@property --tw-rotate-x{syntax:"*";inherits:false}@property --tw-rotate-y{syntax:"*";inherits:false}@property --tw-rotate-z{syntax:"*";inherits:false}@property --tw-skew-x{syntax:"*";inherits:false}@property --tw-skew-y{syntax:"*";inherits:false}@property --tw-space-y-reverse{syntax:"*";inherits:false;initial-value:0}@property --tw-border-style{syntax:"*";inherits:false;initial-value:solid}@property --tw-leading{syntax:"*";inherits:false}@property --tw-font-weight{syntax:"*";inherits:false}@property --tw-tracking{syntax:"*";inherits:false}@property --tw-ordinal{syntax:"*";inherits:false}@property --tw-slashed-zero{syntax:"*";inherits:false}@property --tw-numeric-figure{syntax:"*";inherits:false}@property --tw-numeric-spacing{syntax:"*";inherits:false}@property --tw-numeric-fraction{syntax:"*";inherits:false}@property --tw-shadow{syntax:"*";inherits:false;initial-value:0 0 #0000}@property --tw-shadow-color{syntax:"*";inherits:false}@property --tw-shadow-alpha{syntax:"<percentage>";inherits:false;initial-value:100%}@property --tw-inset-shadow{syntax:"*";inherits:false;initial-value:0 0 #0000}@property --tw-inset-shadow-color{syntax:"*";inherits:false}@property --tw-inset-shadow-alpha{syntax:"<percentage>";inherits:false;initial-value:100%}@property --tw-ring-color{syntax:"*";inherits:false}@property --tw-ring-shadow{syntax:"*";inherits:false;initial-value:0 0 #0000}@property --tw-inset-ring-color{syntax:"*";inherits:false}@property --tw-inset-ring-shadow{syntax:"*";inherits:false;initial-value:0 0 #0000}@property --tw-ring-inset{syntax:"*";inherits:false}@property --tw-ring-offset-width{syntax:"<length>";inherits:false;initial-value:0}@property --tw-ring-offset-color{syntax:"*";inherits:false;initial-value:#fff}@property --tw-ring-offset-shadow{syntax:"*";inherits:false;initial-value:0 0 #0000}@property --tw-outline-style{syntax:"*";inherits:false;initial-value:solid}@property --tw-blur{syntax:"*";inherits:false}@property --tw-brightness{syntax:"*";inherits:false}@property --tw-contrast{syntax:"*";inherits:false}@property --tw-grayscale{syntax:"*";inherits:false}@property --tw-hue-rotate{syntax:"*";inherits:false}@property --tw-invert{syntax:"*";inherits:false}@property --tw-opacity{syntax:"*";inherits:false}@property --tw-saturate{syntax:"*";inherits:false}@property --tw-sepia{syntax:"*";inherits:false}@property --tw-drop-shadow{syntax:"*";inherits:false}@property --tw-drop-shadow-color{syntax:"*";inherits:false}@property --tw-drop-shadow-alpha{syntax:"<percentage>";inherits:false;initial-value:100%}@property --tw-drop-shadow-size{syntax:"*";inherits:false}@property --tw-duration{syntax:"*";inherits:false}@property --tw-ease{syntax:"*";inherits:false}@property --tw-content{syntax:"*";inherits:false;initial-value:""}`;

// src/renderer/styles/inject.ts
var STYLE_MARKER = "review";
var injected = false;
function injectReviewStyles() {
  if (injected || typeof document === "undefined") return;
  injected = true;
  if (document.querySelector(`style[data-module="${STYLE_MARKER}"]`)) return;
  const style = document.createElement("style");
  style.setAttribute("data-module", STYLE_MARKER);
  style.textContent = `${utilities_default}
${review_default}`;
  document.head.appendChild(style);
}

// src/renderer/app/ReviewsGlyph.tsx
import { jsx, jsxs } from "react/jsx-runtime";
function ReviewsGlyph({ className }) {
  return /* @__PURE__ */ jsxs("svg", { viewBox: "0 0 16 16", fill: "none", className, "aria-hidden": "true", children: [
    /* @__PURE__ */ jsx("path", { d: "M2 8s2.2-4 6-4 6 4 6 4-2.2 4-6 4-6-4-6-4Z", stroke: "currentColor", strokeWidth: "1.3" }),
    /* @__PURE__ */ jsx("circle", { cx: "8", cy: "8", r: "1.8", stroke: "currentColor", strokeWidth: "1.3" })
  ] });
}

// src/renderer/door/ReviewsGlobalSurface.tsx
import { useCallback as useCallback9, useEffect as useEffect10, useMemo as useMemo8, useRef as useRef10, useState as useState13 } from "react";

// src/renderer/app/host-hooks.ts
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
function useMonacoBaseTheme() {
  const [scheme, setScheme] = useState("dark");
  useEffect(() => reviewHost().watchColorScheme(setScheme), []);
  return scheme === "light" ? "vs" : "vs-dark";
}
function useReviewProjectRoots() {
  const [roots, setRoots] = useState([]);
  const previous = useRef("[]");
  useEffect(() => {
    const apply = (workspaces) => {
      const next = distinctRoots(workspaces);
      const key = JSON.stringify(next);
      if (key === previous.current) return;
      previous.current = key;
      setRoots(next);
    };
    void reviewHost().listWorkspaces().then(apply).catch(() => void 0);
    return reviewHost().watchWorkspaces(apply);
  }, []);
  return roots;
}
function distinctRoots(workspaces) {
  const roots = /* @__PURE__ */ new Set();
  for (const workspace of workspaces) {
    if (workspace.folderPath) roots.add(workspace.folderPath);
  }
  return [...roots];
}
var NO_SESSIONS = [];
function useReviewAgentSessions() {
  const [sessions, setSessions] = useState(NO_SESSIONS);
  useEffect(() => {
    try {
      return reviewHost().watchAgentSessions(void 0, setSessions);
    } catch {
      return void 0;
    }
  }, []);
  return sessions;
}
function useRawModuleAppState(key) {
  const subscribe = useCallback((onChange) => reviewHost().watchModuleAppState(onChange), []);
  const getSnapshot = useCallback(() => reviewHost().getModuleAppState(key), [key]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
function useAgentRuntimes() {
  const [runtimes, setRuntimes] = useState([]);
  useEffect(() => {
    try {
      setRuntimes(
        reviewHost().listAgentRuntimes().filter((runtime) => runtime.available).map((runtime) => ({
          value: runtime.id,
          label: runtime.label,
          isDefault: runtime.isDefault,
          modelSelection: { options: runtime.models.map((model) => ({ id: model.id, label: model.label })), allowCustomId: false }
        }))
      );
    } catch {
      setRuntimes([]);
    }
  }, []);
  return runtimes;
}
function resolveRuntime(picked, runtimes) {
  if (picked && runtimes.some((runtime) => runtime.value === picked)) return picked;
  return runtimes.find((runtime) => runtime.isDefault)?.value ?? runtimes[0]?.value ?? "";
}

// src/renderer/door/ReviewsGlobalSurface.tsx
import { PrimaryButton as PrimaryButton6 } from "@sprintengine/module-sdk/ui";

// src/renderer/canvas/useReviewSession.ts
import { useCallback as useCallback3, useEffect as useEffect3, useMemo as useMemo2, useRef as useRef3, useState as useState3 } from "react";

// src/shared/brief.ts
var BRIEF_SCHEMA_VERSION = 1;

// src/shared/brief-run-events.ts
var BRIEF_RUN_EVENT_TOPIC = "brief-run";

// src/renderer/canvas/useReviewSession.ts
init_commentModel();

// src/renderer/canvas/reviewSelectors.ts
var OVERVIEW_PANE_ID = "overview";
function orderedSteps(brief) {
  return brief.steps.map((step, index) => ({ step, index })).sort((a, b) => a.step.order - b.step.order || a.index - b.index).map((entry) => entry.step);
}
function stepMetaLabel(fileCount, noteCount) {
  const files = `${fileCount} ${fileCount === 1 ? "file" : "files"}`;
  if (noteCount === 0) return files;
  return `${files} \xB7 ${noteCount} ${noteCount === 1 ? "note" : "notes"}`;
}
function buildRailModel(changeset, brief, readFiles) {
  const steps = orderedSteps(brief);
  const stepViews = steps.map((step, i) => {
    const fileCount = step.files.length;
    const read = fileCount > 0 && step.files.every((file) => readFiles.has(file.path));
    return {
      step,
      index: i + 1,
      read,
      fileCount,
      noteCount: step.annotations.length,
      metaLabel: stepMetaLabel(fileCount, step.annotations.length)
    };
  });
  const totalFiles = changeset.files.length;
  const changedPaths = new Set(changeset.files.map((file) => file.path));
  let readCount = 0;
  for (const path of readFiles) if (changedPaths.has(path)) readCount += 1;
  const continueStep = stepViews.find((view) => !view.read);
  return {
    steps: stepViews,
    totalFiles,
    readFiles: readCount,
    progressLabel: `${readCount} of ${totalFiles} ${totalFiles === 1 ? "file" : "files"} read`,
    meterFraction: totalFiles === 0 ? 0 : Math.min(1, readCount / totalFiles),
    continueStepId: continueStep ? continueStep.step.id : null,
    continueLabel: continueStep ? `Continue with step ${continueStep.index}` : null
  };
}
function resolveActivePaneId(brief, state) {
  const steps = orderedSteps(brief);
  const stepIds = new Set(steps.map((step) => step.id));
  const persisted = state?.activeStepId;
  if (persisted === OVERVIEW_PANE_ID || persisted && stepIds.has(persisted)) return persisted;
  return steps.length > 0 ? steps[0].id : OVERVIEW_PANE_ID;
}
function sourceIdentity(changeset) {
  const { source } = changeset;
  let base;
  if (source.kind === "pull-request") {
    base = `${source.owner}/${source.repo} #${source.number}`;
  } else if (source.kind === "branch") {
    base = `${changeset.headRef ?? source.headRef} \u2192 ${changeset.baseRef}`;
  } else {
    base = source.label ?? "Pasted patch";
  }
  const sha = changeset.headSha ? changeset.headSha.slice(0, 7) : null;
  return sha ? `${base} \xB7 ${sha}` : base;
}
function statsChip(changeset) {
  return {
    files: changeset.stats.files,
    additions: changeset.stats.additions,
    deletions: changeset.stats.deletions
  };
}
function fileWhyLine(why, readingNote) {
  if (readingNote === "mechanical-skim") return `${why} \u2014 mechanical mirror, safe to skim`;
  return why;
}

// src/renderer/canvas/freshness.ts
function changeSetFileSignature(file) {
  const hunks = file.hunks.map(
    (hunk) => `@${hunk.oldStart},${hunk.oldLines},${hunk.newStart},${hunk.newLines}
` + hunk.lines.map((line) => `${line.kind[0]} ${line.text}`).join("\n")
  ).join("\n~~\n");
  return `${file.status}|${file.oldPath ?? ""}|${file.binary ? "b" : "t"}|${hunks}`;
}
function changedPathSet(oldCs, newCs) {
  const oldSig = new Map(oldCs.files.map((file) => [file.path, changeSetFileSignature(file)]));
  const newSig = new Map(newCs.files.map((file) => [file.path, changeSetFileSignature(file)]));
  const changed = /* @__PURE__ */ new Set();
  for (const [path, signature] of newSig) {
    if (oldSig.get(path) !== signature) changed.add(path);
  }
  for (const path of oldSig.keys()) {
    if (!newSig.has(path)) changed.add(path);
  }
  return changed;
}
function computeFreshness(oldCs, newCs, brief) {
  const oldHeadSha = brief.headSha ?? oldCs.headSha;
  const newHeadSha = newCs.headSha;
  const headMoved = Boolean(oldHeadSha && newHeadSha && oldHeadSha !== newHeadSha);
  const changed = changedPathSet(oldCs, newCs);
  const affectedStepIds = [];
  const unaffectedStepIds = [];
  for (const step of orderedSteps(brief)) {
    const isAffected = step.files.some((file) => changed.has(file.path));
    (isAffected ? affectedStepIds : unaffectedStepIds).push(step.id);
  }
  return {
    headMoved,
    oldHeadSha,
    newHeadSha,
    affectedStepIds,
    unaffectedStepIds,
    changedPaths: [...changed]
  };
}
function migrateReviewState(prev, oldCs, newCs) {
  const oldSig = new Map(oldCs.files.map((file) => [file.path, changeSetFileSignature(file)]));
  const newSig = new Map(newCs.files.map((file) => [file.path, changeSetFileSignature(file)]));
  const isUnchanged = (path) => newSig.has(path) && oldSig.get(path) === newSig.get(path);
  const readFiles = prev.readFiles.filter(isUnchanged);
  const comments = prev.comments.map((comment) => {
    if (isUnchanged(comment.path)) {
      if (comment.anchorStatus === void 0) return comment;
      const { anchorStatus: _dropped, ...anchored } = comment;
      return anchored;
    }
    return { ...comment, anchorStatus: "moved" };
  });
  return { ...prev, changeSetId: newCs.id, readFiles, comments };
}
function shortSha(sha) {
  return sha ? sha.slice(0, 7) : void 0;
}
function stepNumbers(brief, stepIds) {
  const order = new Map(orderedSteps(brief).map((step, index) => [step.id, index + 1]));
  return stepIds.map((id) => order.get(id)).filter((n) => n !== void 0).sort((a, b) => a - b);
}
function joinNumbers(numbers) {
  return numbers.join(", ");
}
var SOURCE_MOVED_LEAD = {
  branch: "Branch moved.",
  "pull-request": "New commits on this pull request.",
  patch: ""
};
function buildStaleBanner(source, brief, freshness) {
  const unchanged = stepNumbers(brief, freshness.unaffectedStepIds);
  const affected = stepNumbers(brief, freshness.affectedStepIds);
  const clauses = [];
  if (unchanged.length > 0) {
    clauses.push(`${unchanged.length === 1 ? "step" : "steps"} ${joinNumbers(unchanged)} unchanged`);
  }
  if (affected.length > 0) {
    clauses.push(`${affected.length === 1 ? "step" : "steps"} ${joinNumbers(affected)} ${affected.length === 1 ? "needs" : "need"} a refresh`);
  }
  const oldSha = shortSha(freshness.oldHeadSha);
  const newSha = shortSha(freshness.newHeadSha);
  const move = oldSha && newSha ? `(${oldSha} \u2192 ${newSha})` : "";
  const detail = clauses.length > 0 ? `${move} \u2014 ${clauses.join(", ")}.` : `${move} \u2014 refresh to regenerate the walkthrough.`.trim();
  return {
    tone: "stale",
    lead: SOURCE_MOVED_LEAD[source.kind],
    detail: detail.trim(),
    oldSha: freshness.oldHeadSha,
    newSha: freshness.newHeadSha,
    refreshable: true
  };
}
function buildCurrentBanner(newHeadSha, brief, refreshedStepIds) {
  const sha = shortSha(newHeadSha);
  const refreshed = stepNumbers(brief, refreshedStepIds);
  const stepClause = refreshed.length === 0 ? "nothing needed regenerating" : `${refreshed.length === 1 ? "step" : "steps"} ${joinNumbers(refreshed)} refreshed`;
  const withSha = sha ? `current with ${sha}` : "current";
  return {
    tone: "current",
    lead: "",
    detail: `Walkthrough is ${withSha} \u2014 ${stepClause}; your read progress and pending comments were kept.`,
    newSha: newHeadSha,
    refreshable: false
  };
}
function reconstructSourceInput(changeset) {
  const source = changeset.source;
  if (source.kind === "branch") {
    return { kind: "branch", repoRoot: source.repoRoot, baseRef: source.baseRef, headRef: source.headRef };
  }
  if (source.kind === "pull-request") {
    return { kind: "pull-request", url: source.url };
  }
  return null;
}
function sourceCanGoStale(changeset) {
  return changeset.source.kind !== "patch";
}
var FRESHNESS_PROBE_MIN_INTERVAL_MS = 6e4;
function shouldProbePullRequest(nowMs, lastProbeAtMs, visible) {
  if (!visible) return false;
  if (lastProbeAtMs === null) return true;
  return nowMs - lastProbeAtMs >= FRESHNESS_PROBE_MIN_INTERVAL_MS;
}

// src/renderer/canvas/degradedBrief.ts
var DEGRADED_WHY = "Changed in this review";
var SINGLE_STEP_MAX_FILES = 8;
function byPath(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}
function topLevelDir(path) {
  const slash = path.indexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}
function stepFiles(files) {
  return files.map((file) => ({ path: file.path, why: DEGRADED_WHY }));
}
function buildSteps(sortedFiles) {
  if (sortedFiles.length <= SINGLE_STEP_MAX_FILES) {
    return [
      {
        id: "degraded-all",
        order: 0,
        title: "All files",
        narrative: "Every file in this change, in path order. No guide has grouped or explained them yet.",
        files: stepFiles(sortedFiles),
        annotations: []
      }
    ];
  }
  const groups = /* @__PURE__ */ new Map();
  for (const file of sortedFiles) {
    const dir = topLevelDir(file.path);
    const bucket = groups.get(dir);
    if (bucket) bucket.push(file);
    else groups.set(dir, [file]);
  }
  return [...groups.keys()].sort(byPath).map((dir, index) => ({
    id: `degraded-${index}`,
    order: index,
    title: dir === "" ? "Repository root" : dir,
    narrative: dir === "" ? "Files at the repository root." : `Files changed under ${dir}, in path order.`,
    files: stepFiles(groups.get(dir)),
    annotations: []
  }));
}
function synthesizeDegradedBrief(changeset) {
  const sortedFiles = [...changeset.files].sort((a, b) => byPath(a.path, b.path));
  const steps = buildSteps(sortedFiles);
  const { files, additions, deletions } = changeset.stats;
  return {
    schemaVersion: BRIEF_SCHEMA_VERSION,
    changeSetId: changeset.id,
    headSha: changeset.headSha,
    // Deterministic and honest: the change's own fetch time, so a re-fetch never
    // reads as a fresher walkthrough. Kept purely in memory regardless.
    generatedAt: changeset.fetchedAt,
    overview: {
      intent: "No guide walkthrough has been prepared yet. These files are the raw change, grouped by folder so you can read them in order.",
      blastRadius: `${files} ${files === 1 ? "file" : "files"} changed, +${additions} \u2212${deletions}.`,
      readingGuide: "Read each file below and comment as you go. Prepare a walkthrough to add guided ordering and the guide\u2019s notes."
      // No complexity (MC-1815). It is the guide's reading-effort judgment, and no
      // guide has judged this change. It used to be hardcoded 'low', which labelled
      // a 300-file degraded review "Complexity low" wherever the walkthrough's own
      // top bar renders. Deriving one from changeset size would be the same defect
      // with arithmetic: the degraded model's whole contract is that it invents no
      // judgment, and a size-derived complexity is a judgment.
    },
    steps,
    knowledgeRefs: [],
    coverage: {
      // Every file is assigned to a step, so nothing is uncovered and nothing is
      // double-assigned — the two invariants the cross-check enforces.
      assignedPaths: sortedFiles.map((file) => file.path),
      unassignedPaths: []
    }
  };
}

// src/renderer/canvas/useReviewFreshness.ts
import { useCallback as useCallback2, useEffect as useEffect2, useRef as useRef2, useState as useState2 } from "react";
function useReviewFreshness(changeset, brief) {
  const [freshness, setFreshness] = useState2(null);
  const probingRef = useRef2(false);
  const lastProbeAtRef = useRef2(null);
  const probe = useCallback2(async () => {
    if (!changeset || !brief || !sourceCanGoStale(changeset)) return;
    const input = reconstructSourceInput(changeset);
    if (!input || probingRef.current) return;
    probingRef.current = true;
    lastProbeAtRef.current = Date.now();
    try {
      const result = await reviewProbeChangeset(input);
      if (!result.ok) return;
      const verdict = computeFreshness(changeset, result.changeset, brief);
      setFreshness(verdict.headMoved ? { result: verdict, probedChangeset: result.changeset } : null);
    } catch {
    } finally {
      probingRef.current = false;
    }
  }, [changeset, brief]);
  useEffect2(() => {
    setFreshness(null);
    lastProbeAtRef.current = null;
  }, [changeset?.id, brief?.changeSetId]);
  useEffect2(() => {
    if (!brief || !changeset || !sourceCanGoStale(changeset)) return;
    const check = () => {
      if (shouldProbePullRequest(Date.now(), lastProbeAtRef.current, !document.hidden)) void probe();
    };
    check();
    document.addEventListener("visibilitychange", check);
    return () => document.removeEventListener("visibilitychange", check);
  }, [changeset, brief, probe]);
  return freshness;
}

// src/renderer/canvas/useReviewSession.ts
init_anchorLabel();
function defaultReviewState(changeSetId) {
  return { schemaVersion: 1, changeSetId, readFiles: [], diffView: "side-by-side", comments: [] };
}
var IDLE_RUN = { running: false, phase: null, error: null };
function runFromStatus(status) {
  if (status.running) return { running: true, phase: status.phase, detail: status.detail, error: null };
  if (status.phase === "failed") {
    return { running: false, phase: "failed", error: status.detail ?? "The guide could not finish." };
  }
  return { running: false, phase: status.phase, detail: status.detail, error: null };
}
function useReviewSession({
  reviewId,
  workspaceRoot,
  depth,
  guideCli,
  guideModel,
  workspaceId
}) {
  const monacoTheme = useMonacoBaseTheme();
  const [storedState, setStoredState] = useState3(null);
  const [stateLoaded, setStateLoaded] = useState3(false);
  const [changesetLoad, setChangesetLoad] = useState3({ phase: "loading" });
  const [briefLoad, setBriefLoad] = useState3({ phase: "idle" });
  const [run, setRun] = useState3(IDLE_RUN);
  const [guide, setGuide] = useState3(null);
  const [settle, setSettle] = useState3(null);
  const [postState, setPostState] = useState3({ phase: "idle" });
  const refreshInFlightRef = useRef3(false);
  const runRef = useRef3(run);
  const applyRun = useCallback3((next) => {
    runRef.current = next;
    setRun(next);
  }, []);
  const pendingSettleRef = useRef3(null);
  const [trayOpen, setTrayOpen] = useState3(false);
  const [askOpen, setAskOpen] = useState3(false);
  const [askPrefill, setAskPrefill] = useState3(void 0);
  const prefillNonce = useRef3(0);
  const target = useMemo2(
    () => reviewId && workspaceRoot ? { workspaceRoot, workspaceId: reviewId } : null,
    [reviewId, workspaceRoot]
  );
  const persistReviewState = useCallback3(
    (next) => {
      setStoredState(next);
      if (target) void reviewWriteState({ target, state: next });
    },
    [target]
  );
  useEffect3(() => {
    setChangesetLoad(target ? { phase: "loading" } : { phase: "ready", changeset: null });
    setBriefLoad({ phase: "idle" });
    applyRun(IDLE_RUN);
    setGuide(null);
    pendingSettleRef.current = null;
    setSettle(null);
    setPostState({ phase: "idle" });
    setTrayOpen(false);
    setAskOpen(false);
    setAskPrefill(void 0);
  }, [target, applyRun]);
  useEffect3(() => {
    if (!target) return;
    let cancelled = false;
    void (async () => {
      try {
        const status2 = await reviewBriefRunStatus(target);
        if (cancelled || !status2 || runRef.current.running) return;
        applyRun(runFromStatus(status2));
      } catch {
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [target, applyRun]);
  useEffect3(() => {
    if (!target) {
      setStoredState(null);
      setStateLoaded(true);
      return;
    }
    let cancelled = false;
    setStateLoaded(false);
    void (async () => {
      try {
        const result = await reviewReadState(target);
        if (cancelled) return;
        setStoredState(result.ok ? result.state : null);
      } catch {
        if (!cancelled) setStoredState(null);
      } finally {
        if (!cancelled) setStateLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [target]);
  const loadChangeset = useCallback3(async () => {
    if (!target) return null;
    setChangesetLoad({ phase: "loading" });
    try {
      const result = await reviewReadChangeset(target);
      if (result.ok) {
        setChangesetLoad({ phase: "ready", changeset: result.changeset });
        return result.changeset;
      }
      setChangesetLoad({ phase: "error", message: result.error });
    } catch (error) {
      setChangesetLoad({ phase: "error", message: error instanceof Error ? error.message : String(error) });
    }
    return null;
  }, [target]);
  const loadBrief = useCallback3(async () => {
    if (!target) return;
    setBriefLoad({ phase: "loading" });
    try {
      const result = await reviewReadBrief(target);
      if (!result.ok) setBriefLoad({ phase: "invalid", errors: result.error });
      else if (result.brief === null) setBriefLoad({ phase: "absent" });
      else setBriefLoad({ phase: "ready", brief: result.brief });
    } catch (error) {
      setBriefLoad({ phase: "invalid", errors: error instanceof Error ? error.message : String(error) });
    }
  }, [target]);
  useEffect3(() => {
    if (!target) return;
    let cancelled = false;
    void (async () => {
      const changeset2 = await loadChangeset();
      if (cancelled || !changeset2) return;
      await loadBrief();
    })();
    return () => {
      cancelled = true;
    };
  }, [target, loadChangeset, loadBrief]);
  useEffect3(() => {
    if (!reviewId) return;
    const off = reviewHost().subscribe(BRIEF_RUN_EVENT_TOPIC, (payload) => {
      const event = payload;
      if (event.workspaceId !== reviewId) return;
      if (event.phase === "done") {
        applyRun({ running: false, phase: "done", error: null });
        void loadBrief();
        const pending = pendingSettleRef.current;
        if (pending) {
          pendingSettleRef.current = null;
          setSettle(pending);
        }
      } else if (event.phase === "failed") {
        pendingSettleRef.current = null;
        applyRun({ running: false, phase: "failed", error: event.detail ?? "The guide could not finish." });
      } else {
        applyRun({ running: true, phase: event.phase, detail: event.detail, error: null });
      }
    });
    return off;
  }, [reviewId, loadBrief, applyRun]);
  const startRun = useCallback3(async () => {
    if (!target || !workspaceId || runRef.current.running) return;
    applyRun({ running: true, phase: "reading", error: null });
    try {
      const result = await reviewStartBriefRun({
        reviewId: target.workspaceId,
        workspaceRoot: target.workspaceRoot,
        workspaceId,
        depth,
        ...guideCli ? { cli: guideCli } : {},
        ...guideModel ? { cliModel: guideModel } : {}
      });
      if (!result.ok) {
        applyRun({ running: false, phase: "failed", error: result.errors.join("\n") });
        if (result.reason === "validation") setBriefLoad({ phase: "invalid", errors: result.errors.join("\n") });
        return;
      }
      if (result.guide) setGuide(result.guide);
      if (result.joined) applyRun(runFromStatus(result.status));
    } catch (error) {
      applyRun({ running: false, phase: "failed", error: error instanceof Error ? error.message : String(error) });
    }
  }, [target, workspaceId, depth, guideCli, guideModel, applyRun]);
  const changeset = changesetLoad.phase === "ready" ? changesetLoad.changeset : null;
  const realBrief = briefLoad.phase === "ready" ? briefLoad.brief : null;
  const status = resolveStatus(target !== null, changesetLoad, briefLoad, changeset);
  const brief = useMemo2(() => {
    if (realBrief) return realBrief;
    if (status === "degraded" && changeset) return synthesizeDegradedBrief(changeset);
    return null;
  }, [realBrief, status, changeset]);
  const resolvedState = useMemo2(() => {
    if (!changeset) return null;
    if (storedState && storedState.changeSetId === changeset.id) return storedState;
    return defaultReviewState(changeset.id);
  }, [changeset, storedState]);
  const latestStateRef = useRef3(resolvedState);
  latestStateRef.current = resolvedState;
  useEffect3(() => {
    if (refreshInFlightRef.current) return;
    if (!stateLoaded) return;
    if (changeset && (!storedState || storedState.changeSetId !== changeset.id)) {
      persistReviewState(defaultReviewState(changeset.id));
    }
  }, [changeset, storedState, stateLoaded, persistReviewState]);
  const patchState = useCallback3(
    (patch) => {
      const base = latestStateRef.current;
      if (!base) return;
      persistReviewState({ ...base, ...typeof patch === "function" ? patch(base) : patch });
    },
    [persistReviewState]
  );
  const readFiles = useMemo2(() => new Set(resolvedState?.readFiles ?? []), [resolvedState]);
  const diffView = resolvedState?.diffView ?? "side-by-side";
  const activePaneId = useMemo2(() => brief ? resolveActivePaneId(brief, resolvedState) : "overview", [brief, resolvedState]);
  const onToggleRead = useCallback3(
    (path) => {
      if (!resolvedState) return;
      const next = resolvedState.readFiles.includes(path) ? resolvedState.readFiles.filter((p) => p !== path) : [...resolvedState.readFiles, path];
      patchState({ readFiles: next });
    },
    [resolvedState, patchState]
  );
  const onCreateComment = useCallback3(
    (path, anchor, body) => {
      if (!resolvedState) return;
      const comment = newReviewComment({
        id: crypto.randomUUID(),
        path,
        anchor,
        body,
        createdAt: (/* @__PURE__ */ new Date()).toISOString(),
        headSha: changeset?.headSha
      });
      patchState({ comments: addComment(resolvedState.comments, comment) });
    },
    [resolvedState, patchState, changeset]
  );
  const onEditComment = useCallback3(
    (id, body) => {
      if (!resolvedState) return;
      patchState({ comments: editComment(resolvedState.comments, id, body) });
    },
    [resolvedState, patchState]
  );
  const onDeleteComment = useCallback3(
    (id) => {
      if (!resolvedState) return;
      patchState({ comments: deleteComment(resolvedState.comments, id) });
    },
    [resolvedState, patchState]
  );
  const onPostReview = useCallback3(async () => {
    if (!target || !resolvedState || !changeset || !canPostReview(changeset, resolvedState.comments)) return;
    const batch = postableComments(resolvedState.comments);
    const batchIds = batch.map((comment) => comment.id);
    setPostState({ phase: "posting" });
    patchState({ comments: markCommentsPosting(resolvedState.comments) });
    try {
      const result = await reviewPostReview({ target, comments: batch });
      if (result.ok) {
        patchState((prev) => ({ comments: applyPostOutcomes(prev.comments, result.outcomes) }));
        setPostState({ phase: "idle" });
      } else {
        patchState((prev) => ({ comments: applyPostFailure(prev.comments, batchIds, result.error) }));
        setPostState({ phase: "error", error: result.error });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      patchState((prev) => ({ comments: applyPostFailure(prev.comments, batchIds, message) }));
      setPostState({ phase: "error", error: message });
    }
  }, [target, resolvedState, changeset, patchState]);
  const freshness = useReviewFreshness(changeset, realBrief);
  const refresh = useCallback3(async () => {
    if (!target || !changeset || !workspaceId) return;
    const sourceInput = reconstructSourceInput(changeset);
    if (!sourceInput) {
      await startRun();
      return;
    }
    const oldChangeset = changeset;
    const oldState = storedState && storedState.changeSetId === oldChangeset.id ? storedState : defaultReviewState(oldChangeset.id);
    applyRun({ running: true, phase: "reading", error: null });
    pendingSettleRef.current = null;
    setSettle(null);
    try {
      const ingested = await reviewIngestSource(sourceInput, target);
      if (!ingested.ok) {
        applyRun({ running: false, phase: "failed", error: ingested.error });
        return;
      }
      const newChangeset = ingested.changeset;
      const affectedStepIds = realBrief ? computeFreshness(oldChangeset, newChangeset, realBrief).affectedStepIds : [];
      const runResult = await reviewStartBriefRun({
        reviewId: target.workspaceId,
        workspaceRoot: target.workspaceRoot,
        workspaceId,
        depth,
        affectedStepIds,
        restart: true,
        ...guideCli ? { cli: guideCli } : {},
        ...guideModel ? { cliModel: guideModel } : {}
      });
      if (!runResult.ok) {
        applyRun({ running: false, phase: "failed", error: runResult.errors.join("\n") });
        return;
      }
      if (runResult.guide) setGuide(runResult.guide);
      refreshInFlightRef.current = true;
      persistReviewState(migrateReviewState(oldState, oldChangeset, newChangeset));
      setChangesetLoad({ phase: "ready", changeset: newChangeset });
      await loadBrief();
      pendingSettleRef.current = { headSha: newChangeset.headSha, refreshedStepIds: affectedStepIds };
    } catch (error) {
      applyRun({ running: false, phase: "failed", error: error instanceof Error ? error.message : String(error) });
    } finally {
      refreshInFlightRef.current = false;
    }
  }, [
    target,
    workspaceId,
    changeset,
    storedState,
    realBrief,
    depth,
    guideCli,
    guideModel,
    persistReviewState,
    loadBrief,
    startRun,
    applyRun
  ]);
  const askGuide = useCallback3(
    async (message) => {
      if (!target) return { ok: false, error: "No review is selected." };
      if (!workspaceId) {
        return { ok: false, error: "Open Reviews from a workspace \u2014 the guide needs one to work in." };
      }
      try {
        const result = await reviewAskGuide({
          reviewId: target.workspaceId,
          workspaceRoot: target.workspaceRoot,
          workspaceId,
          message,
          ...guideCli ? { cli: guideCli } : {},
          ...guideModel ? { cliModel: guideModel } : {}
        });
        if (result.ok && result.guide) setGuide(result.guide);
        return result;
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
    [target, workspaceId, guideCli, guideModel]
  );
  const comments = resolvedState?.comments ?? [];
  const bannerModel = useMemo2(() => {
    if (!realBrief || !changeset) return null;
    if (freshness) return buildStaleBanner(changeset.source, realBrief, freshness.result);
    if (settle) return buildCurrentBanner(settle.headSha, realBrief, settle.refreshedStepIds);
    return null;
  }, [realBrief, changeset, freshness, settle]);
  const askController = useMemo2(
    () => ({
      open: askOpen,
      setOpen: setAskOpen,
      prefill: askPrefill,
      askFromCard: (annotation) => {
        prefillNonce.current += 1;
        setAskPrefill({ text: `> ${annotation.path} ${anchorRangeLabel(annotation.anchor)}

`, nonce: prefillNonce.current });
        setAskOpen(true);
      }
    }),
    [askOpen, askPrefill]
  );
  const trayController = useMemo2(() => ({ open: trayOpen, setOpen: setTrayOpen }), [trayOpen]);
  const openTray = useCallback3(() => setTrayOpen(true), []);
  const openAsk = useCallback3(() => {
    setAskPrefill(void 0);
    setAskOpen(true);
  }, []);
  return {
    reviewId,
    workspaceRoot,
    canRunGuide: Boolean(workspaceId),
    status,
    isDegraded: status === "degraded",
    changeset,
    brief,
    errorMessage: changesetLoad.phase === "error" ? changesetLoad.message : null,
    invalidErrors: briefLoad.phase === "invalid" ? briefLoad.errors : null,
    run,
    guide,
    readFiles,
    diffView,
    activePaneId,
    monacoTheme,
    comments,
    bannerModel,
    postState,
    isPullRequest: changeset ? isPullRequestReviewSource(changeset) : false,
    pendingComments: pendingCommentCount(comments),
    canPost: changeset ? canPostReview(changeset, comments) : false,
    onSetActivePane: (id) => patchState({ activeStepId: id }),
    onSetDiffView: (view) => patchState({ diffView: view }),
    onToggleRead,
    onCreateComment,
    onEditComment,
    onDeleteComment,
    onPostReview,
    startRun,
    refresh,
    reloadChangeset: () => {
      void (async () => {
        const changeset2 = await loadChangeset();
        if (changeset2) await loadBrief();
      })();
    },
    askGuide,
    trayController,
    askController,
    openTray,
    openAsk
  };
}
function resolveStatus(hasTarget, changesetLoad, briefLoad, changeset) {
  if (!hasTarget) return "idle";
  if (changesetLoad.phase === "loading") return "loading";
  if (changesetLoad.phase === "error") return "error";
  if (!changeset) return "no-change";
  if (briefLoad.phase === "invalid") return "invalid-brief";
  if (briefLoad.phase === "ready") return "ready";
  if (briefLoad.phase === "idle" || briefLoad.phase === "loading") return "loading";
  return "degraded";
}

// src/renderer/canvas/ReviewCanvas.tsx
import { GhostButton as GhostButton8 } from "@sprintengine/module-sdk/ui";
import { EmptyState as EmptyState3 } from "@sprintengine/module-sdk/ui";
import { InlineNotice as InlineNotice4 } from "@sprintengine/module-sdk/ui";
import { Spinner as Spinner2 } from "@sprintengine/module-sdk/ui";

// src/renderer/canvas/ReviewWalkthrough.tsx
init_editor();
import { useCallback as useCallback5, useEffect as useEffect7, useMemo as useMemo4, useRef as useRef7, useState as useState9 } from "react";
import { Drawer, EmptyState as EmptyState2, KbdChord as KbdChord2, Section as Section2 } from "@sprintengine/module-sdk/ui";

// src/renderer/canvas/TopBar.tsx
import { SegmentedControl } from "@sprintengine/module-sdk/ui";
import { GhostButton } from "@sprintengine/module-sdk/ui";
import { jsx as jsx2, jsxs as jsxs2 } from "react/jsx-runtime";
var DIFF_VIEW_ITEMS = [
  { value: "side-by-side", label: "Side by side" },
  { value: "inline", label: "Inline" }
];
function TopBar({
  title,
  source,
  stats,
  complexity,
  diffView,
  onSetDiffView,
  onRerun,
  rerunning,
  reviewCount,
  onOpenReview,
  onOpenChat
}) {
  return (
    // Geometry and type are `ui/PanelHeader`'s — `px-3 py-2` over
    // `--border-default`, title at `text-body font-semibold` — so the review
    // canvas opens at the same height as every panel beside it. It sat at
    // `h-[46px] px-4` under a `text-heading` title (2112).
    //
    // NOT the primitive itself, deliberately. PanelHeader carries one action
    // plus an overflow menu; this bar carries a view toggle and four controls,
    // and one of them — "Your review" with its pending count — is
    // discoverable-without-opening-the-drawer by design (see below). Moving
    // that set into a kebab is a product decision about the review loop, not a
    // consequence of standardising a header, so the row keeps its control set
    // and takes only the anatomy.
    /* @__PURE__ */ jsxs2("div", { className: "flex shrink-0 items-center gap-2.5 border-b border-[color:var(--border-default)] bg-[color:var(--bg-surface-raised)] px-3 py-2", children: [
      /* @__PURE__ */ jsx2("span", { className: "shrink-0 text-body font-semibold text-[color:var(--text-strong)]", children: title }),
      /* @__PURE__ */ jsx2("span", { className: "min-w-0 flex-1 truncate font-mono text-meta text-[color:var(--text-subtle)]", children: source }),
      /* @__PURE__ */ jsxs2("span", { className: "shrink-0 font-mono text-micro tabular-nums text-[color:var(--text-muted)]", children: [
        stats.files,
        " ",
        stats.files === 1 ? "file" : "files",
        " \xB7 ",
        /* @__PURE__ */ jsxs2("span", { className: "text-[color:var(--tone-good)]", children: [
          "+",
          stats.additions
        ] }),
        " ",
        /* @__PURE__ */ jsxs2("span", { className: "text-[color:var(--tone-error)]", children: [
          "\u2212",
          stats.deletions
        ] })
      ] }),
      complexity ? /* @__PURE__ */ jsxs2("span", { className: "shrink-0 text-meta text-[color:var(--text-subtle)]", children: [
        "Complexity ",
        /* @__PURE__ */ jsx2("span", { className: "text-[color:var(--text-muted)]", children: complexity })
      ] }) : null,
      /* @__PURE__ */ jsx2(
        SegmentedControl,
        {
          ariaLabel: "Diff view",
          items: DIFF_VIEW_ITEMS,
          value: diffView,
          onChange: onSetDiffView,
          className: "shrink-0"
        }
      ),
      onOpenChat ? /* @__PURE__ */ jsxs2(GhostButton, { onClick: onOpenChat, className: "shrink-0", children: [
        /* @__PURE__ */ jsx2("svg", { viewBox: "0 0 16 16", className: "icon-sm", fill: "currentColor", "aria-hidden": "true", children: /* @__PURE__ */ jsx2("path", { d: "M8 1l1.6 4.4L14 7l-4.4 1.6L8 13l-1.6-4.4L2 7l4.4-1.6z" }) }),
        "Ask the guide"
      ] }) : null,
      onOpenReview ? (() => {
        const pending = typeof reviewCount === "number" && reviewCount > 0;
        return /* @__PURE__ */ jsxs2(GhostButton, { onClick: onOpenReview, className: "shrink-0", children: [
          "Your review",
          pending ? /* @__PURE__ */ jsxs2("span", { className: "font-medium tabular-nums text-[color:var(--text-strong)]", children: [
            " \xB7 ",
            reviewCount
          ] }) : null
        ] });
      })() : null,
      /* @__PURE__ */ jsxs2(GhostButton, { onClick: onRerun, disabled: rerunning, className: "shrink-0", children: [
        /* @__PURE__ */ jsx2("svg", { viewBox: "0 0 16 16", className: "icon-sm", fill: "none", "aria-hidden": "true", children: /* @__PURE__ */ jsx2(
          "path",
          {
            d: "M13 8a5 5 0 1 1-1.46-3.54M13 3v2.5h-2.5",
            stroke: "currentColor",
            strokeWidth: "1.4",
            strokeLinecap: "round",
            strokeLinejoin: "round"
          }
        ) }),
        rerunning ? "Re-running\u2026" : "Re-run"
      ] })
    ] })
  );
}

// src/renderer/canvas/StepRail.tsx
import { OutlineButton } from "@sprintengine/module-sdk/ui";
import { RowButton } from "@sprintengine/module-sdk/ui";
import { jsx as jsx3, jsxs as jsxs3 } from "react/jsx-runtime";
function StepRing({ view }) {
  if (view.read) {
    return /* @__PURE__ */ jsx3("span", { className: "relative mt-px inline-flex h-[19px] w-[19px] shrink-0 items-center justify-center rounded-full bg-[color:var(--accent-primary)] text-[color:var(--text-on-accent)]", children: /* @__PURE__ */ jsx3("svg", { viewBox: "0 0 16 16", className: "icon-xs", fill: "none", "aria-hidden": "true", children: /* @__PURE__ */ jsx3("path", { d: "M3.5 8.5l3 3 6-7", stroke: "currentColor", strokeWidth: "1.8", strokeLinecap: "round", strokeLinejoin: "round" }) }) });
  }
  return /* @__PURE__ */ jsx3("span", { className: "relative mt-px inline-flex h-[19px] w-[19px] shrink-0 items-center justify-center rounded-full border border-[color:var(--border-strong)] bg-[color:var(--bg-surface)] text-micro font-semibold tabular-nums text-[color:var(--text-muted)]", children: view.index });
}
function StepRail({ rail, activePaneId, onSelectPane }) {
  return /* @__PURE__ */ jsxs3("div", { className: "flex h-full flex-col border-r border-[color:var(--border-subtle)] bg-[color:var(--bg-surface-raised)] py-4", children: [
    /* @__PURE__ */ jsxs3("div", { className: "px-4 pb-2.5", children: [
      /* @__PURE__ */ jsx3("h3", { className: "text-meta font-semibold text-[color:var(--text-strong)]", children: "Walkthrough" }),
      /* @__PURE__ */ jsx3(
        "div",
        {
          className: "mt-2 h-[3px] overflow-hidden rounded-full bg-[color:var(--bg-active)]",
          role: "progressbar",
          "aria-label": "Reading progress",
          "aria-valuenow": Math.round(rail.meterFraction * 100),
          "aria-valuemin": 0,
          "aria-valuemax": 100,
          children: /* @__PURE__ */ jsx3(
            "div",
            {
              className: "h-full rounded-full bg-[color:var(--accent-primary)] transition-[width] duration-[var(--motion-deliberate)] ease-[var(--motion-ease)] motion-reduce:transition-none",
              style: { width: `${Math.round(rail.meterFraction * 100)}%` }
            }
          )
        }
      )
    ] }),
    /* @__PURE__ */ jsxs3(
      RowButton,
      {
        density: "bleed",
        selected: activePaneId === OVERVIEW_PANE_ID,
        onClick: () => onSelectPane(OVERVIEW_PANE_ID),
        className: "relative mb-0.5",
        children: [
          /* @__PURE__ */ jsx3(
            "span",
            {
              className: `relative mt-px inline-flex h-[19px] w-[19px] shrink-0 items-center justify-center rounded-full border border-[color:var(--border-strong)] bg-[color:var(--bg-surface)] ${activePaneId === OVERVIEW_PANE_ID ? "text-[color:var(--text-strong)]" : "text-[color:var(--text-muted)]"}`,
              "aria-hidden": "true",
              children: /* @__PURE__ */ jsxs3("svg", { viewBox: "0 0 16 16", className: "icon-xs", fill: "none", "aria-hidden": "true", children: [
                /* @__PURE__ */ jsx3("path", { d: "M8 2.5l5.5 5.5L8 13.5 2.5 8z", stroke: "currentColor", strokeWidth: "1.4", strokeLinejoin: "round" }),
                /* @__PURE__ */ jsx3("path", { d: "M8 5.5L10.5 8 8 10.5 5.5 8z", fill: "currentColor" })
              ] })
            }
          ),
          /* @__PURE__ */ jsxs3("span", { className: "min-w-0 flex-1", children: [
            /* @__PURE__ */ jsx3("span", { className: "block text-body font-medium leading-tight text-[color:var(--text-strong)]", children: "Overview" }),
            /* @__PURE__ */ jsx3("span", { className: "mt-0.5 block text-micro text-[color:var(--text-subtle)]", children: "What this change is \xB7 blast radius" })
          ] })
        ]
      }
    ),
    /* @__PURE__ */ jsx3("div", { className: "relative before:absolute before:bottom-3.5 before:left-[18px] before:top-3.5 before:w-px before:bg-[color:var(--border-subtle)] before:content-['']", children: rail.steps.map((view) => {
      const active = activePaneId === view.step.id;
      return /* @__PURE__ */ jsxs3(
        RowButton,
        {
          density: "bleed",
          selected: active,
          onClick: () => onSelectPane(view.step.id),
          className: "relative",
          children: [
            /* @__PURE__ */ jsx3(StepRing, { view }),
            /* @__PURE__ */ jsxs3("span", { className: "min-w-0 flex-1", children: [
              /* @__PURE__ */ jsx3("span", { className: "block text-body font-medium leading-tight text-[color:var(--text-strong)]", children: view.step.title }),
              /* @__PURE__ */ jsx3("span", { className: "mt-0.5 block text-micro tabular-nums text-[color:var(--text-subtle)]", children: view.metaLabel })
            ] })
          ]
        },
        view.step.id
      );
    }) }),
    /* @__PURE__ */ jsxs3("div", { className: "mt-auto border-t border-[color:var(--border-subtle)] px-4 pt-3", children: [
      /* @__PURE__ */ jsx3("div", { className: "mb-2.5 text-micro tabular-nums text-[color:var(--text-subtle)]", children: rail.progressLabel }),
      rail.continueStepId && rail.continueLabel ? /* @__PURE__ */ jsx3(OutlineButton, { className: "w-full justify-center", onClick: () => onSelectPane(rail.continueStepId), children: rail.continueLabel }) : /* @__PURE__ */ jsx3("div", { className: "text-micro text-[color:var(--text-muted)]", children: "All files read." })
    ] })
  ] });
}

// src/renderer/canvas/StepPane.tsx
import { SegmentedControl as SegmentedControl2 } from "@sprintengine/module-sdk/ui";

// src/renderer/canvas/FileCard.tsx
import React, { Suspense } from "react";
import { OutlineButton as OutlineButton2 } from "@sprintengine/module-sdk/ui";
import { TruncatedText } from "@sprintengine/module-sdk/ui";
import { jsx as jsx8, jsxs as jsxs8 } from "react/jsx-runtime";
var ReviewDiffEditor2 = React.lazy(() => Promise.resolve().then(() => (init_ReviewDiffEditor(), ReviewDiffEditor_exports)));
function DeltaCounts({ additions, deletions }) {
  return /* @__PURE__ */ jsxs8("span", { className: "shrink-0 font-mono text-micro tabular-nums", children: [
    additions > 0 ? /* @__PURE__ */ jsxs8("span", { className: "text-[color:var(--tone-good)]", children: [
      "+",
      additions
    ] }) : null,
    additions > 0 && deletions > 0 ? " " : null,
    deletions > 0 ? /* @__PURE__ */ jsxs8("span", { className: "text-[color:var(--tone-error)]", children: [
      "\u2212",
      deletions
    ] }) : null
  ] });
}
function MarkReadButton({ read, onClick }) {
  return (
    // The kit's thrown outline chip — the case its `pressed` prop is named for.
    // Pressed is a selection, and selection is neutral: `bg-selected` with the ink
    // lifted to strong and a neutral tick, never the accent, which is the view's
    // one action (Post review).
    /* @__PURE__ */ jsxs8(OutlineButton2, { size: "xs", onClick, pressed: read, className: "shrink-0", children: [
      read ? /* @__PURE__ */ jsx8("svg", { viewBox: "0 0 16 16", className: "icon-xs", fill: "none", "aria-hidden": "true", children: /* @__PURE__ */ jsx8("path", { d: "M3.5 8.5l3 3 6-7", stroke: "currentColor", strokeWidth: "1.6", strokeLinecap: "round", strokeLinejoin: "round" }) }) : null,
      read ? "Read" : "Mark read"
    ] })
  );
}
function FileCard({
  file,
  why,
  readingNote,
  annotations,
  read,
  diffView,
  monacoTheme,
  onToggleRead,
  onRequestComment,
  onAskGuide,
  onOrphans,
  registerReveal,
  comments,
  onCreateComment,
  onEditComment,
  onDeleteComment
}) {
  const displayPath = file.status === "renamed" && file.oldPath ? `${file.oldPath} \u2192 ${file.path}` : file.path;
  return /* @__PURE__ */ jsxs8(
    "div",
    {
      "data-review-file": file.path,
      className: "mb-4 overflow-hidden rounded-md border border-[color:var(--border-subtle)] bg-[color:var(--bg-surface)]",
      children: [
        /* @__PURE__ */ jsxs8("div", { className: "flex min-h-[38px] items-center gap-2.5 border-b border-[color:var(--border-subtle)] bg-[color:var(--bg-surface-raised)] px-3 py-1.5", children: [
          /* @__PURE__ */ jsxs8("span", { className: "min-w-0 flex-1", children: [
            /* @__PURE__ */ jsx8(TruncatedText, { as: "span", text: displayPath, className: "block font-mono text-meta text-[color:var(--text-strong)]" }),
            /* @__PURE__ */ jsxs8("span", { className: "mt-0.5 block truncate text-meta text-[color:var(--text-subtle)]", children: [
              /* @__PURE__ */ jsx8("span", { className: "font-medium text-[color:var(--text-muted)]", children: "Why:" }),
              " ",
              fileWhyLine(why, readingNote)
            ] })
          ] }),
          /* @__PURE__ */ jsx8(DeltaCounts, { additions: file.additions, deletions: file.deletions }),
          /* @__PURE__ */ jsx8(MarkReadButton, { read, onClick: () => onToggleRead(file.path) })
        ] }),
        file.binary ? /* @__PURE__ */ jsx8("p", { className: "px-3 py-3 text-meta text-[color:var(--text-subtle)]", children: "Binary file \u2014 no diff to show." }) : file.hunks.length === 0 ? /* @__PURE__ */ jsx8("p", { className: "px-3 py-3 text-meta text-[color:var(--text-subtle)]", children: "No line changes." }) : /* @__PURE__ */ jsx8(
          Suspense,
          {
            fallback: /* @__PURE__ */ jsx8("p", { className: "px-3 py-3 text-meta text-[color:var(--text-subtle)]", children: "Loading diff\u2026" }),
            children: /* @__PURE__ */ jsx8(
              ReviewDiffEditor2,
              {
                file,
                annotations,
                diffView,
                monacoTheme,
                onRequestComment,
                onAskGuide,
                onOrphans,
                registerReveal,
                comments,
                onCreateComment,
                onEditComment,
                onDeleteComment
              }
            )
          }
        )
      ]
    }
  );
}

// src/renderer/canvas/StepPane.tsx
init_commentModel();
import { jsx as jsx9, jsxs as jsxs9 } from "react/jsx-runtime";
var DIFF_VIEW_ITEMS2 = [
  { value: "side-by-side", label: "Side by side" },
  { value: "inline", label: "Inline" }
];
function StepPane({
  step,
  fileByPath,
  readFiles,
  diffView,
  onSetDiffView,
  monacoTheme,
  onToggleRead,
  onRequestComment,
  onAskGuide,
  onOrphans,
  registerReveal,
  comments,
  onCreateComment,
  onEditComment,
  onDeleteComment
}) {
  return /* @__PURE__ */ jsxs9("div", { children: [
    /* @__PURE__ */ jsxs9("div", { className: "mb-1.5 flex items-start justify-between gap-3", children: [
      /* @__PURE__ */ jsx9("h4", { className: "min-w-0 text-title font-semibold tracking-tight text-[color:var(--text-strong)]", children: step.title }),
      onSetDiffView ? /* @__PURE__ */ jsx9(
        SegmentedControl2,
        {
          ariaLabel: "Diff view",
          items: DIFF_VIEW_ITEMS2,
          value: diffView,
          onChange: onSetDiffView,
          size: "sm",
          className: "shrink-0"
        }
      ) : null
    ] }),
    /* @__PURE__ */ jsx9("p", { className: "mb-4 max-w-[80ch] text-body leading-[1.55] text-[color:var(--text-muted)]", children: step.narrative }),
    step.files.map((entry) => {
      const file = fileByPath.get(entry.path);
      if (!file) return null;
      return /* @__PURE__ */ jsx9(
        FileCard,
        {
          file,
          why: entry.why,
          readingNote: entry.readingNote,
          annotations: step.annotations.filter((annotation) => annotation.path === entry.path),
          read: readFiles.has(entry.path),
          diffView,
          monacoTheme,
          onToggleRead,
          onRequestComment,
          onAskGuide,
          onOrphans,
          registerReveal,
          comments: commentsForFile(comments, entry.path),
          onCreateComment,
          onEditComment,
          onDeleteComment
        },
        entry.path
      );
    })
  ] });
}

// src/renderer/canvas/OverviewPane.tsx
import { InlineNotice as InlineNotice2 } from "@sprintengine/module-sdk/ui";
import { jsx as jsx10, jsxs as jsxs10 } from "react/jsx-runtime";
function LabeledParagraph({ label, children }) {
  return /* @__PURE__ */ jsxs10("p", { className: "mb-4 max-w-[80ch] text-body leading-[1.55] text-[color:var(--text-muted)]", children: [
    /* @__PURE__ */ jsx10("span", { className: "font-medium text-[color:var(--text-strong)]", children: label }),
    " ",
    children
  ] });
}
function OverviewPane({ overview, knowledgeRefs, unassignedPaths, changeMapSlot }) {
  return /* @__PURE__ */ jsxs10("div", { children: [
    /* @__PURE__ */ jsx10("h4", { className: "mb-2 text-title font-semibold tracking-tight text-[color:var(--text-strong)]", children: "Overview" }),
    unassignedPaths.length > 0 ? /* @__PURE__ */ jsxs10(InlineNotice2, { tone: "warn", className: "mb-4 max-w-[80ch]", children: [
      /* @__PURE__ */ jsx10("span", { className: "font-medium", children: "Not covered by the walkthrough" }),
      " \u2014 ",
      unassignedPaths.length,
      " ",
      unassignedPaths.length === 1 ? "file" : "files",
      " the guide did not fold into a step:",
      /* @__PURE__ */ jsx10("span", { className: "mt-1 block font-mono text-meta", children: unassignedPaths.join(", ") })
    ] }) : null,
    /* @__PURE__ */ jsx10(LabeledParagraph, { label: "What this is.", children: overview.intent }),
    /* @__PURE__ */ jsx10(LabeledParagraph, { label: "Blast radius.", children: overview.blastRadius }),
    /* @__PURE__ */ jsx10(LabeledParagraph, { label: "How it reads.", children: overview.readingGuide }),
    knowledgeRefs.length > 0 ? /* @__PURE__ */ jsxs10("p", { className: "mb-4 max-w-[80ch] text-meta leading-5 text-[color:var(--text-subtle)]", children: [
      /* @__PURE__ */ jsx10("span", { className: "font-medium text-[color:var(--text-muted)]", children: "Grounded in " }),
      knowledgeRefs.map((ref, index) => /* @__PURE__ */ jsxs10("span", { children: [
        /* @__PURE__ */ jsx10("span", { className: "text-[color:var(--text-strong)]", children: ref.note }),
        index < knowledgeRefs.length - 1 ? ", " : ""
      ] }, ref.note))
    ] }) : null,
    changeMapSlot ?? null
  ] });
}

// src/renderer/canvas/ChangeMapView.tsx
import { FOCUS_RING_CLASS } from "@sprintengine/module-sdk/ui";

// src/renderer/canvas/changeMapLayout.ts
var PAD = 14;
var NODE_W = 168;
var NODE_H = 56;
var COL_GAP = 74;
var ROW_GAP = 22;
var LABEL_LIFT = 7;
var LABEL_NUDGE = 8;
function describeChangeMap(changeMap) {
  const byId = new Map(changeMap.nodes.map((node) => [node.id, node.label]));
  const count = changeMap.nodes.length;
  const noun = count === 1 ? "entity" : "entities";
  let summary = `Change map of ${count} ${noun}`;
  if (changeMap.edges.length > 0) {
    const relations = changeMap.edges.map((edge) => {
      const from = byId.get(edge.from) ?? edge.from;
      const to = byId.get(edge.to) ?? edge.to;
      return edge.label ? `${from} ${edge.label} ${to}` : `${from} to ${to}`;
    });
    summary += `: ${relations.join("; ")}`;
  } else if (count > 0) {
    summary += `: ${changeMap.nodes.map((node) => node.label).join(", ")}`;
  }
  if (changeMap.deployNote) summary += `. Deploy order: ${changeMap.deployNote}`;
  return `${summary}.`;
}
function computeChangeMapLayout(changeMap, orderedStepIds) {
  const ariaLabel = describeChangeMap(changeMap);
  if (changeMap.nodes.length === 0) {
    return { width: 0, height: 0, nodes: [], edges: [], ariaLabel };
  }
  const badgeByStep = /* @__PURE__ */ new Map();
  orderedStepIds.forEach((stepId, index) => badgeByStep.set(stepId, index + 1));
  const columnByStep = /* @__PURE__ */ new Map();
  const stepsInColumnOrder = [];
  const seenStep = (stepId) => {
    if (columnByStep.has(stepId)) return;
    columnByStep.set(stepId, -1);
    stepsInColumnOrder.push(stepId);
  };
  for (const stepId of orderedStepIds) {
    if (changeMap.nodes.some((node) => node.stepId === stepId)) seenStep(stepId);
  }
  for (const node of changeMap.nodes) seenStep(node.stepId);
  stepsInColumnOrder.forEach((stepId, index) => columnByStep.set(stepId, index));
  const rowsByColumn = /* @__PURE__ */ new Map();
  for (const node of changeMap.nodes) {
    const column = columnByStep.get(node.stepId) ?? 0;
    const bucket = rowsByColumn.get(column);
    if (bucket) bucket.push(node);
    else rowsByColumn.set(column, [node]);
  }
  const columnHeight = (count) => count * NODE_H + Math.max(0, count - 1) * ROW_GAP;
  const maxRows = Math.max(...[...rowsByColumn.values()].map((rows) => rows.length));
  const contentHeight = columnHeight(maxRows);
  const placed = /* @__PURE__ */ new Map();
  const nodes = [];
  for (const [column, rows] of [...rowsByColumn.entries()].sort((a, b) => a[0] - b[0])) {
    const x = PAD + column * (NODE_W + COL_GAP);
    const top = PAD + (contentHeight - columnHeight(rows.length)) / 2;
    rows.forEach((node, row) => {
      const laid = {
        id: node.id,
        label: node.label,
        sublabel: node.sublabel,
        kind: node.kind,
        stepId: node.stepId,
        stepBadge: badgeByStep.get(node.stepId) ?? column + 1,
        x,
        y: top + row * (NODE_H + ROW_GAP),
        width: NODE_W,
        height: NODE_H
      };
      placed.set(node.id, laid);
      nodes.push(laid);
    });
  }
  const columnOf = (id) => columnByStep.get(placed.get(id)?.stepId ?? "") ?? 0;
  const edges = [];
  for (const edge of changeMap.edges) {
    const from = placed.get(edge.from);
    const to = placed.get(edge.to);
    if (!from || !to) continue;
    edges.push(routeEdge(edge, from, to, columnOf(edge.from), columnOf(edge.to)));
  }
  return {
    width: PAD * 2 + stepsInColumnOrder.length * NODE_W + Math.max(0, stepsInColumnOrder.length - 1) * COL_GAP,
    height: PAD * 2 + contentHeight,
    nodes,
    edges,
    ariaLabel
  };
}
function rightMid(node) {
  return { x: node.x + node.width, y: node.y + node.height / 2 };
}
function leftMid(node) {
  return { x: node.x, y: node.y + node.height / 2 };
}
function topMid(node) {
  return { x: node.x + node.width / 2, y: node.y };
}
function bottomMid(node) {
  return { x: node.x + node.width / 2, y: node.y + node.height };
}
function routeEdge(edge, from, to, fromColumn, toColumn) {
  let start;
  let end;
  let c1;
  let c2;
  let labelX;
  let labelY;
  if (fromColumn !== toColumn) {
    const forward = fromColumn < toColumn;
    start = forward ? rightMid(from) : leftMid(from);
    end = forward ? leftMid(to) : rightMid(to);
    const dx = end.x - start.x;
    c1 = { x: start.x + dx / 2, y: start.y };
    c2 = { x: end.x - dx / 2, y: end.y };
    labelX = (start.x + end.x) / 2;
    labelY = (start.y + end.y) / 2 - LABEL_LIFT;
  } else {
    const downward = to.y > from.y;
    start = downward ? bottomMid(from) : topMid(from);
    end = downward ? topMid(to) : bottomMid(to);
    const dy = end.y - start.y;
    c1 = { x: start.x, y: start.y + dy / 2 };
    c2 = { x: end.x, y: end.y - dy / 2 };
    labelX = start.x + LABEL_NUDGE;
    labelY = (start.y + end.y) / 2;
  }
  return {
    from: edge.from,
    to: edge.to,
    label: edge.label,
    path: `M ${start.x} ${start.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${end.x} ${end.y}`,
    labelX,
    labelY
  };
}

// src/renderer/canvas/ChangeMapView.tsx
import { jsx as jsx11, jsxs as jsxs11 } from "react/jsx-runtime";
var ARROW_MARKER_ID = "review-change-map-arrow";
function ChangeMapView({ changeMap, orderedStepIds, onNavigate }) {
  const layout = computeChangeMapLayout(changeMap, orderedStepIds);
  if (layout.nodes.length === 0) return null;
  return /* @__PURE__ */ jsxs11("section", { className: "mb-5 mt-0.5 max-w-[680px]", children: [
    /* @__PURE__ */ jsx11("h3", { className: "mb-2 text-meta font-semibold text-[color:var(--text-strong)]", children: "Change map" }),
    /* @__PURE__ */ jsx11("div", { className: "overflow-x-auto", children: /* @__PURE__ */ jsxs11(
      "svg",
      {
        viewBox: `0 0 ${layout.width} ${layout.height}`,
        role: "group",
        "aria-label": layout.ariaLabel,
        className: "block h-auto w-full",
        style: { maxWidth: layout.width, minWidth: Math.min(layout.width, 480) },
        children: [
          /* @__PURE__ */ jsx11("defs", { children: /* @__PURE__ */ jsx11(
            "marker",
            {
              id: ARROW_MARKER_ID,
              viewBox: "0 0 8 8",
              refX: 7,
              refY: 4,
              markerWidth: 7,
              markerHeight: 7,
              orient: "auto",
              children: /* @__PURE__ */ jsx11("path", { d: "M0 0 L8 4 L0 8 Z", className: "[fill:var(--border-strong)]" })
            }
          ) }),
          layout.edges.map((edge, index) => /* @__PURE__ */ jsxs11("g", { children: [
            /* @__PURE__ */ jsx11(
              "path",
              {
                d: edge.path,
                fill: "none",
                strokeWidth: 1,
                className: "[stroke:var(--border-strong)]",
                markerEnd: `url(#${ARROW_MARKER_ID})`
              }
            ),
            edge.label ? /* @__PURE__ */ jsx11(
              "text",
              {
                x: edge.labelX,
                y: edge.labelY,
                textAnchor: "middle",
                fontSize: 9,
                className: "[fill:var(--text-subtle)]",
                children: edge.label
              }
            ) : null
          ] }, `${edge.from}->${edge.to}-${index}`)),
          layout.nodes.map((node) => /* @__PURE__ */ jsx11(ChangeMapNodeGlyph, { node, onNavigate }, node.id))
        ]
      }
    ) }),
    changeMap.deployNote ? /* @__PURE__ */ jsxs11("p", { className: "mt-2 max-w-[66ch] text-meta leading-5 text-[color:var(--text-subtle)]", children: [
      /* @__PURE__ */ jsx11("span", { className: "font-medium text-[color:var(--text-muted)]", children: "Deploy order:" }),
      " ",
      changeMap.deployNote
    ] }) : null
  ] });
}
function ChangeMapNodeGlyph({
  node,
  onNavigate
}) {
  const onKeyDown = (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onNavigate(node.stepId);
    }
  };
  const label = node.sublabel ? `${node.label} \u2014 ${node.sublabel}. Go to step ${node.stepBadge}.` : `${node.label}. Go to step ${node.stepBadge}.`;
  const badgeCx = node.x + node.width - 15;
  const badgeCy = node.y + 15;
  return /* @__PURE__ */ jsxs11(
    "g",
    {
      role: "button",
      tabIndex: 0,
      "aria-label": label,
      onClick: () => onNavigate(node.stepId),
      onKeyDown,
      className: `group cursor-pointer ${FOCUS_RING_CLASS}`,
      children: [
        /* @__PURE__ */ jsx11(
          "rect",
          {
            x: node.x,
            y: node.y,
            width: node.width,
            height: node.height,
            rx: 7,
            strokeWidth: 1,
            className: "[fill:var(--bg-hover)] [stroke:var(--border-default)] transition-[fill,stroke] duration-[var(--motion-fast)] ease-[var(--motion-ease)] group-hover:[fill:var(--accent-primary-soft)] group-hover:[stroke:var(--accent-primary)] motion-reduce:transition-none"
          }
        ),
        /* @__PURE__ */ jsx11(
          "text",
          {
            x: node.x + 16,
            y: node.sublabel ? node.y + 23 : node.y + 31,
            fontSize: 11,
            fontWeight: 500,
            className: "[fill:var(--text-strong)]",
            children: node.label
          }
        ),
        node.sublabel ? /* @__PURE__ */ jsx11(
          "text",
          {
            x: node.x + 16,
            y: node.y + 41,
            fontSize: 9.5,
            className: "font-mono [fill:var(--text-subtle)]",
            children: node.sublabel
          }
        ) : null,
        /* @__PURE__ */ jsx11("circle", { cx: badgeCx, cy: badgeCy, r: 8, strokeWidth: 1, className: "[fill:var(--bg-surface)] [stroke:var(--border-strong)]" }),
        /* @__PURE__ */ jsx11(
          "text",
          {
            x: badgeCx,
            y: badgeCy + 3,
            textAnchor: "middle",
            fontSize: 9,
            fontWeight: 600,
            className: "tabular-nums [fill:var(--text-muted)]",
            children: node.stepBadge
          }
        )
      ]
    }
  );
}

// src/renderer/canvas/AnnotationsPanel.tsx
init_anchorLabel();
import { GhostButton as GhostButton5 } from "@sprintengine/module-sdk/ui";
import { EmptyState } from "@sprintengine/module-sdk/ui";
import { Section } from "@sprintengine/module-sdk/ui";
import { jsx as jsx12, jsxs as jsxs12 } from "react/jsx-runtime";
function AnnotationsPanel({ annotations, onJumpTo, onAskGuide }) {
  return (
    // The column heading is the kit `Section` — one heading size and ink across
    // the doors and this canvas, rather than a private micro/subtle label — and
    // the section's own inset is the column's inset.
    /* @__PURE__ */ jsx12("div", { className: "h-full overflow-y-auto border-l border-[color:var(--border-subtle)] bg-[color:var(--bg-surface-raised)]", children: /* @__PURE__ */ jsx12(Section, { title: "In this step", count: annotations.length > 0 ? annotations.length : void 0, children: annotations.length === 0 ? /* @__PURE__ */ jsx12(
      EmptyState,
      {
        density: "list",
        title: "No guide notes in this step",
        body: "The files here read straight through."
      }
    ) : annotations.map((annotation) => /* @__PURE__ */ jsxs12(
      "div",
      {
        className: "mb-2.5 rounded-md border border-[color:var(--border-subtle)] bg-[color:var(--bg-surface)] px-3 py-2.5",
        children: [
          /* @__PURE__ */ jsxs12("div", { className: "mb-1 flex items-baseline gap-2", children: [
            /* @__PURE__ */ jsx12("span", { className: "min-w-0 flex-1 text-body font-medium leading-tight text-[color:var(--text-strong)]", children: annotation.title }),
            /* @__PURE__ */ jsx12("span", { className: "shrink-0 font-mono text-micro tabular-nums text-[color:var(--text-subtle)]", children: anchorRangeLabel(annotation.anchor) })
          ] }),
          /* @__PURE__ */ jsx12("p", { className: "text-meta leading-5 text-[color:var(--text-muted)]", children: annotation.summary }),
          /* @__PURE__ */ jsxs12("div", { className: "mt-2 flex gap-2", children: [
            /* @__PURE__ */ jsx12(GhostButton5, { onClick: () => onJumpTo(annotation), children: "Jump to lines" }),
            /* @__PURE__ */ jsx12(GhostButton5, { onClick: () => onAskGuide(annotation), children: "Ask" })
          ] })
        ]
      },
      annotation.id
    )) }) })
  );
}

// src/renderer/canvas/ReviewTray.tsx
init_commentModel();
init_CommentThread();
import { useState as useState8 } from "react";
import { PrimaryButton as PrimaryButton2, GhostButton as GhostButton6 } from "@sprintengine/module-sdk/ui";
import { InlineNotice as InlineNotice3 } from "@sprintengine/module-sdk/ui";
import { jsx as jsx13, jsxs as jsxs13 } from "react/jsx-runtime";
function ReviewTray({ comments, changeset, onPost, postState }) {
  const [copied, setCopied] = useState8(false);
  const pending = pendingCommentCount(comments);
  const isPr = isPullRequestReviewSource(changeset);
  const prLabel = pullRequestLabel(changeset);
  const posting = postState?.phase === "posting";
  const postError = postState?.phase === "error" ? postState.error : void 0;
  const canPost = Boolean(onPost) && isPr && pending > 0 && !posting;
  const settled = isPr && pending === 0 && hasPostedComments(comments);
  const copyMarkdown = async () => {
    try {
      await navigator.clipboard.writeText(commentsToMarkdown(comments));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
    }
  };
  if (comments.length === 0) {
    return /* @__PURE__ */ jsxs13("p", { className: "px-1 py-2 text-meta leading-5 text-[color:var(--text-subtle)]", children: [
      "No comments yet. Hover any line in the walkthrough \u2014 added or removed \u2014 and click ",
      /* @__PURE__ */ jsx13("span", { className: "font-medium text-[color:var(--text-strong)]", children: "+" }),
      " to leave one; they collect here as one review."
    ] });
  }
  return /* @__PURE__ */ jsxs13("div", { className: "flex h-full flex-col", children: [
    /* @__PURE__ */ jsx13("div", { className: "min-h-0 flex-1 overflow-y-auto", children: comments.map((comment) => /* @__PURE__ */ jsxs13(
      "div",
      {
        className: "min-w-0 border-b border-[color:var(--border-subtle)] py-3 last:border-b-0",
        children: [
          /* @__PURE__ */ jsxs13("div", { className: "flex items-baseline justify-between gap-2", children: [
            /* @__PURE__ */ jsx13("span", { className: "truncate font-mono text-micro text-[color:var(--text-subtle)]", children: commentLocationLabel(comment) }),
            /* @__PURE__ */ jsx13(CommentSyncBadge, { comment })
          ] }),
          /* @__PURE__ */ jsx13("p", { className: "mt-0.5 max-w-[76ch] whitespace-pre-wrap text-meta leading-5 text-[color:var(--text-default)]", children: comment.body })
        ]
      },
      comment.id
    )) }),
    /* @__PURE__ */ jsxs13("div", { className: "mt-3 border-t border-[color:var(--border-subtle)] pt-3", children: [
      /* @__PURE__ */ jsx13("p", { className: "mb-2 text-micro leading-4 text-[color:var(--text-subtle)]", children: isPr && prLabel ? `Posts as you \xB7 one review on ${prLabel}` : "No pull request to post to \u2014 copy the comments to paste anywhere." }),
      /* @__PURE__ */ jsxs13("div", { className: "flex items-center gap-2", children: [
        /* @__PURE__ */ jsx13(GhostButton6, { onClick: copyMarkdown, disabled: comments.length === 0, children: copied ? "Copied" : "Copy as markdown" }),
        isPr ? settled ? /* @__PURE__ */ jsx13(PrimaryButton2, { disabled: true, children: "Posted" }) : /* @__PURE__ */ jsx13(PrimaryButton2, { onClick: onPost, disabled: !canPost, children: posting ? "Posting\u2026" : `Post ${pending} ${pending === 1 ? "comment" : "comments"} to pull request` }) : null
      ] }),
      postError ? /* @__PURE__ */ jsx13(InlineNotice3, { tone: "error", className: "mt-2", children: postError }) : null
    ] })
  ] });
}

// src/renderer/canvas/ReviewWalkthrough.tsx
init_commentModel();
import { jsx as jsx14, jsxs as jsxs14 } from "react/jsx-runtime";
function ReviewWalkthrough({
  changeset,
  brief,
  readFiles,
  diffView,
  activePaneId,
  monacoTheme,
  rerunning,
  onSetActivePane,
  onSetDiffView,
  onToggleRead,
  onRequestComment,
  onAskGuide,
  onRerun,
  bannerSlot,
  comments = [],
  onCreateComment,
  onEditComment,
  onDeleteComment,
  onPostReview,
  postState,
  onOpenAsk,
  isDegraded = false,
  hideTopBar = false,
  trayController
}) {
  const commentsEnabled = Boolean(onCreateComment);
  const askEnabled = Boolean(onOpenAsk) && !isDegraded;
  const [internalTrayOpen, setInternalTrayOpen] = useState9(false);
  const trayOpen = trayController ? trayController.open : internalTrayOpen;
  const setTrayOpen = trayController ? trayController.setOpen : setInternalTrayOpen;
  const steps = useMemo4(() => orderedSteps(brief), [brief]);
  const changeMapSlot = brief.changeMap ? /* @__PURE__ */ jsx14(
    ChangeMapView,
    {
      changeMap: brief.changeMap,
      orderedStepIds: steps.map((step) => step.id),
      onNavigate: onSetActivePane
    }
  ) : null;
  const rail = useMemo4(() => buildRailModel(changeset, brief, readFiles), [changeset, brief, readFiles]);
  const fileByPath = useMemo4(
    () => new Map(changeset.files.map((file) => [file.path, file])),
    [changeset]
  );
  const paneOrder = useMemo4(() => [OVERVIEW_PANE_ID, ...steps.map((step) => step.id)], [steps]);
  const activeStep = steps.find((step) => step.id === activePaneId) ?? null;
  const revealMapRef = useRef7(/* @__PURE__ */ new Map());
  const centerRef = useRef7(null);
  const registerReveal = useCallback5((path, reveal) => {
    if (reveal) revealMapRef.current.set(path, reveal);
    else revealMapRef.current.delete(path);
  }, []);
  const handleOrphans = useCallback5(() => {
  }, []);
  const jumpToLine = useCallback5((path, line) => {
    const card = centerRef.current?.querySelector(`[data-review-file="${path}"]`);
    card?.scrollIntoView({ block: "center", behavior: "smooth" });
    revealMapRef.current.get(path)?.(line);
  }, []);
  const handleJumpTo = useCallback5(
    (annotation) => jumpToLine(annotation.path, annotation.anchor.startLine),
    [jumpToLine]
  );
  useEffect7(() => {
    const onKeyDown = (event) => {
      if (event.key !== "[" && event.key !== "]") return;
      const target = event.target;
      if (target && (target.isContentEditable || target.closest("input, textarea, select, .monaco-editor")))
        return;
      const current = paneOrder.indexOf(activePaneId);
      if (current === -1) return;
      const next = event.key === "]" ? current + 1 : current - 1;
      if (next < 0 || next >= paneOrder.length) return;
      event.preventDefault();
      onSetActivePane(paneOrder[next]);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [paneOrder, activePaneId, onSetActivePane]);
  return /* @__PURE__ */ jsxs14("div", { className: "flex h-full w-full flex-col overflow-hidden bg-[color:var(--bg-surface)]", children: [
    hideTopBar ? null : /* @__PURE__ */ jsx14(
      TopBar,
      {
        title: changeset.title,
        source: sourceIdentity(changeset),
        stats: statsChip(changeset),
        complexity: brief.overview.complexity,
        diffView,
        onSetDiffView,
        onRerun,
        rerunning,
        reviewCount: pendingCommentCount(comments),
        onOpenReview: commentsEnabled ? () => setTrayOpen(true) : void 0,
        onOpenChat: askEnabled ? onOpenAsk : void 0
      }
    ),
    bannerSlot,
    /* @__PURE__ */ jsx14("div", { className: "@container min-h-0 flex-1", children: /* @__PURE__ */ jsxs14("div", { className: "grid h-full grid-cols-[210px_minmax(0,1fr)] @[940px]:grid-cols-[244px_minmax(0,1fr)_276px]", children: [
      /* @__PURE__ */ jsx14(StepRail, { rail, activePaneId, onSelectPane: onSetActivePane }),
      /* @__PURE__ */ jsxs14("div", { ref: centerRef, className: "min-w-0 overflow-y-auto px-6 py-5", children: [
        /* @__PURE__ */ jsx14(ShortcutHints, { inStep: Boolean(activeStep), commentsEnabled }),
        /* @__PURE__ */ jsx14("div", { className: "mcrev-pane-enter", children: activeStep ? /* @__PURE__ */ jsx14(
          StepPane,
          {
            step: activeStep,
            fileByPath,
            readFiles,
            diffView,
            onSetDiffView,
            monacoTheme,
            onToggleRead,
            onRequestComment,
            onAskGuide,
            onOrphans: handleOrphans,
            registerReveal,
            comments,
            onCreateComment,
            onEditComment,
            onDeleteComment
          }
        ) : /* @__PURE__ */ jsx14(
          OverviewPane,
          {
            overview: brief.overview,
            knowledgeRefs: brief.knowledgeRefs,
            unassignedPaths: brief.coverage.unassignedPaths,
            changeMapSlot
          }
        ) }, activePaneId)
      ] }),
      /* @__PURE__ */ jsx14("div", { className: "hidden min-h-0 @[940px]:block", children: activeStep ? /* @__PURE__ */ jsx14(AnnotationsPanel, { annotations: activeStep.annotations, onJumpTo: handleJumpTo, onAskGuide }) : (
        // The same `Section` head the AnnotationsPanel draws, so the column
        // does not change heading size when a step is picked.
        /* @__PURE__ */ jsx14("div", { className: "h-full border-l border-[color:var(--border-subtle)] bg-[color:var(--bg-surface-raised)]", children: /* @__PURE__ */ jsx14(Section2, { title: "In this step", children: /* @__PURE__ */ jsx14(EmptyState2, { density: "list", title: "Pick a step to see the guide\u2019s notes for it." }) }) })
      ) })
    ] }) }),
    commentsEnabled ? /* @__PURE__ */ jsx14(
      Drawer,
      {
        open: trayOpen,
        onClose: () => setTrayOpen(false),
        title: "Your review",
        ariaLabel: "Your pending review comments",
        width: 440,
        children: /* @__PURE__ */ jsx14(Drawer.Body, { children: /* @__PURE__ */ jsx14(ReviewTray, { comments, changeset, onPost: onPostReview, postState }) })
      }
    ) : null
  ] });
}
var IS_MAC = isMacPlatform();
var PRIMARY_KEY2 = IS_MAC ? "Cmd" : "Ctrl";
var ALT_KEY = IS_MAC ? "Option" : "Alt";
function ShortcutHints({ inStep, commentsEnabled }) {
  return /* @__PURE__ */ jsxs14("div", { className: "mb-3 flex flex-wrap items-center justify-end gap-x-4 gap-y-1 text-micro text-[color:var(--text-subtle)]", children: [
    /* @__PURE__ */ jsxs14("span", { className: "inline-flex items-center gap-1", children: [
      /* @__PURE__ */ jsx14(KbdChord2, { keys: ["["] }),
      /* @__PURE__ */ jsx14(KbdChord2, { keys: ["]"] }),
      " panes"
    ] }),
    inStep ? /* @__PURE__ */ jsxs14("span", { className: "inline-flex items-center gap-1", children: [
      /* @__PURE__ */ jsx14(KbdChord2, { keys: ["F7"] }),
      " hunks"
    ] }) : null,
    inStep && commentsEnabled ? /* @__PURE__ */ jsxs14("span", { className: "inline-flex items-center gap-1", children: [
      /* @__PURE__ */ jsx14(KbdChord2, { keys: [PRIMARY_KEY2, ALT_KEY, "C"] }),
      " comment"
    ] }) : null
  ] });
}

// src/renderer/canvas/FreshnessBanner.tsx
import { Banner } from "@sprintengine/module-sdk/ui";
import { GhostButton as GhostButton7 } from "@sprintengine/module-sdk/ui";
import { Spinner } from "@sprintengine/module-sdk/ui";
import { jsx as jsx15, jsxs as jsxs15 } from "react/jsx-runtime";
var REFRESH_PHASE_LABEL = {
  reading: "Re-reading the change\u2026",
  grouping: "Refreshing the affected steps\u2026",
  annotating: "Checking the walkthrough\u2026",
  writing: "Saving the walkthrough\u2026",
  done: "Walkthrough ready",
  failed: "The refresh could not finish"
};
function FreshnessBanner({ model, refreshing, refreshPhase, onRefresh }) {
  const message = model.lead ? `${model.lead} ${model.detail}` : model.detail;
  if (model.tone === "current") {
    return /* @__PURE__ */ jsxs15(
      "div",
      {
        className: "flex items-center gap-2.5 border-b border-[color:var(--border-subtle)] bg-[color:var(--bg-hover)] px-4 py-2",
        role: "status",
        children: [
          /* @__PURE__ */ jsx15("span", { className: "min-w-0 flex-1 text-meta leading-5 text-[color:var(--text-subtle)]", children: message }),
          refreshing ? /* @__PURE__ */ jsx15(RefreshProgress, { phase: refreshPhase }) : null
        ]
      }
    );
  }
  return /* @__PURE__ */ jsx15(
    Banner,
    {
      tone: "warn",
      message,
      action: refreshing ? /* @__PURE__ */ jsx15(RefreshProgress, { phase: refreshPhase }) : model.refreshable ? /* @__PURE__ */ jsxs15(GhostButton7, { onClick: onRefresh, children: [
        /* @__PURE__ */ jsx15("svg", { viewBox: "0 0 16 16", className: "icon-sm", fill: "none", "aria-hidden": "true", children: /* @__PURE__ */ jsx15(
          "path",
          {
            d: "M13 8a5 5 0 1 1-1.46-3.54M13 3v2.5h-2.5",
            stroke: "currentColor",
            strokeWidth: "1.4",
            strokeLinecap: "round",
            strokeLinejoin: "round"
          }
        ) }),
        "Refresh walkthrough"
      ] }) : null
    }
  );
}
function RefreshProgress({ phase }) {
  return /* @__PURE__ */ jsxs15("span", { className: "flex shrink-0 items-center gap-2 text-meta text-[color:var(--text-muted)]", children: [
    /* @__PURE__ */ jsx15(Spinner, {}),
    REFRESH_PHASE_LABEL[phase ?? "grouping"]
  ] });
}

// src/renderer/canvas/ReviewCanvas.tsx
init_commentModel();
import { Fragment as Fragment3, jsx as jsx16, jsxs as jsxs16 } from "react/jsx-runtime";
function ReviewCanvas({ session, guideActions }) {
  const { status, changeset, run } = session;
  if (status === "idle") {
    return /* @__PURE__ */ jsx16(CenteredState, { children: /* @__PURE__ */ jsx16(EmptyState3, { title: "No review selected", body: "Choose a review from the list to open its walkthrough." }) });
  }
  if (status === "loading") {
    return /* @__PURE__ */ jsxs16(CenteredState, { children: [
      /* @__PURE__ */ jsx16(Spinner2, {}),
      " ",
      /* @__PURE__ */ jsx16("span", { className: "ml-2", children: "Loading the change\u2026" })
    ] });
  }
  if (status === "error") {
    return /* @__PURE__ */ jsx16(CenteredState, { children: /* @__PURE__ */ jsx16(
      InlineNotice4,
      {
        tone: "error",
        className: "max-w-md",
        title: "Couldn\u2019t open this review",
        hint: session.errorMessage ?? "The change set could not be read.",
        action: /* @__PURE__ */ jsx16(GhostButton8, { onClick: session.reloadChangeset, children: "Try again" })
      }
    ) });
  }
  if (status === "no-change" || !changeset) {
    return /* @__PURE__ */ jsx16(CenteredState, { children: /* @__PURE__ */ jsx16(
      EmptyState3,
      {
        title: "No change to review yet",
        body: "This review has no change loaded. Start a new one from a pull request, branch, or patch."
      }
    ) });
  }
  if (status === "invalid-brief") {
    return /* @__PURE__ */ jsxs16(PrepareShell, { changeset, children: [
      /* @__PURE__ */ jsx16(
        InlineNotice4,
        {
          tone: "error",
          className: "max-w-2xl",
          title: "The walkthrough didn\u2019t pass its checks.",
          detail: session.invalidErrors ?? void 0
        }
      ),
      /* @__PURE__ */ jsx16("div", { className: "mt-3 flex flex-wrap items-center gap-2", children: guideActions }),
      /* @__PURE__ */ jsx16(RunLine, { run })
    ] });
  }
  const brief = session.brief;
  if (!brief) {
    return /* @__PURE__ */ jsxs16(CenteredState, { children: [
      /* @__PURE__ */ jsx16(Spinner2, {}),
      " ",
      /* @__PURE__ */ jsx16("span", { className: "ml-2", children: "Loading the walkthrough\u2026" })
    ] });
  }
  const bannerSlot = /* @__PURE__ */ jsxs16(Fragment3, { children: [
    !session.isDegraded && session.bannerModel ? /* @__PURE__ */ jsx16(FreshnessBanner, { model: session.bannerModel, refreshing: run.running, refreshPhase: run.phase, onRefresh: session.refresh }) : null,
    run.error ? /* @__PURE__ */ jsx16("div", { className: "shrink-0 px-5 pt-3", children: /* @__PURE__ */ jsxs16(InlineNotice4, { tone: "error", children: [
      /* @__PURE__ */ jsx16("span", { className: "font-medium", children: "The guide couldn\u2019t finish." }),
      " ",
      run.error,
      " You can keep reviewing without it."
    ] }) }) : null
  ] });
  return /* @__PURE__ */ jsx16("div", { className: "flex h-full w-full flex-col overflow-hidden", children: /* @__PURE__ */ jsx16("div", { className: "min-h-0 flex-1", children: /* @__PURE__ */ jsx16(
    ReviewWalkthrough,
    {
      changeset,
      brief,
      isDegraded: session.isDegraded,
      readFiles: session.readFiles,
      diffView: session.diffView,
      activePaneId: session.activePaneId,
      monacoTheme: session.monacoTheme,
      rerunning: run.running,
      onSetActivePane: session.onSetActivePane,
      onSetDiffView: session.onSetDiffView,
      onToggleRead: session.onToggleRead,
      onRequestComment: NOOP,
      onAskGuide: session.askController.askFromCard,
      onRerun: session.refresh,
      bannerSlot,
      comments: session.comments,
      onCreateComment: session.onCreateComment,
      onEditComment: session.onEditComment,
      onDeleteComment: session.onDeleteComment,
      onPostReview: isPullRequestReviewSource(changeset) ? session.onPostReview : void 0,
      postState: session.postState,
      onOpenAsk: session.openAsk,
      hideTopBar: true,
      trayController: session.trayController
    }
  ) }) });
}
var NOOP = () => {
};
function CenteredState({ children }) {
  return /* @__PURE__ */ jsx16("div", { className: "flex h-full w-full items-center justify-center bg-[color:var(--bg-surface)] px-5 text-body text-[color:var(--text-muted)]", children });
}
function PrepareShell({ changeset, children }) {
  return /* @__PURE__ */ jsxs16("div", { className: "flex h-full w-full flex-col overflow-y-auto bg-[color:var(--bg-surface)] px-5 py-6", children: [
    /* @__PURE__ */ jsxs16("header", { className: "mb-5", children: [
      /* @__PURE__ */ jsx16("h2", { className: "text-title font-semibold leading-6 tracking-tight text-[color:var(--text-strong)]", children: changeset.title }),
      /* @__PURE__ */ jsxs16("p", { className: "mt-1 font-mono text-meta text-[color:var(--text-subtle)]", children: [
        sourceIdentity(changeset),
        " \xB7 ",
        /* @__PURE__ */ jsx16("span", { className: "tabular-nums", children: changeset.stats.files }),
        " ",
        changeset.stats.files === 1 ? "file" : "files",
        " \xB7",
        " ",
        /* @__PURE__ */ jsxs16("span", { className: "tabular-nums text-[color:var(--tone-good)]", children: [
          "+",
          changeset.stats.additions
        ] }),
        " ",
        /* @__PURE__ */ jsxs16("span", { className: "tabular-nums text-[color:var(--tone-error)]", children: [
          "\u2212",
          changeset.stats.deletions
        ] })
      ] })
    ] }),
    children
  ] });
}
function RunLine({ run }) {
  if (run.error) {
    return /* @__PURE__ */ jsx16(InlineNotice4, { tone: "error", className: "mt-3 max-w-2xl", children: run.error });
  }
  if (!run.running || !run.phase) return null;
  return /* @__PURE__ */ jsxs16("p", { className: "mt-3 flex items-center gap-2 text-meta text-[color:var(--text-muted)]", children: [
    /* @__PURE__ */ jsx16(Spinner2, {}),
    RUN_PHASE_LABEL[run.phase]
  ] });
}
var RUN_PHASE_LABEL = {
  reading: "Starting the guide\u2026",
  grouping: "The guide is working on the walkthrough\u2026",
  annotating: "Checking the walkthrough\u2026",
  writing: "Saving the walkthrough\u2026",
  done: "Walkthrough ready",
  failed: "The guide could not finish"
};

// src/renderer/door/ReviewsGlobalSurface.tsx
import { GlobalSurfaceShell } from "@sprintengine/module-sdk/surface";
import { SurfaceCanvasState } from "@sprintengine/module-sdk/surface";
import { useSurfaceBackNav } from "@sprintengine/module-sdk/surface";

// src/renderer/door/ReviewsRail.tsx
import { LifecycleGlyph } from "@sprintengine/module-sdk/ui";
import {
  SurfaceRail
} from "@sprintengine/module-sdk/surface";
import { jsx as jsx17 } from "react/jsx-runtime";
var STATUS_GLYPH = {
  draft: "todo",
  "in-progress": "in_progress",
  posted: "done"
};
function ReviewsRail({ rows, selectedReviewId, newSelected, search, filter, onSelect, onNewReview, emptyNotice }) {
  const railRows = rows.map((row) => ({
    id: row.reviewId,
    title: row.title,
    stateLine: row.stateLine,
    tooltip: `${row.title} \u2014 ${row.dotLabel} \xB7 ${row.stateLine}`,
    icon: /* @__PURE__ */ jsx17(
      LifecycleGlyph,
      {
        state: STATUS_GLYPH[row.status],
        live: false,
        label: row.dotLabel,
        className: "shrink-0"
      }
    )
  }));
  return /* @__PURE__ */ jsx17(
    SurfaceRail,
    {
      label: "Reviews",
      rows: railRows,
      selectedId: newSelected ? null : selectedReviewId,
      onSelect,
      newAffordance: { label: "Review a change", selected: newSelected, onActivate: onNewReview },
      search,
      filter,
      emptyNotice
    }
  );
}

// src/renderer/door/ReviewChangeForm.tsx
import { useEffect as useEffect8, useMemo as useMemo5, useRef as useRef8, useState as useState10 } from "react";
import {
  Field,
  GhostButton as GhostButton9,
  InlineNotice as InlineNotice5,
  Input,
  PrimaryButton as PrimaryButton3,
  SegmentedControl as SegmentedControl3,
  Select,
  StatusDot as StatusDot2,
  Textarea as Textarea2
} from "@sprintengine/module-sdk/ui";

// src/renderer/door/reviewCreation.ts
var ReviewControllerError = class extends Error {
  constructor(code, message) {
    super(message ?? code);
    this.code = code;
    this.name = "ReviewControllerError";
  }
};
async function ingestReviewChange(input, ports) {
  const reviewId = `rv_${crypto.randomUUID()}`;
  let result;
  try {
    result = await ports.ingestSource(input.source, { workspaceRoot: input.folderPath, workspaceId: reviewId });
  } catch (error) {
    throw new ReviewControllerError("ingest-failed", error instanceof Error ? error.message : String(error));
  }
  if (!result.ok) throw new ReviewControllerError("ingest-failed", result.error);
  return reviewId;
}

// src/renderer/door/reviewController.ts
var PR_URL_SHAPE = /^https?:\/\/[^/\s]+\/\S+\/(?:pull|pull-requests|merge_requests)\/\d+/i;
function looksLikePrUrl(url) {
  return PR_URL_SHAPE.test(url.trim());
}
function resolvePrProject(result, projectRoots) {
  if (projectRoots.length === 0) return { kind: "no-projects" };
  if (!result.ok) return { kind: "choose", roots: [...projectRoots], reason: "error" };
  const matches = result.matches;
  if (matches.length === 1) return { kind: "confirmed", root: matches[0] };
  if (matches.length > 1) return { kind: "choose", roots: [...matches], reason: "many" };
  return { kind: "choose", roots: [...projectRoots], reason: "none" };
}
function controlDefaultRoot(control) {
  if (control.kind === "confirmed") return control.root;
  if (control.kind === "choose") return control.roots[0] ?? null;
  return null;
}

// src/renderer/door/ReviewChangeForm.tsx
import { Fragment as Fragment4, jsx as jsx18, jsxs as jsxs17 } from "react/jsx-runtime";
var SOURCE_SEGMENTS = [
  { value: "pull-request", label: "Pull request" },
  { value: "branch", label: "Branch" },
  { value: "patch", label: "Pasted patch" }
];
function ReviewChangeForm({ projectRoots, onCreated, onCancel }) {
  const [projectRoot, setProjectRoot] = useState10(projectRoots[0] ?? null);
  const [sourceKind, setSourceKind] = useState10("pull-request");
  const [prUrl, setPrUrl] = useState10("");
  const [prControl, setPrControl] = useState10({ kind: "hidden" });
  const [prPickedRoot, setPrPickedRoot] = useState10(null);
  const matchCacheRef = useRef8(/* @__PURE__ */ new Map());
  const [brBase, setBrBase] = useState10("");
  const [brHead, setBrHead] = useState10("");
  const [branches, setBranches] = useState10(null);
  const [patchText, setPatchText] = useState10("");
  const [patchLabel, setPatchLabel] = useState10("");
  const [probe, setProbe] = useState10({ status: "idle" });
  const [starting, setStarting] = useState10(false);
  const [error, setError] = useState10(null);
  const projectItems = useMemo5(
    () => projectRoots.map((root) => ({ value: root, label: projectLabel(root) })),
    [projectRoots]
  );
  const source = useMemo5(() => {
    if (sourceKind === "pull-request") {
      const url = prUrl.trim();
      return url ? { kind: "pull-request", url } : null;
    }
    if (sourceKind === "branch") {
      const baseRef = brBase.trim();
      const headRef = brHead.trim();
      return projectRoot && baseRef && headRef ? { kind: "branch", repoRoot: projectRoot, baseRef, headRef } : null;
    }
    const text = patchText.trim();
    if (!text) return null;
    const label = patchLabel.trim();
    return label ? { kind: "patch", text, label } : { kind: "patch", text };
  }, [sourceKind, prUrl, brBase, brHead, projectRoot, patchText, patchLabel]);
  useEffect8(() => {
    if (sourceKind !== "branch" || !projectRoot) return;
    let cancelled = false;
    void (async () => {
      try {
        const result = await reviewListBranches(projectRoot);
        if (cancelled) return;
        if (!result.ok) {
          setBranches(null);
          return;
        }
        setBranches(result);
        setBrHead((current) => current || result.current || "");
        setBrBase((current) => current || pickBaseDefault(result));
      } catch {
        if (!cancelled) setBranches(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sourceKind, projectRoot]);
  useEffect8(() => {
    matchCacheRef.current.clear();
  }, [projectRoots]);
  useEffect8(() => {
    if (sourceKind !== "pull-request") return;
    const url = prUrl.trim();
    setPrPickedRoot(null);
    if (!looksLikePrUrl(url)) {
      setPrControl({ kind: "hidden" });
      return;
    }
    const cached = matchCacheRef.current.get(url);
    if (cached) {
      setPrControl(resolvePrProject(cached, projectRoots));
      return;
    }
    let cancelled = false;
    const handle = window.setTimeout(() => {
      if (cancelled) return;
      setPrControl({ kind: "matching" });
      void reviewMatchPrProject(url, projectRoots).then((result) => {
        matchCacheRef.current.set(url, result);
        if (!cancelled) setPrControl(resolvePrProject(result, projectRoots));
      }).catch((err) => {
        if (!cancelled) {
          setPrControl(resolvePrProject({ ok: false, error: err instanceof Error ? err.message : String(err) }, projectRoots));
        }
      });
    }, 350);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [sourceKind, prUrl, projectRoots]);
  const prRoot = prPickedRoot ?? controlDefaultRoot(prControl);
  const storageRoot = sourceKind === "pull-request" ? prRoot : projectRoot;
  useEffect8(() => {
    if (!source) {
      setProbe({ status: "idle" });
      return;
    }
    let cancelled = false;
    const handle = window.setTimeout(() => {
      setProbe({ status: "probing" });
      void reviewDetectSource(source).then((result) => {
        if (cancelled) return;
        setProbe(result.ok ? { status: "ok", probe: result } : { status: "error", message: result.error ?? "Could not read this source." });
      }).catch((err) => {
        if (!cancelled) setProbe({ status: "error", message: err instanceof Error ? err.message : String(err) });
      });
    }, 350);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [source]);
  const canStart = Boolean(storageRoot && source && probe.status === "ok" && !starting);
  const start = async () => {
    if (!storageRoot || !source) return;
    setStarting(true);
    setError(null);
    try {
      const reviewId = await ingestReviewChange(
        { folderPath: storageRoot, source },
        { ingestSource: reviewIngestSource }
      );
      onCreated({ reviewId, workspaceRoot: storageRoot });
    } catch (err) {
      setError(err instanceof ReviewControllerError || err instanceof Error ? err.message : String(err));
    } finally {
      setStarting(false);
    }
  };
  const branchNames = branches?.branches ?? [];
  return /* @__PURE__ */ jsxs17("div", { className: "flex h-full w-full flex-col overflow-y-auto bg-[color:var(--bg-surface)] px-6 py-6", children: [
    /* @__PURE__ */ jsxs17("header", { className: "mb-5 max-w-xl", children: [
      /* @__PURE__ */ jsx18("h2", { className: "text-title font-semibold leading-6 tracking-tight text-[color:var(--text-strong)]", children: "Review a change" }),
      /* @__PURE__ */ jsx18("p", { className: "mt-1 text-body leading-5 text-[color:var(--text-muted)]", children: "Point the guide at a pull request, a pair of branches, or a pasted patch. It reads the change and prepares a walkthrough \u2014 no workspace, no project row." })
    ] }),
    /* @__PURE__ */ jsxs17("div", { className: "max-w-xl space-y-4", children: [
      sourceKind !== "pull-request" ? projectItems.length > 0 ? /* @__PURE__ */ jsx18(
        Field,
        {
          label: "Project",
          htmlFor: "review-change-project",
          help: "Where the change lives. Branch reads run against this repository.",
          children: /* @__PURE__ */ jsx18(Select, { ariaLabel: "Project to review in", items: projectItems, value: projectRoot, onChange: setProjectRoot })
        }
      ) : /* @__PURE__ */ jsx18(InlineNotice5, { tone: "warn", className: "max-w-xl", children: "Open a project first \u2014 a review reads a change from one of your projects." }) : null,
      /* @__PURE__ */ jsxs17("div", { className: "flex flex-col gap-1.5", children: [
        /* @__PURE__ */ jsx18("span", { className: "text-meta font-medium text-[color:var(--text-default)]", children: "What are you reviewing?" }),
        /* @__PURE__ */ jsx18(SegmentedControl3, { ariaLabel: "What are you reviewing", items: SOURCE_SEGMENTS, value: sourceKind, onChange: setSourceKind })
      ] }),
      sourceKind === "pull-request" ? /* @__PURE__ */ jsxs17(Fragment4, { children: [
        /* @__PURE__ */ jsx18(
          Field,
          {
            label: "Pull request URL",
            htmlFor: "review-change-pr-url",
            help: "A github.com or GitHub Enterprise pull request. Private hosts use your saved token.",
            children: /* @__PURE__ */ jsx18(
              Input,
              {
                value: prUrl,
                onChange: (event) => setPrUrl(event.target.value),
                placeholder: "https://github.com/owner/repo/pull/123",
                size: "md"
              }
            )
          }
        ),
        /* @__PURE__ */ jsx18(PrProjectField, { control: prControl, selectedRoot: prRoot, onSelect: setPrPickedRoot })
      ] }) : null,
      sourceKind === "branch" ? /* @__PURE__ */ jsxs17(Fragment4, { children: [
        /* @__PURE__ */ jsx18(
          Field,
          {
            label: "Compare against",
            htmlFor: "review-change-base",
            help: "Base the walkthrough against this branch.",
            children: /* @__PURE__ */ jsx18(
              Input,
              {
                value: brBase,
                onChange: (event) => setBrBase(event.target.value),
                placeholder: "main",
                list: "review-change-branches",
                size: "md"
              }
            )
          }
        ),
        /* @__PURE__ */ jsx18(
          Field,
          {
            label: "Branch to review",
            htmlFor: "review-change-head",
            help: "Agent worktree branches appear here too \u2014 review your agents\u2019 work before it merges.",
            children: /* @__PURE__ */ jsx18(
              Input,
              {
                value: brHead,
                onChange: (event) => setBrHead(event.target.value),
                placeholder: "feature/\u2026",
                list: "review-change-branches",
                size: "md"
              }
            )
          }
        ),
        /* @__PURE__ */ jsx18("datalist", { id: "review-change-branches", children: branchNames.map((name) => /* @__PURE__ */ jsx18("option", { value: name }, name)) })
      ] }) : null,
      sourceKind === "patch" ? /* @__PURE__ */ jsxs17(Fragment4, { children: [
        /* @__PURE__ */ jsx18(
          Field,
          {
            label: "Patch text",
            htmlFor: "review-change-patch",
            help: "Paste unified diff or `git format-patch` output. Nothing leaves this machine.",
            children: /* @__PURE__ */ jsx18(
              Textarea2,
              {
                value: patchText,
                onChange: (event) => setPatchText(event.target.value),
                placeholder: "diff --git a/\u2026 b/\u2026",
                size: "md",
                className: "min-h-[120px] font-mono"
              }
            )
          }
        ),
        /* @__PURE__ */ jsx18(Field, { label: "Label (optional)", htmlFor: "review-change-patch-label", children: /* @__PURE__ */ jsx18(
          Input,
          {
            value: patchLabel,
            onChange: (event) => setPatchLabel(event.target.value),
            placeholder: "What this patch is",
            size: "md"
          }
        ) })
      ] }) : null,
      /* @__PURE__ */ jsx18(ProbeCard, { probe, sourceKind }),
      error ? /* @__PURE__ */ jsx18(InlineNotice5, { tone: "error", className: "max-w-xl", children: error }) : null,
      /* @__PURE__ */ jsxs17("div", { className: "flex items-center gap-2 pt-1", children: [
        /* @__PURE__ */ jsx18(PrimaryButton3, { onClick: start, disabled: !canStart, children: starting ? "Starting\u2026" : "Start review" }),
        /* @__PURE__ */ jsx18(GhostButton9, { onClick: onCancel, disabled: starting, children: "Cancel" })
      ] })
    ] })
  ] });
}
function PrProjectField({
  control,
  selectedRoot,
  onSelect
}) {
  if (control.kind === "hidden") return null;
  if (control.kind === "matching") {
    return /* @__PURE__ */ jsxs17("p", { className: "flex items-center gap-2 text-meta text-[color:var(--text-muted)]", children: [
      /* @__PURE__ */ jsx18(StatusDot2, { tone: "neutral" }),
      "Finding the matching project\u2026"
    ] });
  }
  if (control.kind === "no-projects") {
    return /* @__PURE__ */ jsx18(InlineNotice5, { tone: "warn", className: "max-w-xl", children: "Open a project first \u2014 a review is stored inside one of your open projects." });
  }
  if (control.kind === "confirmed") {
    return /* @__PURE__ */ jsxs17("p", { className: "text-meta leading-5 text-[color:var(--text-muted)]", children: [
      "Stored in ",
      /* @__PURE__ */ jsx18("span", { className: "font-medium text-[color:var(--text-default)]", children: projectLabel(control.root) }),
      " \u2014 the open project that matches this pull request."
    ] });
  }
  const items = control.roots.map((root) => ({ value: root, label: projectLabel(root) }));
  return /* @__PURE__ */ jsx18(
    Field,
    {
      label: "Store the review in",
      htmlFor: "review-change-storage-project",
      help: CHOOSE_HELP[control.reason],
      children: /* @__PURE__ */ jsx18(Select, { ariaLabel: "Project to store the review in", items, value: selectedRoot, onChange: onSelect })
    }
  );
}
var CHOOSE_HELP = {
  many: "Several open projects are checkouts of this repository \u2014 pick which one keeps the review.",
  none: "No open project matches this pull request. Pick where to keep the review \u2014 the walkthrough still reads the change from the pull request itself.",
  error: "Could not check which project matches this pull request. Pick where to keep the review."
};
function ProbeCard({ probe, sourceKind }) {
  if (probe.status === "idle") return null;
  if (probe.status === "probing") {
    return /* @__PURE__ */ jsxs17("p", { className: "flex items-center gap-2 text-meta text-[color:var(--text-muted)]", children: [
      /* @__PURE__ */ jsx18(StatusDot2, { tone: "neutral", pulse: true, label: "Reading the change" }),
      "Reading the change\u2026"
    ] });
  }
  if (probe.status === "error") {
    return (
      // Three lines from the real InlineNotice this same file uses at three other
      // call sites (MC-2115): same failure, same scope, so it is the same card.
      /* @__PURE__ */ jsx18(InlineNotice5, { tone: "error", children: probe.message })
    );
  }
  const { title, stats } = probe.probe;
  return /* @__PURE__ */ jsxs17("div", { className: "flex items-start gap-2 rounded-sm border border-[color:var(--border-default)] bg-[color:var(--bg-surface-raised)] px-3 py-2", children: [
    /* @__PURE__ */ jsx18(StatusDot2, { tone: "accent", label: reachabilityLabel(sourceKind), className: "mt-1.5" }),
    /* @__PURE__ */ jsxs17("div", { className: "min-w-0", children: [
      /* @__PURE__ */ jsx18("p", { className: "truncate text-body text-[color:var(--text-default)]", children: title ?? "Ready to review" }),
      stats ? /* @__PURE__ */ jsxs17("p", { className: "font-mono text-micro tabular-nums text-[color:var(--text-subtle)]", children: [
        stats.files,
        " ",
        stats.files === 1 ? "file" : "files",
        " \xB7 ",
        /* @__PURE__ */ jsxs17("span", { className: "text-[color:var(--tone-good)]", children: [
          "+",
          stats.additions
        ] }),
        " ",
        /* @__PURE__ */ jsxs17("span", { className: "text-[color:var(--tone-error)]", children: [
          "\u2212",
          stats.deletions
        ] })
      ] }) : null
    ] })
  ] });
}
function reachabilityLabel(kind) {
  if (kind === "branch") return "Local";
  if (kind === "patch") return "Valid diff";
  return "Reachable";
}
function projectLabel(root) {
  const parts = root.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? root;
}
function pickBaseDefault(snapshot) {
  const names = snapshot.branches;
  for (const preferred of ["main", "master", "develop"]) {
    if (preferred !== snapshot.current && names.includes(preferred)) return preferred;
  }
  return names.find((name) => name !== snapshot.current) ?? "";
}

// src/shared/review-state.ts
var REVIEW_STATE_PRESENTATION = {
  draft: { tone: "neutral", label: "Draft", dotLabel: "Draft \u2014 no walkthrough yet" },
  "in-progress": { tone: "accent", label: "In progress", dotLabel: "In progress" },
  posted: { tone: "good", label: "Posted", dotLabel: "Posted to the pull request" }
};

// src/renderer/door/reviewRailModel.ts
function reviewRailRow(entry) {
  const base = { reviewId: entry.reviewId, workspaceRoot: entry.workspaceRoot, title: entry.title };
  if (!entry.hasWalkthrough) {
    const p2 = REVIEW_STATE_PRESENTATION.draft;
    return { ...base, status: "draft", tone: p2.tone, stateLine: `${entry.projectName} \xB7 draft`, dotLabel: p2.dotLabel };
  }
  if (entry.postedComments > 0 && entry.pendingComments === 0) {
    const p2 = REVIEW_STATE_PRESENTATION.posted;
    return { ...base, status: "posted", tone: p2.tone, stateLine: `${entry.projectName} \xB7 posted`, dotLabel: p2.dotLabel };
  }
  const p = REVIEW_STATE_PRESENTATION["in-progress"];
  return {
    ...base,
    status: "in-progress",
    tone: p.tone,
    stateLine: `${entry.projectName} \xB7 ${readProgressLabel(entry)}`,
    dotLabel: p.dotLabel
  };
}
function readProgressLabel(entry) {
  const total = entry.fileCount;
  if (total === 0) return "no files";
  const read = Math.min(Math.max(entry.readFileCount, 0), total);
  if (read >= total) return "all files read";
  return `${read} of ${total} files read`;
}
var STATUS_ORDER = { "in-progress": 0, draft: 1, posted: 2 };
function orderReviewRail(entries) {
  return entries.map((entry, index) => ({ row: reviewRailRow(entry), index })).sort((a, b) => STATUS_ORDER[a.row.status] - STATUS_ORDER[b.row.status] || a.index - b.index).map((wrapped) => wrapped.row);
}
function resolveReviewAutoSelect(entries, rows, remembered) {
  const match = remembered ? entries.find(
    (entry) => entry.reviewId === remembered.reviewId && entry.workspaceRoot === remembered.workspaceRoot
  ) : void 0;
  if (match) {
    return {
      select: { reviewId: match.reviewId, workspaceRoot: match.workspaceRoot },
      clearRemembered: false
    };
  }
  const first = rows[0];
  return {
    select: first ? { reviewId: first.reviewId, workspaceRoot: first.workspaceRoot } : null,
    clearRemembered: remembered !== null
  };
}

// src/renderer/door/ReviewSurfaceBar.tsx
import { GhostButton as GhostButton11, PrimaryButton as PrimaryButton4 } from "@sprintengine/module-sdk/ui";
import { Spinner as Spinner3 } from "@sprintengine/module-sdk/ui";

// src/renderer/door/ReviewGuideStop.tsx
import { useCallback as useCallback6, useState as useState11 } from "react";
import { GhostButton as GhostButton10, InlineNotice as InlineNotice6 } from "@sprintengine/module-sdk/ui";
import { Fragment as Fragment5, jsx as jsx19, jsxs as jsxs18 } from "react/jsx-runtime";
function StopGuideRunButton({ session }) {
  const [stopping, setStopping] = useState11(false);
  const [error, setError] = useState11(null);
  const { reviewId, workspaceRoot } = session;
  const stop = useCallback6(async () => {
    if (!reviewId || !workspaceRoot) return;
    setError(null);
    setStopping(true);
    try {
      await reviewStopBriefRun({ workspaceId: reviewId, workspaceRoot });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setStopping(false);
    }
  }, [reviewId, workspaceRoot]);
  if (!reviewId || !workspaceRoot) return null;
  return /* @__PURE__ */ jsxs18(Fragment5, { children: [
    error ? /* @__PURE__ */ jsxs18(InlineNotice6, { tone: "error", className: "shrink-0", children: [
      "The guide couldn\u2019t be stopped: ",
      error
    ] }) : null,
    /* @__PURE__ */ jsxs18(GhostButton10, { onClick: () => void stop(), disabled: stopping, className: "shrink-0", children: [
      /* @__PURE__ */ jsx19("svg", { viewBox: "0 0 16 16", className: "icon-sm", fill: "none", "aria-hidden": "true", children: /* @__PURE__ */ jsx19("rect", { x: "4.25", y: "4.25", width: "7.5", height: "7.5", rx: "1.25", stroke: "currentColor", strokeWidth: "1.4" }) }),
      stopping ? "Stopping\u2026" : "Stop"
    ] })
  ] });
}

// src/renderer/door/ReviewSurfaceBar.tsx
import { Fragment as Fragment6, jsx as jsx20, jsxs as jsxs19 } from "react/jsx-runtime";
function buildReviewsSurfaceBar(entry, session, guideControls) {
  const changeset = session.changeset;
  const title = changeset?.title ?? entry?.title ?? "Review";
  const live = session.status === "ready" || session.status === "degraded";
  return {
    title,
    actions: live ? /* @__PURE__ */ jsxs19(Fragment6, { children: [
      guideControls,
      /* @__PURE__ */ jsx20(ReviewBarActions, { session })
    ] }) : void 0
  };
}
function ReviewBarActions({ session }) {
  const pending = session.pendingComments;
  const showPostCta = session.isPullRequest && pending > 0;
  return showPostCta ? /* @__PURE__ */ jsxs19(PrimaryButton4, { onClick: session.openTray, className: "shrink-0", children: [
    "Post review",
    /* @__PURE__ */ jsxs19("span", { className: "tabular-nums", children: [
      " \xB7 ",
      pending,
      " ",
      pending === 1 ? "comment" : "comments"
    ] })
  ] }) : /* @__PURE__ */ jsxs19(GhostButton11, { onClick: session.openTray, className: "shrink-0", children: [
    "Your review",
    pending > 0 ? /* @__PURE__ */ jsxs19("span", { className: "font-medium tabular-nums text-[color:var(--text-strong)]", children: [
      " \xB7 ",
      pending
    ] }) : null
  ] });
}
function ReviewCanvasTools({ session }) {
  const guideActions = !session.isDegraded;
  const running = session.run.running;
  return /* @__PURE__ */ jsxs19("span", { className: "flex flex-wrap items-center justify-end gap-1.5", children: [
    !guideActions ? null : running ? /* @__PURE__ */ jsxs19(Fragment6, { children: [
      /* @__PURE__ */ jsxs19("span", { className: "flex shrink-0 items-center gap-1.5 text-meta text-[color:var(--text-muted)]", children: [
        /* @__PURE__ */ jsx20(Spinner3, {}),
        "Re-running\u2026"
      ] }),
      /* @__PURE__ */ jsx20(StopGuideRunButton, { session })
    ] }) : /* @__PURE__ */ jsxs19(GhostButton11, { onClick: session.refresh, className: "shrink-0", children: [
      /* @__PURE__ */ jsx20("svg", { viewBox: "0 0 16 16", className: "icon-sm", fill: "none", "aria-hidden": "true", children: /* @__PURE__ */ jsx20(
        "path",
        {
          d: "M13 8a5 5 0 1 1-1.46-3.54M13 3v2.5h-2.5",
          stroke: "currentColor",
          strokeWidth: "1.4",
          strokeLinecap: "round",
          strokeLinejoin: "round"
        }
      ) }),
      "Re-run"
    ] }),
    guideActions ? /* @__PURE__ */ jsxs19(GhostButton11, { onClick: session.openAsk, className: "shrink-0", children: [
      /* @__PURE__ */ jsx20("svg", { viewBox: "0 0 16 16", className: "icon-sm", fill: "currentColor", "aria-hidden": "true", children: /* @__PURE__ */ jsx20("path", { d: "M8 1l1.6 4.4L14 7l-4.4 1.6L8 13l-1.6-4.4L2 7l4.4-1.6z" }) }),
      "Ask the guide"
    ] }) : null
  ] });
}

// src/renderer/door/ReviewGuideControls.tsx
init_editor();
import { useCallback as useCallback7, useEffect as useEffect9, useId, useRef as useRef9, useState as useState12 } from "react";
import {
  CliModelPickerButton,
  Drawer as Drawer2,
  GhostButton as GhostButton12,
  InlineNotice as InlineNotice7,
  KbdChord as KbdChord3,
  OutlineButton as OutlineButton3,
  PrimaryButton as PrimaryButton5,
  SegmentedControl as SegmentedControl4,
  Spinner as Spinner4,
  Textarea as Textarea3
} from "@sprintengine/module-sdk/ui";

// src/renderer/door/reviewAppState.ts
import { useMemo as useMemo6 } from "react";
var REVIEW_GUIDE_DEFAULTS_KEY = "guide-defaults";
var LAST_SELECTED_REVIEW_KEY = "last-selected-review";
var REVIEW_GUIDE_DEPTHS = ["brief", "standard", "thorough"];
function normalizeReviewGuideDefaults(input) {
  const source = input && typeof input === "object" ? input : {};
  const depth = REVIEW_GUIDE_DEPTHS.includes(source.depth) ? source.depth : "standard";
  const cli = typeof source.cli === "string" && source.cli.trim() ? source.cli.trim() : null;
  const model = cli && typeof source.model === "string" && source.model.trim() ? source.model.trim() : null;
  return { depth, cli, model };
}
function normalizeLastSelectedReview(input) {
  if (!input || typeof input !== "object") return null;
  const source = input;
  const reviewId = typeof source.reviewId === "string" ? source.reviewId.trim() : "";
  const workspaceRoot = typeof source.workspaceRoot === "string" ? source.workspaceRoot.trim() : "";
  if (!reviewId || !workspaceRoot) return null;
  return { reviewId, workspaceRoot };
}
function readReviewGuideDefaults() {
  return normalizeReviewGuideDefaults(reviewHost().getModuleAppState(REVIEW_GUIDE_DEFAULTS_KEY));
}
function writeReviewGuideDefaults(patch) {
  const next = normalizeReviewGuideDefaults({ ...readReviewGuideDefaults(), ...patch });
  reviewHost().setModuleAppState(REVIEW_GUIDE_DEFAULTS_KEY, next);
}
function writeLastSelectedReview(selection) {
  reviewHost().setModuleAppState(LAST_SELECTED_REVIEW_KEY, normalizeLastSelectedReview(selection));
}
function useReviewGuideDefaults() {
  const raw = useRawModuleAppState(REVIEW_GUIDE_DEFAULTS_KEY);
  return useMemo6(() => normalizeReviewGuideDefaults(raw), [raw]);
}
function useLastSelectedReview() {
  const raw = useRawModuleAppState(LAST_SELECTED_REVIEW_KEY);
  return useMemo6(() => normalizeLastSelectedReview(raw), [raw]);
}

// src/renderer/door/ReviewGuideControls.tsx
import { jsx as jsx21, jsxs as jsxs20 } from "react/jsx-runtime";
function useReviewGuideRuntime() {
  const defaults = useReviewGuideDefaults();
  const catalog = useAgentRuntimes();
  const cli = resolveRuntime(defaults.cli, catalog);
  const setDepth = useCallback7((depth) => writeReviewGuideDefaults({ depth }), []);
  const setCli = useCallback7((next) => writeReviewGuideDefaults({ cli: next, model: null }), []);
  const setModel = useCallback7(
    (nextCli, nextModel) => writeReviewGuideDefaults({ cli: nextCli, model: nextModel }),
    []
  );
  return {
    depth: defaults.depth,
    cli,
    // Model ids are only meaningful for the CLI they were picked for — a stored
    // model whose engine has since fallen out of the catalog is not offered.
    ...defaults.model && defaults.cli === cli ? { model: defaults.model } : {},
    catalog,
    setDepth,
    setCli,
    setModel
  };
}
var DEPTH_SEGMENTS = [
  { value: "brief", label: "Overview" },
  { value: "standard", label: "Standard" },
  { value: "thorough", label: "Deep" }
];
var DEPTH_HINT = {
  brief: "Steps and files with the reason for each \u2014 the fastest way in.",
  standard: "Adds notes on the lines worth pausing on, and a change map.",
  thorough: "Adds the detail behind each note and links to project knowledge."
};
function ReviewGuideActions({
  session,
  runtime,
  terminal
}) {
  const depthHintId = useId();
  if (!session.canRunGuide) {
    return /* @__PURE__ */ jsx21(InlineNotice7, { tone: "warn", className: "shrink-0", children: "Open Reviews from a workspace to prepare a walkthrough \u2014 the guide runs as an agent in it." });
  }
  if (session.run.running) {
    return /* @__PURE__ */ jsxs20("span", { className: "flex shrink-0 items-center gap-2", children: [
      /* @__PURE__ */ jsxs20("span", { className: "flex shrink-0 items-center gap-1.5 text-meta text-[color:var(--text-muted)]", children: [
        /* @__PURE__ */ jsx21(Spinner4, {}),
        RUN_PHASE_LABEL[session.run.phase ?? "reading"] ?? RUN_PHASE_LABEL.grouping
      ] }),
      terminal.terminal ? /* @__PURE__ */ jsx21(GhostButton12, { onClick: () => void terminal.open(), className: "shrink-0", children: "Open the guide\u2019s terminal" }) : null,
      /* @__PURE__ */ jsx21(StopGuideRunButton, { session })
    ] });
  }
  const failed = Boolean(session.run.error);
  return /* @__PURE__ */ jsxs20("span", { className: "flex shrink-0 items-center gap-2", children: [
    /* @__PURE__ */ jsx21(
      SegmentedControl4,
      {
        ariaLabel: "Walkthrough depth",
        ariaDescribedBy: depthHintId,
        items: DEPTH_SEGMENTS,
        value: runtime.depth,
        onChange: runtime.setDepth,
        size: "sm"
      }
    ),
    /* @__PURE__ */ jsx21(
      CliModelPickerButton,
      {
        ariaLabel: "Guide agent",
        options: runtime.catalog,
        cli: runtime.cli,
        effectiveModelFor: (candidate) => candidate === runtime.cli ? runtime.model : void 0,
        onSelectCli: runtime.setCli,
        onSelectModel: (nextCli, nextModel) => {
          if (nextCli !== runtime.cli) runtime.setCli(nextCli);
          runtime.setModel(nextCli, nextModel);
        }
      }
    ),
    /* @__PURE__ */ jsx21(OutlineButton3, { onClick: session.startRun, className: "shrink-0", children: failed ? "Try again" : "Prepare walkthrough" }),
    /* @__PURE__ */ jsx21("span", { id: depthHintId, className: "sr-only", children: DEPTH_HINT[runtime.depth] })
  ] });
}
var PRIMARY_KEY3 = primaryModifierLabel();
function AskGuideDrawer({
  session,
  terminal
}) {
  const { askController } = session;
  const [draft, setDraft] = useState12("");
  const [sending, setSending] = useState12(false);
  const [error, setError] = useState12(null);
  const inputRef = useRef9(null);
  useEffect9(() => {
    if (!askController.prefill) return;
    setDraft(askController.prefill.text);
    const node = inputRef.current;
    if (node) {
      node.focus();
      node.setSelectionRange(node.value.length, node.value.length);
    }
  }, [askController.prefill?.nonce]);
  const send = useCallback7(async () => {
    const message = draft.trim();
    if (!message || sending) return;
    setError(null);
    setSending(true);
    const result = await session.askGuide(message);
    setSending(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setDraft("");
    askController.setOpen(false);
    void terminal.open();
  }, [draft, sending, session, askController, terminal]);
  return /* @__PURE__ */ jsx21(
    Drawer2,
    {
      open: askController.open,
      onClose: () => askController.setOpen(false),
      title: "Ask the guide",
      ariaLabel: "Ask the review guide about this change",
      width: 380,
      children: /* @__PURE__ */ jsxs20(Drawer2.Body, { className: "flex flex-col", children: [
        /* @__PURE__ */ jsx21("p", { className: "text-meta leading-5 text-[color:var(--text-muted)]", children: "Your question goes to the guide\u2019s terminal, and it answers there. Sending opens that terminal." }),
        /* @__PURE__ */ jsx21(
          Textarea3,
          {
            ref: inputRef,
            value: draft,
            onChange: (event) => setDraft(event.target.value),
            onKeyDown: (event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                void send();
              }
            },
            "aria-label": "Your question for the guide",
            placeholder: "Ask about any line, step, or decision\u2026",
            rows: 6,
            size: "sm",
            resize: "none",
            className: "mt-3 min-h-[120px] flex-1"
          }
        ),
        error ? /* @__PURE__ */ jsxs20(InlineNotice7, { tone: "error", className: "mt-2", children: [
          "The guide couldn\u2019t be reached: ",
          error
        ] }) : null,
        /* @__PURE__ */ jsxs20("div", { className: "mt-3 flex items-center justify-between gap-2", children: [
          /* @__PURE__ */ jsxs20("span", { className: "flex items-center gap-1 text-micro text-[color:var(--text-subtle)]", children: [
            /* @__PURE__ */ jsx21(KbdChord3, { keys: [PRIMARY_KEY3, "Enter"] }),
            " send"
          ] }),
          /* @__PURE__ */ jsx21(PrimaryButton5, { onClick: () => void send(), disabled: !draft.trim() || sending, className: "shrink-0", children: sending ? "Sending\u2026" : "Send" })
        ] })
      ] })
    }
  );
}

// src/renderer/door/useGuideTerminal.ts
import { useCallback as useCallback8, useMemo as useMemo7 } from "react";

// src/renderer/door/reviewGuideTerminal.ts
var REVIEW_GUIDE_AGENT_ID_PREFIX = "review-guide-";
function reviewGuideAgentId(reviewId) {
  return `${REVIEW_GUIDE_AGENT_ID_PREFIX}${reviewId}`;
}
function resolveGuideTerminal({
  reviewId,
  guide,
  sessions,
  workspaceId
}) {
  const agentId = reviewId ? reviewGuideAgentId(reviewId) : guide?.agentId ?? null;
  if (!agentId) return null;
  const home = workspaceId ?? guide?.workspaceId ?? "";
  if (!home) return null;
  const session = sessions.find((candidate) => candidate.agentId === agentId);
  if (session) {
    return { workspaceId: home, agentId, sessionId: session.sessionId, isLive: session.isLive };
  }
  if (!guide) return null;
  return {
    workspaceId: home,
    agentId: guide.agentId,
    ...guide.sessionId ? { sessionId: guide.sessionId } : {},
    // No live session carries this agent id, so whatever the handle described is
    // gone. The link stays visible (the tab can still be focused) but nothing
    // treats it as a running process.
    isLive: false
  };
}

// src/renderer/door/useGuideTerminal.ts
function useGuideTerminal({
  reviewId,
  guide,
  workspaceId
}) {
  const sessions = useReviewAgentSessions();
  const terminal = useMemo7(
    () => resolveGuideTerminal({ reviewId, guide, sessions, ...workspaceId ? { workspaceId } : {} }),
    [reviewId, guide, sessions, workspaceId]
  );
  const open = useCallback8(async () => {
    if (!terminal) return;
    if (!terminal.isLive) return;
    try {
      reviewHost().focusTab({ workspaceId: terminal.workspaceId, kind: "agent", id: terminal.agentId });
    } catch {
    }
  }, [terminal]);
  return { terminal, open };
}

// src/renderer/door/ReviewsGlobalSurface.tsx
import { Fragment as Fragment7, jsx as jsx22, jsxs as jsxs21 } from "react/jsx-runtime";
var REVIEW_INDEX_REFRESH_MS = 15e3;
var ALL_PROJECTS = " all";
var ALL_STATUSES = "all";
function ReviewsGlobalSurface({ workspaceId }) {
  const roots = useReviewProjectRoots();
  const back = useSurfaceBackNav();
  const lastSelectedReview = useLastSelectedReview();
  const setLastSelectedReview = writeLastSelectedReview;
  const [index, setIndex] = useState13({ phase: "loading" });
  const [selected, setSelected] = useState13(null);
  const [creating, setCreating] = useState13(false);
  const reload = useCallback9(async () => {
    try {
      const result = await reviewList(roots);
      setIndex(result.ok ? { phase: "ready", entries: result.reviews } : { phase: "error", message: result.error });
    } catch (error) {
      setIndex({ phase: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }, [roots]);
  const refreshIndex = useCallback9(async () => {
    try {
      const result = await reviewList(roots);
      if (result.ok) setIndex({ phase: "ready", entries: result.reviews });
    } catch {
    }
  }, [roots]);
  useEffect10(() => {
    void reload();
  }, [reload]);
  const entries = index.phase === "ready" ? index.entries : [];
  const rows = useMemo8(() => orderReviewRail(entries), [entries]);
  const selectedEntry = selected ? entries.find((entry) => entry.reviewId === selected.reviewId) ?? null : null;
  const [railSearch, setRailSearch] = useState13("");
  const [railProject, setRailProject] = useState13(ALL_PROJECTS);
  const [railStatus, setRailStatus] = useState13(ALL_STATUSES);
  const visibleRows = useMemo8(() => {
    const query = railSearch.trim().toLowerCase();
    const projectByRoot = new Map(entries.map((entry) => [entry.workspaceRoot, entry.projectName]));
    return rows.filter((row) => {
      if (railProject !== ALL_PROJECTS && row.workspaceRoot !== railProject) return false;
      if (railStatus !== ALL_STATUSES && row.status !== railStatus) return false;
      if (!query) return true;
      return row.title.toLowerCase().includes(query) || (projectByRoot.get(row.workspaceRoot) ?? "").toLowerCase().includes(query);
    });
  }, [rows, entries, railSearch, railProject, railStatus]);
  const railFilterGroups = useMemo8(() => {
    const byRoot = /* @__PURE__ */ new Map();
    for (const entry of entries) {
      const existing = byRoot.get(entry.workspaceRoot);
      if (existing) existing.count += 1;
      else byRoot.set(entry.workspaceRoot, { label: entry.projectName, count: 1 });
    }
    const groups = [];
    if (byRoot.size > 1) {
      groups.push({
        label: "Project",
        items: [
          { value: ALL_PROJECTS, label: `All projects \xB7 ${entries.length}` },
          ...[...byRoot.entries()].map(([root, info]) => ({ value: root, label: `${info.label} \xB7 ${info.count}` })).sort((a, b) => a.label.localeCompare(b.label))
        ],
        value: railProject,
        defaultValue: ALL_PROJECTS,
        onChange: setRailProject
      });
    }
    groups.push({
      label: "Status",
      items: [
        { value: ALL_STATUSES, label: "All" },
        { value: "in-progress", label: "In progress" },
        { value: "draft", label: "Draft" },
        { value: "posted", label: "Posted" }
      ],
      value: railStatus,
      defaultValue: ALL_STATUSES,
      onChange: setRailStatus
    });
    return groups;
  }, [entries, railProject, railStatus]);
  useEffect10(() => {
    if (index.phase !== "ready" || creating || selected) return;
    const decision = resolveReviewAutoSelect(entries, rows, lastSelectedReview);
    if (decision.clearRemembered) setLastSelectedReview(null);
    if (decision.select) setSelected(decision.select);
  }, [index.phase, creating, selected, rows, entries, lastSelectedReview, setLastSelectedReview]);
  const guideRuntime = useReviewGuideRuntime();
  const selectedRoot = selected?.workspaceRoot ?? null;
  const session = useReviewSession({
    reviewId: selected?.reviewId ?? null,
    workspaceRoot: selectedRoot,
    depth: guideRuntime.depth,
    guideCli: guideRuntime.cli,
    // The workspace the modal was opened from (D5) — where the guide's terminal
    // goes. Absent when nothing opened it from a workspace; the guide controls
    // say so and withhold the start rather than picking one.
    ...workspaceId ? { workspaceId } : {},
    ...guideRuntime.model ? { guideModel: guideRuntime.model } : {}
  });
  const guideTerminal = useGuideTerminal({
    reviewId: selected?.reviewId ?? null,
    guide: session.guide,
    ...workspaceId ? { workspaceId } : {}
  });
  const guideActions = /* @__PURE__ */ jsx22(ReviewGuideActions, { session, runtime: guideRuntime, terminal: guideTerminal });
  useEffect10(() => {
    const id = window.setInterval(() => void refreshIndex(), REVIEW_INDEX_REFRESH_MS);
    return () => window.clearInterval(id);
  }, [refreshIndex]);
  const prevPostPhase = useRef10(session.postState.phase);
  useEffect10(() => {
    const previous = prevPostPhase.current;
    prevPostPhase.current = session.postState.phase;
    if (previous === "posting" && session.postState.phase === "idle") void refreshIndex();
  }, [session.postState.phase, refreshIndex]);
  const onSelect = useCallback9((reviewId) => {
    setCreating(false);
    const row = rows.find((r) => r.reviewId === reviewId);
    if (row) {
      const next = { reviewId: row.reviewId, workspaceRoot: row.workspaceRoot };
      setSelected(next);
      setLastSelectedReview(next);
    }
  }, [rows, setLastSelectedReview]);
  const onNewReview = useCallback9(() => setCreating(true), []);
  const onCreated = useCallback9(
    (review) => {
      setCreating(false);
      setSelected(review);
      setLastSelectedReview(review);
      void reload();
    },
    [reload, setLastSelectedReview]
  );
  const onCancelCreate = useCallback9(() => setCreating(false), []);
  const bar = buildBar({
    creating,
    hasSelection: selected !== null,
    selectedEntry,
    session,
    // Whichever the review is asking for right now: the preparation choices while
    // there is no walkthrough, the walkthrough's own tools once there is one.
    guideControls: session.isDegraded || session.run.running ? guideActions : /* @__PURE__ */ jsx22(ReviewCanvasTools, { session })
  });
  const rail = /* @__PURE__ */ jsx22(
    ReviewsRail,
    {
      rows: visibleRows,
      selectedReviewId: selected?.reviewId ?? null,
      newSelected: creating,
      search: {
        value: railSearch,
        onChange: setRailSearch,
        placeholder: "Search reviews\u2026",
        ariaLabel: "Search reviews across every project"
      },
      filter: { ariaLabel: "Filter reviews", groups: railFilterGroups },
      onSelect,
      onNewReview,
      emptyNotice: rows.length > 0 ? "No reviews match." : void 0
    }
  );
  return /* @__PURE__ */ jsxs21(Fragment7, { children: [
    /* @__PURE__ */ jsx22(GlobalSurfaceShell, { ariaLabel: "Reviews", bar, rail, onBack: back.onBack, canGoBack: back.canGoBack, children: renderCanvas({ index, creating, hasSelection: selected !== null, session, guideActions, roots, onRetry: reload, onCreated, onCancelCreate, onNewReview }) }),
    selected ? /* @__PURE__ */ jsx22(AskGuideDrawer, { session, terminal: guideTerminal }) : null
  ] });
}
function buildBar({
  creating,
  hasSelection,
  selectedEntry,
  session,
  guideControls
}) {
  if (creating) return { title: "Review a change" };
  if (hasSelection) return buildReviewsSurfaceBar(selectedEntry, session, guideControls);
  return { title: "Reviews" };
}
function renderCanvas({
  index,
  creating,
  hasSelection,
  session,
  guideActions,
  roots,
  onRetry,
  onCreated,
  onCancelCreate,
  onNewReview
}) {
  if (creating) {
    return /* @__PURE__ */ jsx22(ReviewChangeForm, { projectRoots: roots, onCreated, onCancel: onCancelCreate });
  }
  if (hasSelection) {
    return /* @__PURE__ */ jsx22(ReviewCanvas, { session, guideActions });
  }
  if (index.phase === "loading") {
    return /* @__PURE__ */ jsx22(SurfaceCanvasState, { kind: "loading", label: "Loading reviews\u2026" });
  }
  if (index.phase === "error") {
    return /* @__PURE__ */ jsx22(
      SurfaceCanvasState,
      {
        kind: "error",
        title: "Couldn\u2019t list your reviews.",
        hint: "This is usually temporary.",
        detail: index.message,
        onRetry
      }
    );
  }
  return /* @__PURE__ */ jsx22(
    SurfaceCanvasState,
    {
      kind: "empty",
      firstRun: true,
      glyph: /* @__PURE__ */ jsx22(ReviewsDoorGlyph, {}),
      title: "No reviews yet",
      body: "Reviews from every project collect here. Start one from a pull request, branch, or patch and the guide walks you through the change.",
      action: /* @__PURE__ */ jsx22(PrimaryButton6, { onClick: onNewReview, children: "Review a change" })
    }
  );
}
function ReviewsDoorGlyph() {
  return /* @__PURE__ */ jsxs21("svg", { viewBox: "0 0 16 16", className: "icon-lg", fill: "none", "aria-hidden": "true", children: [
    /* @__PURE__ */ jsx22("circle", { cx: "8", cy: "8", r: "5.5", stroke: "currentColor", strokeWidth: "1.4" }),
    /* @__PURE__ */ jsx22("circle", { cx: "8", cy: "8", r: "2", fill: "currentColor" })
  ] });
}

// src/renderer.tsx
var registerRenderer = (host) => {
  bindHost(host);
  injectReviewStyles();
  host.registerModalSurface({
    id: "reviews",
    label: "Reviews",
    Component: ReviewsGlobalSurface,
    // The pane row, drawn exactly like the shell's own kinds. `R` is free among
    // the built-ins (B, T, F, D, G, L); a collision would leave the row its label
    // and glyph and drop only the shortcut, so this is never a load failure.
    launcher: { label: "Reviews", letter: "R", Glyph: ReviewsGlyph }
  });
  host.registerAgentIdNamespace({ prefix: REVIEW_GUIDE_AGENT_ID_PREFIX, label: "Reviews" });
};
var renderer_default = registerRenderer;
export {
  renderer_default as default,
  registerRenderer
};
