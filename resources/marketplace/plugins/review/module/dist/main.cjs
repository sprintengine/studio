"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/main.ts
var main_exports = {};
__export(main_exports, {
  registerMain: () => registerMain
});
module.exports = __toCommonJS(main_exports);
var import_os2 = require("os");
var import_electron = require("electron");

// node_modules/@sprintengine/module-sdk/dist/plugin-manifest.js
var MARKETPLACE_COMPONENT_KINDS = [
  "mcp",
  "skills",
  "module",
  "cli",
  "automation"
];
var COMPONENT_KIND_SET = new Set(MARKETPLACE_COMPONENT_KINDS);

// node_modules/@sprintengine/module-sdk/dist/index.js
function createServiceToken(key) {
  return { key };
}
var WorkspaceServiceToken = createServiceToken("core.workspace");
var WorkspaceContextToken = createServiceToken("core.workspace-context");
var automationsProviderRegistryToken = createServiceToken("automations.provider-registry");
var automationsModuleServiceToken = createServiceToken("automations.module-service");
var companionAgentsModuleServiceToken = createServiceToken("companion-agents.module-service");
var agentSessionsModuleServiceToken = createServiceToken("agent-sessions.module-service");
function getAgentSessionService(host) {
  const registry = host.requireService(agentSessionsModuleServiceToken);
  const moduleId = host.moduleId;
  return {
    spawn: (request) => registry.spawn(moduleId, request),
    send: (sessionId, text) => registry.send(moduleId, sessionId, text),
    kill: (sessionId) => registry.kill(moduleId, sessionId),
    setReapExempt: (sessionId, exempt) => registry.setReapExempt(moduleId, sessionId, exempt),
    onExit: (listener) => registry.onExit(moduleId, listener),
    list: () => registry.list(moduleId)
  };
}
var moduleStorageToken = createServiceToken("core.module-storage");

// src/main/brief-run-service.ts
var import_promises = require("fs/promises");
var import_crypto = require("crypto");
var import_path = require("path");

// src/shared/guards.ts
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}
function isNonNegativeInt(value) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}
function isPositiveInt(value) {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}
var ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;
function isIsoTimestamp(value) {
  return typeof value === "string" && ISO_TIMESTAMP.test(value) && !Number.isNaN(Date.parse(value));
}
function describeValue(value) {
  if (typeof value === "string") return JSON.stringify(value);
  if (value === null) return "null";
  if (value === void 0) return "undefined";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return "an array";
  if (typeof value === "object") return "an object";
  return typeof value;
}
function checkEnum(value, allowed, path, errors) {
  if (typeof value === "string" && allowed.includes(value)) return true;
  errors.push(`${path} has unknown value ${describeValue(value)}; expected one of ${allowed.map((v) => JSON.stringify(v)).join(", ")}.`);
  return false;
}
function checkOptionalString(value, path, errors) {
  if (value !== void 0 && typeof value !== "string") {
    errors.push(`${path} must be a string when present.`);
  }
}
function checkBoundedString(value, maxLength, path, errors) {
  if (typeof value !== "string" || value.trim().length === 0) {
    errors.push(`${path} must be a non-empty string.`);
    return;
  }
  if (value.length > maxLength) {
    errors.push(`${path} must be ${maxLength} characters or fewer; got ${value.length}.`);
  }
}
function checkStringArray(value, path, errors) {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    errors.push(`${path} must be a string array.`);
    return false;
  }
  return true;
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// src/shared/anchors.ts
var ANCHOR_SIDES = ["new", "old"];
function validateAnchor(value, path, errors) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    errors.push(`${path} must be an object.`);
    return;
  }
  const anchor = value;
  checkEnum(anchor.side, ANCHOR_SIDES, `${path}.side`, errors);
  if (!isPositiveInt(anchor.startLine)) {
    errors.push(`${path}.startLine must be a positive integer; got ${describeValue(anchor.startLine)}.`);
  }
  if (!isPositiveInt(anchor.endLine)) {
    errors.push(`${path}.endLine must be a positive integer; got ${describeValue(anchor.endLine)}.`);
  }
  if (isPositiveInt(anchor.startLine) && isPositiveInt(anchor.endLine) && anchor.endLine < anchor.startLine) {
    errors.push(`${path}.endLine (${anchor.endLine}) must be >= startLine (${anchor.startLine}).`);
  }
  if (anchor.anchoredAtSha !== void 0 && typeof anchor.anchoredAtSha !== "string") {
    errors.push(`${path}.anchoredAtSha must be a string when present.`);
  }
}
function isAnchorWithinExtent(anchor, extent) {
  return anchor.startLine >= extent.min && anchor.endLine <= extent.max;
}
function shiftLine(line, sortedDeltas, bias) {
  let shifted = line;
  for (const delta of sortedDeltas) {
    const regionEnd = delta.start + delta.removed;
    if (line >= regionEnd) {
      shifted += delta.added - delta.removed;
    } else if (line >= delta.start) {
      const priorShift = shifted - line;
      const regionStart = delta.start + priorShift;
      if (bias === "start") return Math.max(1, regionStart);
      return Math.max(1, regionStart + delta.added - 1);
    }
  }
  return Math.max(1, shifted);
}
function shiftAnchor(anchor, deltas) {
  const sorted = [...deltas].sort((a, b) => a.start - b.start);
  const startLine = shiftLine(anchor.startLine, sorted, "start");
  const endLine = shiftLine(anchor.endLine, sorted, "end");
  if (endLine < startLine) return null;
  return { ...anchor, startLine, endLine };
}

// src/shared/changeset.ts
var CHANGESET_SCHEMA_VERSION = 1;
var REVIEW_SOURCE_KINDS = ["pull-request", "branch", "patch"];
var PULL_REQUEST_PROVIDERS = ["github", "github-enterprise"];
var CHANGE_FILE_STATUSES = ["added", "modified", "deleted", "renamed"];
var HUNK_LINE_KINDS = ["context", "add", "del"];
function validateSource(value, path, errors) {
  if (!isPlainObject(value)) {
    errors.push(`${path} must be an object.`);
    return;
  }
  if (!checkEnum(value.kind, REVIEW_SOURCE_KINDS, `${path}.kind`, errors)) return;
  switch (value.kind) {
    case "pull-request": {
      checkEnum(value.provider, PULL_REQUEST_PROVIDERS, `${path}.provider`, errors);
      if (!isNonEmptyString(value.host)) errors.push(`${path}.host must be a non-empty string.`);
      if (!isNonEmptyString(value.owner)) errors.push(`${path}.owner must be a non-empty string.`);
      if (!isNonEmptyString(value.repo)) errors.push(`${path}.repo must be a non-empty string.`);
      if (!Number.isInteger(value.number) || value.number <= 0) {
        errors.push(`${path}.number must be a positive integer; got ${describeValue(value.number)}.`);
      }
      if (!isNonEmptyString(value.url)) errors.push(`${path}.url must be a non-empty string.`);
      break;
    }
    case "branch": {
      if (!isNonEmptyString(value.repoRoot)) errors.push(`${path}.repoRoot must be a non-empty string.`);
      if (!isNonEmptyString(value.baseRef)) errors.push(`${path}.baseRef must be a non-empty string.`);
      if (!isNonEmptyString(value.headRef)) errors.push(`${path}.headRef must be a non-empty string.`);
      break;
    }
    case "patch": {
      checkOptionalString(value.label, `${path}.label`, errors);
      break;
    }
  }
}
function validateHunk(value, path, errors) {
  if (!isPlainObject(value)) {
    errors.push(`${path} must be an object.`);
    return;
  }
  for (const field of ["oldStart", "oldLines", "newStart", "newLines"]) {
    if (!isNonNegativeInt(value[field])) {
      errors.push(`${path}.${field} must be a non-negative integer; got ${describeValue(value[field])}.`);
    }
  }
  if (!Array.isArray(value.lines)) {
    errors.push(`${path}.lines must be an array.`);
    return;
  }
  value.lines.forEach((line, index) => {
    const linePath = `${path}.lines[${index}]`;
    if (!isPlainObject(line)) {
      errors.push(`${linePath} must be an object.`);
      return;
    }
    checkEnum(line.kind, HUNK_LINE_KINDS, `${linePath}.kind`, errors);
    if (typeof line.text !== "string") errors.push(`${linePath}.text must be a string.`);
  });
}
function validateFile(value, path, errors) {
  if (!isPlainObject(value)) {
    errors.push(`${path} must be an object.`);
    return;
  }
  if (!isNonEmptyString(value.path)) errors.push(`${path}.path must be a non-empty string.`);
  checkOptionalString(value.oldPath, `${path}.oldPath`, errors);
  const status = checkEnum(value.status, CHANGE_FILE_STATUSES, `${path}.status`, errors);
  if (status && value.status === "renamed" && !isNonEmptyString(value.oldPath)) {
    errors.push(`${path}.oldPath is required when status is 'renamed'.`);
  }
  if (typeof value.binary !== "boolean") errors.push(`${path}.binary must be a boolean.`);
  if (!isNonNegativeInt(value.additions)) errors.push(`${path}.additions must be a non-negative integer.`);
  if (!isNonNegativeInt(value.deletions)) errors.push(`${path}.deletions must be a non-negative integer.`);
  if (!Array.isArray(value.hunks)) {
    errors.push(`${path}.hunks must be an array.`);
    return;
  }
  if (value.binary === true && value.hunks.length > 0) {
    errors.push(`${path}.hunks must be empty when binary is true.`);
  }
  value.hunks.forEach((hunk, index) => validateHunk(hunk, `${path}.hunks[${index}]`, errors));
}
function validateStats(value, path, errors) {
  if (!isPlainObject(value)) {
    errors.push(`${path} must be an object.`);
    return;
  }
  for (const field of ["files", "additions", "deletions"]) {
    if (!isNonNegativeInt(value[field])) {
      errors.push(`${path}.${field} must be a non-negative integer; got ${describeValue(value[field])}.`);
    }
  }
}
function validateReviewChangeSet(input) {
  if (!isPlainObject(input)) return { ok: false, errors: ["changeset must be an object."] };
  const errors = [];
  if (input.schemaVersion !== CHANGESET_SCHEMA_VERSION) {
    errors.push(`changeset.schemaVersion must be ${CHANGESET_SCHEMA_VERSION}; got ${describeValue(input.schemaVersion)}.`);
  }
  if (!isNonEmptyString(input.id)) errors.push("changeset.id must be a non-empty string.");
  validateSource(input.source, "changeset.source", errors);
  if (!isNonEmptyString(input.title)) errors.push("changeset.title must be a non-empty string.");
  checkOptionalString(input.description, "changeset.description", errors);
  if (!isNonEmptyString(input.baseRef)) errors.push("changeset.baseRef must be a non-empty string.");
  checkOptionalString(input.baseSha, "changeset.baseSha", errors);
  checkOptionalString(input.headRef, "changeset.headRef", errors);
  checkOptionalString(input.headSha, "changeset.headSha", errors);
  if (!Array.isArray(input.files)) {
    errors.push("changeset.files must be an array.");
  } else {
    input.files.forEach((file, index) => validateFile(file, `changeset.files[${index}]`, errors));
  }
  validateStats(input.stats, "changeset.stats", errors);
  if (!isIsoTimestamp(input.fetchedAt)) {
    errors.push("changeset.fetchedAt must be an ISO-8601 timestamp string.");
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: input };
}

// src/shared/brief.ts
var BRIEF_SCHEMA_VERSION = 1;
var OVERVIEW_COMPLEXITIES = ["low", "medium", "high"];
var READING_NOTES = ["read-closely", "mechanical-skim"];
var ANNOTATION_KINDS = ["explain", "context", "knowledge"];
var CHANGE_MAP_NODE_KINDS = ["data", "api", "ui", "job", "test", "config", "other"];
var CHANGE_MAP_MAX_NODES = 14;
var CHANGE_MAP_MAX_EDGES = 20;
var NODE_LABEL_MAX = 40;
var NODE_SUBLABEL_MAX = 48;
var EDGE_LABEL_MAX = 16;
var HOVER_TIP_MAX = 200;
var FILE_WHY_MAX = 200;
function validateOverview(value, path, errors) {
  if (!isPlainObject(value)) {
    errors.push(`${path} must be an object.`);
    return;
  }
  if (!isNonEmptyString(value.intent)) errors.push(`${path}.intent must be a non-empty string.`);
  if (!isNonEmptyString(value.blastRadius)) errors.push(`${path}.blastRadius must be a non-empty string.`);
  if (!isNonEmptyString(value.readingGuide)) errors.push(`${path}.readingGuide must be a non-empty string.`);
  if (value.complexity !== void 0) {
    checkEnum(value.complexity, OVERVIEW_COMPLEXITIES, `${path}.complexity`, errors);
  }
}
function validateAnnotation(value, path, errors) {
  if (!isPlainObject(value)) {
    errors.push(`${path} must be an object.`);
    return;
  }
  if (!isNonEmptyString(value.id)) errors.push(`${path}.id must be a non-empty string.`);
  if (!isNonEmptyString(value.path)) errors.push(`${path}.path must be a non-empty string.`);
  validateAnchor(value.anchor, `${path}.anchor`, errors);
  checkEnum(value.kind, ANNOTATION_KINDS, `${path}.kind`, errors);
  if (!isNonEmptyString(value.title)) errors.push(`${path}.title must be a non-empty string.`);
  if (!isNonEmptyString(value.summary)) errors.push(`${path}.summary must be a non-empty string.`);
  checkOptionalString(value.detail, `${path}.detail`, errors);
  checkBoundedString(value.hoverTip, HOVER_TIP_MAX, `${path}.hoverTip`, errors);
  if (value.knowledgeRefs !== void 0) checkStringArray(value.knowledgeRefs, `${path}.knowledgeRefs`, errors);
}
function validateStep(value, path, errors) {
  if (!isPlainObject(value)) {
    errors.push(`${path} must be an object.`);
    return;
  }
  if (!isNonEmptyString(value.id)) errors.push(`${path}.id must be a non-empty string.`);
  if (!isNonNegativeInt(value.order)) errors.push(`${path}.order must be a non-negative integer; got ${describeValue(value.order)}.`);
  if (!isNonEmptyString(value.title)) errors.push(`${path}.title must be a non-empty string.`);
  if (!isNonEmptyString(value.narrative)) errors.push(`${path}.narrative must be a non-empty string.`);
  if (!Array.isArray(value.files)) {
    errors.push(`${path}.files must be an array.`);
  } else {
    value.files.forEach((file, index) => {
      const filePath = `${path}.files[${index}]`;
      if (!isPlainObject(file)) {
        errors.push(`${filePath} must be an object.`);
        return;
      }
      if (!isNonEmptyString(file.path)) errors.push(`${filePath}.path must be a non-empty string.`);
      checkBoundedString(file.why, FILE_WHY_MAX, `${filePath}.why`, errors);
      if (file.readingNote !== void 0) checkEnum(file.readingNote, READING_NOTES, `${filePath}.readingNote`, errors);
    });
  }
  if (!Array.isArray(value.annotations)) {
    errors.push(`${path}.annotations must be an array.`);
  } else {
    value.annotations.forEach((annotation, index) => validateAnnotation(annotation, `${path}.annotations[${index}]`, errors));
  }
}
function validateKnowledgeRefs(value, path, errors) {
  if (!Array.isArray(value)) {
    errors.push(`${path} must be an array.`);
    return;
  }
  value.forEach((ref, index) => {
    const refPath = `${path}[${index}]`;
    if (!isPlainObject(ref)) {
      errors.push(`${refPath} must be an object.`);
      return;
    }
    if (!isNonEmptyString(ref.note)) errors.push(`${refPath}.note must be a non-empty string.`);
    if (!isNonEmptyString(ref.reason)) errors.push(`${refPath}.reason must be a non-empty string.`);
  });
}
function validateCoverage(value, path, errors) {
  if (!isPlainObject(value)) {
    errors.push(`${path} must be an object.`);
    return;
  }
  checkStringArray(value.assignedPaths, `${path}.assignedPaths`, errors);
  checkStringArray(value.unassignedPaths, `${path}.unassignedPaths`, errors);
}
function validateChangeMap(value, path, stepIds, errors) {
  if (!isPlainObject(value)) {
    errors.push(`${path} must be an object.`);
    return;
  }
  const nodeIds = /* @__PURE__ */ new Set();
  if (!Array.isArray(value.nodes)) {
    errors.push(`${path}.nodes must be an array.`);
  } else {
    if (value.nodes.length > CHANGE_MAP_MAX_NODES) {
      errors.push(`${path}.nodes must have ${CHANGE_MAP_MAX_NODES} nodes or fewer; got ${value.nodes.length}.`);
    }
    value.nodes.forEach((node, index) => {
      const nodePath = `${path}.nodes[${index}]`;
      if (!isPlainObject(node)) {
        errors.push(`${nodePath} must be an object.`);
        return;
      }
      if (!isNonEmptyString(node.id)) {
        errors.push(`${nodePath}.id must be a non-empty string.`);
      } else if (nodeIds.has(node.id)) {
        errors.push(`${nodePath}.id duplicates an earlier node id ${describeValue(node.id)}.`);
      } else {
        nodeIds.add(node.id);
      }
      checkBoundedString(node.label, NODE_LABEL_MAX, `${nodePath}.label`, errors);
      if (node.sublabel !== void 0) checkBoundedString(node.sublabel, NODE_SUBLABEL_MAX, `${nodePath}.sublabel`, errors);
      checkEnum(node.kind, CHANGE_MAP_NODE_KINDS, `${nodePath}.kind`, errors);
      if (!isNonEmptyString(node.stepId)) {
        errors.push(`${nodePath}.stepId must be a non-empty string.`);
      } else if (!stepIds.has(node.stepId)) {
        errors.push(`${nodePath}.stepId ${describeValue(node.stepId)} does not reference a brief step.`);
      }
    });
  }
  if (!Array.isArray(value.edges)) {
    errors.push(`${path}.edges must be an array.`);
  } else {
    if (value.edges.length > CHANGE_MAP_MAX_EDGES) {
      errors.push(`${path}.edges must have ${CHANGE_MAP_MAX_EDGES} edges or fewer; got ${value.edges.length}.`);
    }
    value.edges.forEach((edge, index) => {
      const edgePath = `${path}.edges[${index}]`;
      if (!isPlainObject(edge)) {
        errors.push(`${edgePath} must be an object.`);
        return;
      }
      for (const end of ["from", "to"]) {
        if (!isNonEmptyString(edge[end])) {
          errors.push(`${edgePath}.${end} must be a non-empty string.`);
        } else if (!nodeIds.has(edge[end])) {
          errors.push(`${edgePath}.${end} ${describeValue(edge[end])} does not reference a change-map node.`);
        }
      }
      if (edge.label !== void 0) checkBoundedString(edge.label, EDGE_LABEL_MAX, `${edgePath}.label`, errors);
    });
  }
  checkOptionalString(value.deployNote, `${path}.deployNote`, errors);
}
function validateReviewBrief(input) {
  if (!isPlainObject(input)) return { ok: false, errors: ["brief must be an object."] };
  const errors = [];
  if (input.schemaVersion !== BRIEF_SCHEMA_VERSION) {
    errors.push(`brief.schemaVersion must be ${BRIEF_SCHEMA_VERSION}; got ${describeValue(input.schemaVersion)}.`);
  }
  if (!isNonEmptyString(input.changeSetId)) errors.push("brief.changeSetId must be a non-empty string.");
  checkOptionalString(input.headSha, "brief.headSha", errors);
  if (!isNonEmptyString(input.generatedAt)) errors.push("brief.generatedAt must be a non-empty string.");
  validateOverview(input.overview, "brief.overview", errors);
  const stepIds = /* @__PURE__ */ new Set();
  if (!Array.isArray(input.steps)) {
    errors.push("brief.steps must be an array.");
  } else {
    input.steps.forEach((step, index) => {
      validateStep(step, `brief.steps[${index}]`, errors);
      const id = isPlainObject(step) ? step.id : void 0;
      if (typeof id === "string") {
        if (stepIds.has(id)) errors.push(`brief.steps[${index}].id duplicates an earlier step id ${describeValue(id)}.`);
        else stepIds.add(id);
      }
    });
  }
  validateKnowledgeRefs(input.knowledgeRefs, "brief.knowledgeRefs", errors);
  validateCoverage(input.coverage, "brief.coverage", errors);
  if (input.changeMap !== void 0) validateChangeMap(input.changeMap, "brief.changeMap", stepIds, errors);
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: input };
}
function fileExtent(file, side) {
  let min = Number.POSITIVE_INFINITY;
  let max = 0;
  for (const hunk of file.hunks) {
    const start = side === "new" ? hunk.newStart : hunk.oldStart;
    const count = side === "new" ? hunk.newLines : hunk.oldLines;
    if (count <= 0) continue;
    if (start < min) min = start;
    const end = start + count - 1;
    if (end > max) max = end;
  }
  return max === 0 ? null : { min, max };
}
function checkBriefMatchesChangeSet(brief, changeset) {
  const errors = [];
  if (brief.changeSetId !== changeset.id) {
    errors.push(`brief.changeSetId ${describeValue(brief.changeSetId)} does not match changeset.id ${describeValue(changeset.id)}.`);
  }
  const filesByPath = new Map(changeset.files.map((file) => [file.path, file]));
  const assignmentCount = /* @__PURE__ */ new Map();
  brief.steps.forEach((step, stepIndex) => {
    step.files.forEach((file, fileIndex) => {
      if (!filesByPath.has(file.path)) {
        errors.push(`brief.steps[${stepIndex}].files[${fileIndex}].path ${describeValue(file.path)} is not in the changeset.`);
      }
      assignmentCount.set(file.path, (assignmentCount.get(file.path) ?? 0) + 1);
    });
    step.annotations.forEach((annotation, annIndex) => {
      const annPath = `brief.steps[${stepIndex}].annotations[${annIndex}]`;
      const target = filesByPath.get(annotation.path);
      if (!target) {
        errors.push(`${annPath}.path ${describeValue(annotation.path)} is not in the changeset.`);
        return;
      }
      const extent = fileExtent(target, annotation.anchor.side);
      if (!extent || !isAnchorWithinExtent(annotation.anchor, extent)) {
        const range = extent ? `${extent.min}-${extent.max}` : "none";
        errors.push(`${annPath}.anchor lines ${annotation.anchor.startLine}-${annotation.anchor.endLine} fall outside the ${annotation.anchor.side}-side extent (${range}) of ${describeValue(annotation.path)}.`);
      }
    });
  });
  for (const [path, count] of assignmentCount) {
    if (count > 1) errors.push(`brief: path ${describeValue(path)} is assigned to ${count} steps; every file belongs to exactly one step.`);
  }
  const assignedSet = new Set(assignmentCount.keys());
  const unassignedSet = new Set(brief.coverage.unassignedPaths);
  for (const path of brief.coverage.assignedPaths) {
    if (!assignedSet.has(path)) errors.push(`brief.coverage.assignedPaths lists ${describeValue(path)}, which no step assigns.`);
  }
  for (const path of assignedSet) {
    if (!brief.coverage.assignedPaths.includes(path)) errors.push(`brief.coverage.assignedPaths is missing assigned path ${describeValue(path)}.`);
    if (unassignedSet.has(path)) errors.push(`brief: path ${describeValue(path)} is both assigned and listed in unassignedPaths.`);
  }
  for (const file of changeset.files) {
    if (file.binary) continue;
    if (!assignedSet.has(file.path) && !unassignedSet.has(file.path)) {
      errors.push(`brief: changed file ${describeValue(file.path)} is neither assigned to a step nor listed in coverage.unassignedPaths.`);
    }
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true };
}

// src/shared/comments.ts
var WORKSPACE_STATE_SCHEMA_VERSION = 1;
var COMMENT_SYNC_STATES = ["pending", "posting", "posted", "failed"];
var DIFF_VIEWS = ["side-by-side", "inline"];
var COMMENT_ANCHOR_STATUSES = ["moved"];
function validateSync(value, path, errors) {
  if (!isPlainObject(value)) {
    errors.push(`${path} must be an object.`);
    return;
  }
  if (!checkEnum(value.state, COMMENT_SYNC_STATES, `${path}.state`, errors)) return;
  switch (value.state) {
    case "posted": {
      if (!isNonEmptyString(value.url)) errors.push(`${path}.url must be a non-empty string.`);
      if (!isNonEmptyString(value.postedAt)) errors.push(`${path}.postedAt must be a non-empty string.`);
      break;
    }
    case "failed": {
      if (!isNonEmptyString(value.error)) errors.push(`${path}.error must be a non-empty string.`);
      break;
    }
  }
}
function validateCommentShape(value, path, errors) {
  if (!isPlainObject(value)) {
    errors.push(`${path} must be an object.`);
    return;
  }
  if (!isNonEmptyString(value.id)) errors.push(`${path}.id must be a non-empty string.`);
  if (!isNonEmptyString(value.path)) errors.push(`${path}.path must be a non-empty string.`);
  validateAnchor(value.anchor, `${path}.anchor`, errors);
  if (typeof value.body !== "string" || value.body.length === 0) errors.push(`${path}.body must be a non-empty string.`);
  if (!isNonEmptyString(value.createdAt)) errors.push(`${path}.createdAt must be a non-empty string.`);
  validateSync(value.sync, `${path}.sync`, errors);
  if (value.anchorStatus !== void 0) checkEnum(value.anchorStatus, COMMENT_ANCHOR_STATUSES, `${path}.anchorStatus`, errors);
}
function validateReviewWorkspaceState(input) {
  if (!isPlainObject(input)) return { ok: false, errors: ["workspace state must be an object."] };
  const errors = [];
  if (input.schemaVersion !== WORKSPACE_STATE_SCHEMA_VERSION) {
    errors.push(`state.schemaVersion must be ${WORKSPACE_STATE_SCHEMA_VERSION}; got ${describeValue(input.schemaVersion)}.`);
  }
  if (!isNonEmptyString(input.changeSetId)) errors.push("state.changeSetId must be a non-empty string.");
  checkStringArray(input.readFiles, "state.readFiles", errors);
  if (input.activeStepId !== void 0 && typeof input.activeStepId !== "string") {
    errors.push("state.activeStepId must be a string when present.");
  }
  checkEnum(input.diffView, DIFF_VIEWS, "state.diffView", errors);
  if (!Array.isArray(input.comments)) {
    errors.push("state.comments must be an array.");
  } else {
    input.comments.forEach((comment, index) => validateCommentShape(comment, `state.comments[${index}]`, errors));
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: input };
}

// src/shared/pr-url.ts
function parsePullRequestUrl(rawUrl) {
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;
  let url;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const host = url.hostname.toLowerCase();
  const port = url.port;
  const segments = url.pathname.split("/").map(decodeSegment).filter((segment) => segment.length > 0);
  if (segments.includes("pull-requests") || host === "bitbucket.org" || host.endsWith(".bitbucket.org")) {
    return { unsupported: "bitbucket" };
  }
  for (let i = 2; i < segments.length - 1; i++) {
    if (segments[i] !== "pull") continue;
    const number = parsePositiveInt(segments[i + 1]);
    if (number === null) continue;
    const owner = segments[i - 2];
    const repo = segments[i - 1];
    if (!owner || !repo) continue;
    const provider = host === "github.com" ? "github" : "github-enterprise";
    return { provider, host, ...port ? { port } : {}, owner, repo, number };
  }
  return null;
}
function canonicalPullRequestUrl(parsed) {
  const authority = parsed.port ? `${parsed.host}:${parsed.port}` : parsed.host;
  return `https://${authority}/${parsed.owner}/${parsed.repo}/pull/${parsed.number}`;
}
function parsePositiveInt(value) {
  if (!value || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}
function decodeSegment(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

// src/shared/brief-run-events.ts
var BRIEF_RUN_EVENT_TOPIC = "brief-run";

// src/main/brief-run-service.ts
var BRIEF_FILE = "brief.json";
async function readBriefFromDir(targetDir) {
  let raw;
  try {
    raw = await (0, import_promises.readFile)((0, import_path.join)(targetDir, BRIEF_FILE), "utf-8");
  } catch {
    return null;
  }
  try {
    const parsed = validateReviewBrief(JSON.parse(raw));
    return parsed.ok ? parsed.value : null;
  } catch {
    return null;
  }
}
async function writeBriefAtomic(targetDir, brief) {
  await (0, import_promises.mkdir)(targetDir, { recursive: true });
  const finalPath = (0, import_path.join)(targetDir, BRIEF_FILE);
  const tempPath = (0, import_path.join)(targetDir, `.${BRIEF_FILE}.${(0, import_crypto.randomUUID)()}.tmp`);
  const data = `${JSON.stringify(brief, null, 2)}
`;
  try {
    await (0, import_promises.writeFile)(tempPath, data, "utf-8");
    await (0, import_promises.rename)(tempPath, finalPath);
  } catch (error) {
    await (0, import_promises.unlink)(tempPath).catch(() => {
    });
    throw error;
  }
}

// src/main/changeset-service.ts
var import_crypto2 = require("crypto");
var import_promises2 = require("fs/promises");
var import_path2 = require("path");

// src/main/vcs.ts
var import_node_child_process = require("node:child_process");
var import_node_util = require("node:util");
var execFileAsync = (0, import_node_util.promisify)(import_node_child_process.execFile);
function removeLineEndingWarnings(output) {
  return output.split(/\r?\n/).filter((line) => !/^warning: in the working copy of '.+', (?:LF|CRLF) will be replaced by (?:LF|CRLF) the next time Git touches it$/.test(line.trim())).join("\n").trim();
}
function gitEnv(overrides) {
  return { ...process.env, LC_ALL: "C", ...overrides };
}
async function runGit(cwd, args) {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    windowsHide: true,
    env: gitEnv()
  });
  return stdout;
}
async function runGitCommand(cwd, args, envOverrides) {
  try {
    const { stdout, stderr } = await execFileAsync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
      windowsHide: true,
      env: gitEnv(envOverrides)
    });
    return { ok: true, stdout, stderr: removeLineEndingWarnings(stderr), message: null };
  } catch (error) {
    const execError = error;
    const stderr = removeLineEndingWarnings(execError.stderr ?? "");
    return {
      ok: false,
      stdout: execError.stdout ?? "",
      stderr,
      message: stderr || removeLineEndingWarnings(execError.message ?? "") || "Git command failed."
    };
  }
}
var GH_MAX_BUFFER_BYTES = 20 * 1024 * 1024;
function createDefaultGhRunner(environment = {}) {
  const spawn = environment.spawn ?? ((file, args, options) => execFileAsync(file, args, options));
  const shell = environment.shell !== void 0 ? environment.shell : process.env.SHELL;
  const platform = environment.platform ?? process.platform;
  const runDirect = async (args, options) => {
    try {
      const { stdout, stderr } = await spawn("gh", args, {
        ...options.cwd ? { cwd: options.cwd } : {},
        ...spawnTimeout(options),
        maxBuffer: GH_MAX_BUFFER_BYTES,
        windowsHide: true
      });
      return { found: true, code: 0, stdout, stderr };
    } catch (error) {
      return resultFromSpawnError(error);
    }
  };
  const runViaShell = async (args, options) => {
    const descriptor = buildShellGhDescriptor(args, shell, platform);
    if (!descriptor) return null;
    try {
      const { stdout, stderr } = await spawn(descriptor.file, descriptor.args, {
        ...options.cwd ? { cwd: options.cwd } : {},
        ...spawnTimeout(options),
        maxBuffer: GH_MAX_BUFFER_BYTES,
        windowsHide: true
      });
      return { found: true, code: 0, stdout, stderr };
    } catch (error) {
      return resultFromSpawnError(error);
    }
  };
  const run = async (args, options = {}) => {
    const direct = await runDirect(args, options);
    if (direct.found) return direct;
    return await runViaShell(args, options) ?? direct;
  };
  return {
    run,
    async available() {
      const result = await run(["--version"]);
      return result.found && result.code === 0;
    }
  };
}
function spawnTimeout(options) {
  const timeoutMs = options.timeoutMs;
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) return {};
  return { timeout: Math.round(timeoutMs), killSignal: "SIGTERM" };
}
function resultFromSpawnError(error) {
  const err = error;
  if (err.code === "ENOENT") return { found: false, code: -1, stdout: "", stderr: "" };
  const timedOut = err.killed === true || typeof err.signal === "string" && err.signal.length > 0;
  return {
    found: true,
    code: typeof err.code === "number" ? err.code : 1,
    stdout: err.stdout ?? "",
    stderr: err.stderr ?? "",
    ...timedOut ? { timedOut: true } : {}
  };
}
function buildShellGhDescriptor(args, shell, platform = process.platform) {
  if (platform !== "darwin" && platform !== "linux") return null;
  const shellPath = shell?.trim();
  if (!shellPath) return null;
  const shellName = shellPath.split("/").pop();
  if (shellName !== "zsh" && shellName !== "bash") return null;
  const command = ["gh", ...args].map(posixSingleQuote).join(" ");
  return { file: shellPath, args: ["-ilc", command] };
}
function posixSingleQuote(value) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
function defaultResolveToken(host, provider) {
  if (provider === "github") return Promise.resolve(pickEnv("GH_TOKEN", "GITHUB_TOKEN"));
  const configuredHost = (process.env.GH_HOST ?? process.env.GH_ENTERPRISE_HOST ?? "").trim().toLowerCase();
  if (!configuredHost || configuredHost !== host.toLowerCase()) return Promise.resolve(null);
  return Promise.resolve(pickEnv("GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"));
}
function pickEnv(...names) {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return null;
}
var shared = null;
function sharedGhRunner() {
  if (!shared) shared = createDefaultGhRunner();
  return shared;
}
async function listGitBranches(repoRoot) {
  const output = await runGit(repoRoot, [
    "branch",
    "--format=%(refname:short)%09%(HEAD)",
    "--sort=refname"
  ]);
  const rows = output.split(/\r?\n/).filter(Boolean).map((line) => {
    const [name, head] = line.split("	");
    return { name, current: head === "*" };
  }).filter((row) => Boolean(row.name));
  return {
    current: rows.find((row) => row.current)?.name ?? null,
    branches: rows.map((row) => row.name)
  };
}

// src/main/patch-parse.ts
var NOT_A_DIFF = "Not a unified diff \u2014 expected a 'diff --git' or '---' header.";
function parsePatch(text) {
  const lines = text.split(/\r?\n/);
  const hasGitHeader = lines.some((line) => line.startsWith("diff --git "));
  const hasUnifiedHeader = lines.some((line) => line.startsWith("--- "));
  if (!hasGitHeader && !hasUnifiedHeader) {
    if (text.trim().length === 0) {
      return { ok: true, files: [], stats: { files: 0, additions: 0, deletions: 0 } };
    }
    return { ok: false, error: NOT_A_DIFF };
  }
  const blocks = hasGitHeader ? splitGitBlocks(lines) : splitUnifiedBlocks(lines);
  const files = [];
  for (const block of blocks) {
    const file = parseFileBlock(block);
    if (file) files.push(file);
  }
  const stats = files.reduce(
    (acc, file) => ({
      files: acc.files + 1,
      additions: acc.additions + file.additions,
      deletions: acc.deletions + file.deletions
    }),
    { files: 0, additions: 0, deletions: 0 }
  );
  return { ok: true, files, stats };
}
function splitGitBlocks(lines) {
  const blocks = [];
  let current = null;
  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      if (current) blocks.push(current);
      current = [line];
    } else if (current) {
      current.push(line);
    }
  }
  if (current) blocks.push(current);
  return blocks;
}
function splitUnifiedBlocks(lines) {
  const blocks = [];
  let current = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("--- ") && lines[i + 1]?.startsWith("+++ ")) {
      if (current) blocks.push(current);
      current = [line];
    } else if (current) {
      current.push(line);
    }
  }
  if (current) blocks.push(current);
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
  const gitHeader = block[0]?.startsWith("diff --git ") ? block[0] : void 0;
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
    if (line.startsWith("new file mode")) {
      markedNew = true;
      i++;
    } else if (line.startsWith("deleted file mode")) {
      markedDeleted = true;
      i++;
    } else if (line.startsWith("rename from ") || line.startsWith("copy from ")) {
      renameOld = dequote(line.slice(line.indexOf("from ") + 5));
      i++;
    } else if (line.startsWith("rename to ") || line.startsWith("copy to ")) {
      renameNew = dequote(line.slice(line.indexOf("to ") + 3));
      i++;
    } else if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) {
      binary = true;
      const parsedBinary = parseBinaryFilesLine(line);
      if (parsedBinary) {
        if (parsedBinary.old === null) oldIsDevNull = true;
        else oldPath = parsedBinary.old;
        if (parsedBinary.new === null) newIsDevNull = true;
        else newPath = parsedBinary.new;
      }
      i++;
    } else if (line.startsWith("--- ")) {
      const parsedPath = stripDiffPathPrefix(line.slice(4));
      if (parsedPath === null) oldIsDevNull = true;
      else oldPath = parsedPath;
      i++;
    } else if (line.startsWith("+++ ")) {
      const parsedPath = stripDiffPathPrefix(line.slice(4));
      if (parsedPath === null) newIsDevNull = true;
      else newPath = parsedPath;
      i++;
    } else if (line.startsWith("@@")) {
      const header = parseHunkHeader(line);
      if (!header) {
        i++;
        continue;
      }
      const collected = collectHunk(block, i, header);
      hunks.push(collected.hunk);
      for (const bodyLine of collected.hunk.lines) {
        if (bodyLine.kind === "add") additions++;
        else if (bodyLine.kind === "del") deletions++;
      }
      i = collected.next;
    } else {
      i++;
    }
  }
  if (renameOld) oldPath = renameOld;
  if (renameNew) newPath = renameNew;
  let status;
  if (renameOld && renameNew) status = "renamed";
  else if (markedNew || oldIsDevNull) status = "added";
  else if (markedDeleted || newIsDevNull) status = "deleted";
  else status = "modified";
  let path;
  let recordedOldPath;
  if (status === "deleted") {
    path = oldPath ?? newPath;
  } else if (status === "renamed") {
    path = newPath;
    recordedOldPath = oldPath;
  } else {
    path = newPath ?? oldPath;
  }
  if (!path) return null;
  if (status === "renamed" && !recordedOldPath) status = "modified";
  const file = {
    path,
    status,
    binary,
    additions: binary ? 0 : additions,
    deletions: binary ? 0 : deletions,
    hunks: binary ? [] : hunks
  };
  if (status === "renamed" && recordedOldPath) file.oldPath = recordedOldPath;
  return file;
}
var HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
function parseHunkHeader(line) {
  const match = line.match(HUNK_HEADER);
  if (!match) return null;
  return {
    oldStart: Number(match[1]),
    oldLines: match[2] === void 0 ? 1 : Number(match[2]),
    newStart: Number(match[3]),
    newLines: match[4] === void 0 ? 1 : Number(match[4])
  };
}
function collectHunk(block, headerIndex, header) {
  const lines = [];
  let oldSeen = 0;
  let newSeen = 0;
  let j = headerIndex + 1;
  while (j < block.length && (oldSeen < header.oldLines || newSeen < header.newLines)) {
    const line = block[j];
    if (line.startsWith("\\")) {
      j++;
      continue;
    }
    const marker = line[0];
    if (marker === "+") {
      lines.push({ kind: "add", text: line.slice(1) });
      newSeen++;
    } else if (marker === "-") {
      lines.push({ kind: "del", text: line.slice(1) });
      oldSeen++;
    } else if (marker === " ") {
      lines.push({ kind: "context", text: line.slice(1) });
      oldSeen++;
      newSeen++;
    } else if (line === "") {
      lines.push({ kind: "context", text: "" });
      oldSeen++;
      newSeen++;
    } else {
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
      lines
    },
    next: j
  };
}
function parseDiffGitPaths(line) {
  const rest = line.slice("diff --git ".length);
  if (rest.startsWith('"')) {
    const match2 = rest.match(/^("(?:[^"\\]|\\.)*") ("(?:[^"\\]|\\.)*")$/);
    if (!match2) return null;
    const oldPath = stripDiffPathPrefix(match2[1]);
    const newPath = stripDiffPathPrefix(match2[2]);
    if (oldPath === null || newPath === null) return null;
    return { old: oldPath, new: newPath };
  }
  const match = rest.match(/^a\/(.*) b\/(.*)$/);
  if (!match) return null;
  return { old: match[1], new: match[2] };
}
function parseBinaryFilesLine(line) {
  const match = line.match(/^Binary files (.+) and (.+) differ$/);
  if (!match) return null;
  return { old: stripDiffPathPrefix(match[1]), new: stripDiffPathPrefix(match[2]) };
}
function stripDiffPathPrefix(raw) {
  let value = dequote(raw);
  const tabIndex = value.indexOf("	");
  if (tabIndex !== -1) value = value.slice(0, tabIndex);
  value = value.trim();
  if (value === "/dev/null") return null;
  if (value.startsWith("a/") || value.startsWith("b/")) value = value.slice(2);
  return value;
}
var QUOTE_ESCAPES = { '"': '"', "\\": "\\", t: "	", n: "\n", r: "\r" };
function dequote(raw) {
  const value = raw.trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\(["\\tnr])/g, (_, char) => QUOTE_ESCAPES[char] ?? char);
  }
  return value;
}

// src/main/changeset-service.ts
var MAX_PATCH_BYTES = 5 * 1024 * 1024;
var MAX_CHANGESET_FILES = 400;
var CHANGESET_FILE = "changeset.json";
var PATCH_BASE_REF = "(patch)";
var PULL_REQUEST_NOT_INSTALLED = "Pull-request sources arrive with the GitHub provider.";
var providers = /* @__PURE__ */ new Map();
function registerReviewSourceProvider(kind, provider) {
  providers.set(kind, provider);
}
var ReviewChangeSetService = class {
  // Cheap probe used live by the creation flow. Never throws to the renderer —
  // an unresolvable ref or unparsable patch comes back as { ok: false, error }.
  async detect(input) {
    const provider = providers.get(input.kind);
    if (!provider) return { ok: false, error: providerMissingMessage(input.kind) };
    try {
      return await provider.probe(input);
    } catch (error) {
      return { ok: false, error: messageOf(error) };
    }
  }
  // Normalize a source into a validated change set WITHOUT persisting it. This is
  // the freshness probe (MC-1682): the panel rebuilds the current change set to
  // compare its head sha + per-file diffs against the walkthrough it already has,
  // and must not overwrite the on-disk change set the current brief walks.
  async build(input) {
    const provider = providers.get(input.kind);
    if (!provider) throw new Error(providerMissingMessage(input.kind));
    const build = await provider.build(input);
    const changeset = assembleChangeSet(build);
    const validation = validateReviewChangeSet(changeset);
    if (!validation.ok) {
      throw new Error(`Internal error: produced an invalid change set (${validation.errors[0]}).`);
    }
    return validation.value;
  }
  // Full normalization + atomic persistence. Throws on a bad source or an
  // internal normalization bug rather than writing an invalid file to disk.
  async ingest(input, targetDir) {
    const changeset = await this.build(input);
    await writeChangeSetAtomic(targetDir, changeset);
    return changeset;
  }
  async read(targetDir) {
    const filePath = (0, import_path2.join)(targetDir, CHANGESET_FILE);
    let raw;
    try {
      raw = await (0, import_promises2.readFile)(filePath, "utf-8");
    } catch (error) {
      if (error.code === "ENOENT") return { ok: true, changeset: null };
      return { ok: false, error: messageOf(error) };
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { ok: false, error: "Stored change set is not valid JSON." };
    }
    const validation = validateReviewChangeSet(parsed);
    if (!validation.ok) return { ok: false, error: `Stored change set is invalid: ${validation.errors[0]}` };
    return { ok: true, changeset: validation.value };
  }
};
function createReviewChangeSetService() {
  return new ReviewChangeSetService();
}
function reviewChangeSetDir(workspaceRoot, workspaceId) {
  if (!workspaceRoot) throw new Error("Review change set requires a workspace root.");
  if (!/^[A-Za-z0-9._-]+$/.test(workspaceId)) {
    throw new Error(`Invalid workspace id for review storage: ${JSON.stringify(workspaceId)}.`);
  }
  return (0, import_path2.join)(workspaceRoot, ".sprintengine", "review", workspaceId);
}
function assembleChangeSet(build) {
  const changeset = {
    schemaVersion: 1,
    id: `cs_${sha256(build.identity).slice(0, 24)}`,
    source: build.source,
    title: build.title,
    baseRef: build.baseRef,
    files: build.files,
    stats: build.stats,
    fetchedAt: (/* @__PURE__ */ new Date()).toISOString()
  };
  if (build.description !== void 0) changeset.description = build.description;
  if (build.baseSha !== void 0) changeset.baseSha = build.baseSha;
  if (build.headRef !== void 0) changeset.headRef = build.headRef;
  if (build.headSha !== void 0) changeset.headSha = build.headSha;
  return changeset;
}
async function writeChangeSetAtomic(targetDir, changeset) {
  await (0, import_promises2.mkdir)(targetDir, { recursive: true });
  const finalPath = (0, import_path2.join)(targetDir, CHANGESET_FILE);
  const tempPath = (0, import_path2.join)(targetDir, `.${CHANGESET_FILE}.${(0, import_crypto2.randomUUID)()}.tmp`);
  const data = `${JSON.stringify(changeset, null, 2)}
`;
  try {
    await (0, import_promises2.writeFile)(tempPath, data, "utf-8");
    await (0, import_promises2.rename)(tempPath, finalPath);
  } catch (error) {
    await (0, import_promises2.unlink)(tempPath).catch(() => {
    });
    throw error;
  }
}
var branchProvider = {
  async build(input) {
    if (input.kind !== "branch") throw new Error("Branch provider received a non-branch source.");
    const { repoRoot, baseRef, headRef } = input;
    const baseSha = await resolveSha(repoRoot, baseRef);
    const headSha = await resolveSha(repoRoot, headRef);
    const diffText = await runGit(repoRoot, ["diff", "--patch", "--find-renames", `${baseRef}...${headRef}`]);
    assertPatchSize(diffText);
    const parsed = parsePatch(diffText);
    if (!parsed.ok) throw new Error(parsed.error);
    assertFileCount(parsed.files.length);
    return {
      source: { kind: "branch", repoRoot, baseRef, headRef },
      title: `${headRef} \u2192 ${baseRef}`,
      baseRef,
      baseSha,
      headRef,
      headSha,
      files: parsed.files,
      stats: parsed.stats,
      identity: `branch
${repoRoot}
${baseSha}
${headSha}
${sha256(diffText)}`
    };
  },
  probe(input) {
    return deriveProbe(this, input);
  }
};
var patchProvider = {
  async build(input) {
    if (input.kind !== "patch") throw new Error("Patch provider received a non-patch source.");
    const text = input.text;
    if (text.trim().length === 0) throw new Error("The patch is empty.");
    assertPatchSize(text);
    const parsed = parsePatch(text);
    if (!parsed.ok) throw new Error(parsed.error);
    if (parsed.files.length === 0) {
      throw new Error("Not a unified diff \u2014 expected a 'diff --git' or '---' header.");
    }
    assertFileCount(parsed.files.length);
    const label = input.label?.trim();
    return {
      source: label ? { kind: "patch", label } : { kind: "patch" },
      title: label && label.length > 0 ? label : "Pasted patch",
      baseRef: PATCH_BASE_REF,
      files: parsed.files,
      stats: parsed.stats,
      // Normalize CRLF so the same logical patch pasted from different editors
      // yields one stable id.
      identity: `patch
${sha256(text.replace(/\r\n/g, "\n"))}`
    };
  },
  probe(input) {
    return deriveProbe(this, input);
  }
};
registerReviewSourceProvider("branch", branchProvider);
registerReviewSourceProvider("patch", patchProvider);
async function deriveProbe(provider, input) {
  const build = await provider.build(input);
  return { ok: true, title: build.title, stats: build.stats, headSha: build.headSha };
}
async function resolveSha(repoRoot, ref) {
  try {
    return (await runGit(repoRoot, ["rev-parse", "--verify", `${ref}^{commit}`])).trim();
  } catch {
    throw new Error(`Couldn't find "${ref}" in this repository.`);
  }
}
function assertPatchSize(text) {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > MAX_PATCH_BYTES) {
    throw new Error(`Patch is too large to review (${formatBytes(bytes)}; limit ${formatBytes(MAX_PATCH_BYTES)}).`);
  }
}
function assertFileCount(count) {
  if (count > MAX_CHANGESET_FILES) {
    throw new Error(`Change set has too many files to review (${count}; limit ${MAX_CHANGESET_FILES}).`);
  }
}
function providerMissingMessage(kind) {
  if (kind === "pull-request") return PULL_REQUEST_NOT_INSTALLED;
  return `Review source "${kind}" is not installed.`;
}
function sha256(value) {
  return (0, import_crypto2.createHash)("sha256").update(value).digest("hex");
}
function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const mib = bytes / (1024 * 1024);
  if (mib >= 1) return `${mib.toFixed(1)} MiB`;
  return `${(bytes / 1024).toFixed(1)} KiB`;
}

// src/main/gateway-tools.ts
var import_path4 = require("path");

// src/shared/pathSafety.ts
function homePathLeak(value, home) {
  if (!home) return null;
  return JSON.stringify(value).includes(home) ? "a review artifact contains an absolute home-directory path; paths must be project-relative." : null;
}

// src/main/mcp-tool-result.ts
function toolSuccess(structured) {
  return {
    content: [{ type: "text", text: JSON.stringify(structured, null, 2) }],
    structuredContent: structured
  };
}
function toolError(code, message) {
  return {
    content: [{ type: "text", text: `${code}: ${message}` }],
    structuredContent: { ok: false, error: { code, message } },
    isError: true
  };
}

// src/main/review-index.ts
var import_promises3 = require("fs/promises");
var import_path3 = require("path");
var REVIEW_ROOT_SEGMENTS = [".sprintengine", "review"];
var REVIEW_ID = /^[A-Za-z0-9._-]+$/;
async function enumerateReviews(roots) {
  const uniqueRoots = [...new Set(roots.filter((root) => typeof root === "string" && root.length > 0))];
  const entries = [];
  for (const root of uniqueRoots) {
    const reviewRoot = (0, import_path3.join)(root, ...REVIEW_ROOT_SEGMENTS);
    let dirents;
    try {
      dirents = (await (0, import_promises3.readdir)(reviewRoot, { withFileTypes: true })).filter((dirent) => dirent.isDirectory() && REVIEW_ID.test(dirent.name)).map((dirent) => dirent.name);
    } catch {
      continue;
    }
    for (const reviewId of dirents) {
      const entry = await readReviewEntry(root, reviewId);
      if (entry) entries.push(entry);
    }
  }
  return entries;
}
async function readReviewEntry(workspaceRoot, reviewId) {
  const reviewDir = (0, import_path3.join)(workspaceRoot, ...REVIEW_ROOT_SEGMENTS, reviewId);
  const changeset = await readJsonValidated((0, import_path3.join)(reviewDir, "changeset.json"), validateReviewChangeSet);
  if (!changeset) return null;
  const brief = await readJsonValidated((0, import_path3.join)(reviewDir, "brief.json"), validateReviewBrief);
  const state = await readJsonValidated((0, import_path3.join)(reviewDir, "state.json"), validateReviewWorkspaceState);
  const comments = state?.comments ?? [];
  return {
    reviewId,
    workspaceRoot,
    projectName: (0, import_path3.basename)(workspaceRoot),
    title: changeset.title,
    sourceKind: changeset.source.kind,
    fetchedAt: changeset.fetchedAt,
    fileCount: changeset.stats.files,
    hasWalkthrough: brief !== null,
    stepCount: brief ? brief.steps.length : 0,
    readFileCount: state ? state.readFiles.length : 0,
    pendingComments: comments.filter((comment) => comment.sync.state !== "posted").length,
    postedComments: comments.filter((comment) => comment.sync.state === "posted").length
  };
}
async function readJsonValidated(filePath, validate) {
  let raw;
  try {
    raw = await (0, import_promises3.readFile)(filePath, "utf-8");
  } catch {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const validation = validate(parsed);
  return validation.ok ? validation.value : null;
}

// src/main/gateway-tools.ts
var REVIEW_ID_PATTERN = /^[A-Za-z0-9._-]+$/;
var REVIEW_TARGET_SCHEMA = {
  type: "object",
  properties: {
    reviewId: { type: "string", description: "Review id from review_list_pending." },
    projectRoot: {
      type: "string",
      description: "Absolute path to the project the review lives under; must be a project open in this app."
    }
  },
  required: ["reviewId", "projectRoot"],
  additionalProperties: false
};
function createReviewGatewayTools(backends) {
  const changeSets = createReviewChangeSetService();
  async function openRoots() {
    return (await backends.listOpenProjectRoots()).filter((root) => typeof root === "string" && root.length > 0).map((root) => (0, import_path4.resolve)(root));
  }
  async function resolveReviewDir(args) {
    const { reviewId, projectRoot } = args;
    if (typeof reviewId !== "string" || !REVIEW_ID_PATTERN.test(reviewId)) {
      return toolError("invalid_arguments", '"reviewId" must be a review id (letters, digits, dot, underscore, or hyphen).');
    }
    if (typeof projectRoot !== "string" || projectRoot.length === 0) {
      return toolError("invalid_arguments", '"projectRoot" must be an absolute path to an open project folder.');
    }
    const normalized = (0, import_path4.resolve)(projectRoot);
    if (!(await openRoots()).includes(normalized)) {
      return toolError("unknown_project", "That project is not open in this app; open it, then address the review by its project.");
    }
    return { reviewDir: reviewChangeSetDir(normalized, reviewId), projectRoot: normalized, reviewId };
  }
  const reviewListPending = {
    name: "review_list_pending",
    description: "List the reviews across the projects open in this app. Each entry is addressed by {reviewId, projectRoot} and reports its change source and whether a walkthrough (brief) already exists \u2014 an incremental re-run target.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async () => {
      const reviews = await enumerateReviews(await openRoots());
      return toolSuccess({
        reviews: reviews.map((review) => ({
          reviewId: review.reviewId,
          projectRoot: review.workspaceRoot,
          source: review.sourceKind,
          hasBrief: review.hasWalkthrough
        }))
      });
    }
  };
  const reviewGetChangeset = {
    name: "review_get_changeset",
    description: "Read the normalised change set for a review: files, per-file hunks, base/head refs and SHAs, and the source kind. Returned in full (no silent truncation); the source's absolute repository path is stripped so no machine path leaks.",
    inputSchema: REVIEW_TARGET_SCHEMA,
    handler: async (args) => {
      const target = await resolveReviewDir(args);
      if ("content" in target) return target;
      const read = await changeSets.read(target.reviewDir);
      if (!read.ok) return toolError("changeset_unreadable", "The stored change set could not be read or is not valid.");
      if (!read.changeset) return toolError("no_changeset", "No change set has been ingested for this review yet.");
      const changeset = redactChangeSetForExport(read.changeset);
      if (homePathLeak(changeset.source, backends.homeDir())) {
        return toolError("path_leak_blocked", "The change set source carried an absolute machine path and was withheld.");
      }
      return toolSuccess({ changeset, truncated: false });
    }
  };
  const reviewGetBrief = {
    name: "review_get_brief",
    description: "Read the current walkthrough (brief) for a review, or null when none exists yet or the stored one is unusable. Use it to carry unchanged steps across an incremental re-run.",
    inputSchema: REVIEW_TARGET_SCHEMA,
    handler: async (args) => {
      const target = await resolveReviewDir(args);
      if ("content" in target) return target;
      const brief = await readBriefFromDir(target.reviewDir);
      if (brief && homePathLeak(brief, backends.homeDir())) {
        return toolError("path_leak_blocked", "The stored brief carried an absolute machine path and was withheld.");
      }
      return toolSuccess({ brief });
    }
  };
  const reviewSubmitBrief = {
    name: "review_submit_brief",
    // The one review tool that WRITES (DESIGN D11): it persists brief.json. A
    // remote (tailnet) caller therefore needs `<family>:operate` rather than the
    // read-only scope, and every call is written to the gateway audit.
    mutates: true,
    description: "Persist a walkthrough (brief) for a review. Pass the brief as an object (never a JSON string). It is validated server-side in order \u2014 schema (the annotation-kind enum is the no-verdicts firewall), then a cross-check against the change set loaded here, then a machine-path leak guard. An invalid brief returns every validator message and writes nothing; a valid brief is written atomically and an open Reviews door reloads it.",
    inputSchema: {
      type: "object",
      properties: {
        reviewId: REVIEW_TARGET_SCHEMA.properties.reviewId,
        projectRoot: REVIEW_TARGET_SCHEMA.properties.projectRoot,
        brief: { type: "object", description: "The brief object; see the review-guide skill for its shape." }
      },
      required: ["reviewId", "projectRoot", "brief"],
      additionalProperties: false
    },
    handler: async (args) => {
      const target = await resolveReviewDir(args);
      if ("content" in target) return target;
      const { brief } = args;
      if (typeof brief !== "object" || brief === null || Array.isArray(brief)) {
        return toolError("invalid_arguments", '"brief" must be the brief object, not a JSON string.');
      }
      const shape = validateReviewBrief(brief);
      if (!shape.ok) return reviewInvalid("brief_invalid", "The brief failed schema validation.", shape.errors);
      const read = await changeSets.read(target.reviewDir);
      if (!read.ok) return toolError("changeset_unreadable", "The stored change set could not be read or is not valid.");
      if (!read.changeset) return toolError("no_changeset", "No change set has been ingested for this review yet.");
      const match = checkBriefMatchesChangeSet(shape.value, read.changeset);
      if (!match.ok) return reviewInvalid("brief_mismatch", "The brief does not match the change set.", match.errors);
      const leak = homePathLeak(shape.value, backends.homeDir());
      if (leak) return reviewInvalid("brief_path_leak", "The brief contains an absolute machine path.", [leak]);
      await writeBriefAtomic(target.reviewDir, shape.value);
      backends.emitBriefRunEvent({ workspaceId: target.reviewId, phase: "done" });
      return toolSuccess({ ok: true, reviewId: target.reviewId, stepCount: shape.value.steps.length });
    }
  };
  return [reviewListPending, reviewGetChangeset, reviewGetBrief, reviewSubmitBrief];
}
function redactChangeSetForExport(changeset) {
  const source = changeset.source.kind === "branch" ? { kind: "branch", baseRef: changeset.source.baseRef, headRef: changeset.source.headRef } : changeset.source;
  return { ...changeset, source };
}
function reviewInvalid(code, message, errors) {
  const structured = { ok: false, error: { code, message }, errors };
  return {
    content: [{ type: "text", text: JSON.stringify(structured, null, 2) }],
    structuredContent: structured,
    isError: true
  };
}

// src/main/guide-terminal-service.ts
var import_path5 = require("path");

// src/main/guide-run-registry.ts
var TERMINAL_PHASES = /* @__PURE__ */ new Set(["done", "failed"]);
var GuideRunRegistry = class {
  // Keyed by review id (the id the review's `.sprintengine/review/<id>/` directory
  // is named for), which is also the BriefRunEvent `workspaceId`.
  runs = /* @__PURE__ */ new Map();
  nextRunId = 1;
  // Mark a run as started, replacing any retained terminal record so a remount
  // shows the run happening now instead of the last one's failure.
  begin(reviewId, startedAt = (/* @__PURE__ */ new Date()).toISOString()) {
    const runId = this.nextRunId++;
    this.runs.set(reviewId, { runId, running: true, phase: "reading", startedAt });
    return {
      record: (phase, detail) => {
        if (this.runs.get(reviewId)?.runId !== runId) return false;
        this.write(reviewId, runId, startedAt, phase, detail);
        return true;
      }
    };
  }
  // Record a phase for a run this registry never saw begin — a guide the app
  // did not start, or a transport that reports only its outcome. It adopts the
  // review's current run when there is one, so status never lies by omission.
  record(reviewId, phase, detail) {
    const existing = this.runs.get(reviewId);
    this.write(
      reviewId,
      existing?.runId ?? this.nextRunId++,
      existing?.startedAt ?? (/* @__PURE__ */ new Date()).toISOString(),
      phase,
      detail
    );
  }
  // The run state of record for a review, or null when the guide has never run
  // for it in this app session. A terminal phase is retained until the next
  // begin(); it is never cleared on read.
  status(reviewId) {
    const entry = this.runs.get(reviewId);
    if (!entry) return null;
    const { running, phase, detail, startedAt } = entry;
    return detail ? { running, phase, detail, startedAt } : { running, phase, startedAt };
  }
  write(reviewId, runId, startedAt, phase, detail) {
    const running = !TERMINAL_PHASES.has(phase);
    this.runs.set(reviewId, detail ? { runId, running, phase, detail, startedAt } : { runId, running, phase, startedAt });
  }
};
var guideRunRegistry = new GuideRunRegistry();

// src/main/guide-terminal-service.ts
var REVIEW_GUIDE_SKILL_ID = "review-guide";
var REVIEW_GUIDE_AGENT_NAME = "Review guide";
var REVIEW_GUIDE_AGENT_PREFIX = "review-guide-";
var REVIEW_GUIDE_ROLE = "review-guide";
var REVIEW_GUIDE_SKILL_FILE = `.agents/skills/${REVIEW_GUIDE_SKILL_ID}/SKILL.md`;
var REVIEW_ID_PATTERN2 = /^[A-Za-z0-9._-]+$/;
var ENDED_WITHOUT_BRIEF_DETAIL = "The guide session ended without delivering a walkthrough \u2014 its terminal has the details.";
var STOPPED_DETAIL = "You stopped the guide.";
var NO_WORKSPACE_DETAIL = "Open the project to run the guide.";
function reviewGuideAgentId(reviewId) {
  return `${REVIEW_GUIDE_AGENT_PREFIX}${reviewId}`;
}
var ReviewGuideTerminalService = class {
  deps;
  agents;
  guideRuns;
  // At most ONE open run per review, so starting a run replaces (and thereby
  // clears) whatever the review had before — no record accumulates. The entry
  // remembers the terminal's EXECUTION id, which is unique per pty unlike the
  // deliberately stable agent id, so a replaced terminal's exit is recognised
  // as belonging to a run that is over and can never fail its successor.
  inFlight = /* @__PURE__ */ new Map();
  // The CLI-native skill invocation the host reported for a review's guide
  // (`/review-guide` on Claude, `Use $review-guide.` on Codex). A spawn only
  // learns it in its RESULT — by which time the opening prompt has been
  // delivered — so the opening turn leads with the skill FILE and every later
  // turn into that same terminal leads with the invocation. See SDK-FINDINGS.
  skillInvocations = /* @__PURE__ */ new Map();
  stopWatchdog;
  constructor(deps) {
    this.deps = deps;
    this.agents = deps.agents;
    this.guideRuns = deps.guideRuns ?? guideRunRegistry;
    this.stopWatchdog = this.agents.onExit((event) => this.onAgentExit(event));
  }
  // Release the exit listener. Called when the module tears down, so an
  // uninstall/reload cycle never leaves a listener pointed at a dead service.
  dispose() {
    this.stopWatchdog();
  }
  // Start (or join) the guide run for a review. One guide terminal per review:
  // a live terminal receives the new prompt, otherwise one is spawned. A start
  // against a run already in flight reports that run instead of interrupting it,
  // unless the caller asked for a restart (the freshness re-run does).
  async startRun(input) {
    const { reviewId, depth, affectedStepIds, restart } = input;
    const invalid = validateTarget(input);
    if (invalid) return { ok: false, error: invalid };
    const live = this.guideRuns.status(reviewId);
    if (live?.running && !restart) {
      const joined = this.currentHandle(reviewId);
      if (joined) return { ok: true, joined: true, status: live, guide: joined };
    }
    const recorder = this.guideRuns.begin(reviewId);
    if (input.workspaceId.trim().length === 0) return this.fail(recorder, reviewId, NO_WORKSPACE_DETAIL);
    const projectRoot = (0, import_path5.resolve)(input.projectRoot);
    const prompt = this.buildRunPrompt({ reviewId, projectRoot, depth, affectedStepIds });
    this.emitPhase(recorder, reviewId, "reading");
    const delivered = await this.deliver(input, prompt);
    if (!delivered.ok) return this.fail(recorder, reviewId, delivered.error);
    this.agents.setReapExempt(delivered.guide.sessionId, true);
    this.inFlight.set(reviewId, { executionId: delivered.executionId, recorder });
    this.emitPhase(recorder, reviewId, "grouping");
    return { ok: true, guide: delivered.guide, reused: delivered.reused };
  }
  // "Ask the guide": send one question to the review's guide terminal, spawning
  // it when none is live. The answer is read in the terminal — that is the point
  // of the redesign — so this reports only where to look, never a reply. Asking
  // is not a run: it records no phase and never touches an in-flight walkthrough.
  async ask(input) {
    const { reviewId, question } = input;
    const invalid = validateTarget(input);
    if (invalid) return { ok: false, error: invalid };
    if (input.workspaceId.trim().length === 0) return { ok: false, error: NO_WORKSPACE_DETAIL };
    if (question.trim().length === 0) return { ok: false, error: "Ask the guide a question first." };
    const projectRoot = (0, import_path5.resolve)(input.projectRoot);
    const prompt = this.buildAskPrompt({ reviewId, projectRoot, question: question.trim() });
    const delivered = await this.deliver(input, prompt);
    if (!delivered.ok) return { ok: false, error: delivered.error };
    return { ok: true, guide: delivered.guide };
  }
  // The reviewer stopped the run. Kill the guide's terminal and record the stop
  // as this run's terminal phase, so the panel shows why it ended and the
  // watchdog stays silent for the exit it is about to see.
  stop(reviewId) {
    const sessionId = this.findGuideSession(reviewId)?.sessionId;
    const entry = this.inFlight.get(reviewId);
    this.inFlight.delete(reviewId);
    if (entry) this.emitPhase(entry.recorder, reviewId, "failed", STOPPED_DETAIL);
    else if (this.guideRuns.status(reviewId)?.running) {
      this.guideRuns.record(reviewId, "failed", STOPPED_DETAIL);
      this.deps.emit({ workspaceId: reviewId, phase: "failed", detail: STOPPED_DETAIL });
    }
    if (!sessionId) return;
    this.agents.setReapExempt(sessionId, false);
    this.agents.kill(sessionId);
  }
  // The run ended by delivering: `review_submit_brief` landed and the gateway's
  // sink calls this. The terminal is still alive and the reviewer may never open
  // it, so without this the pty stays exempt from the idle reaper for the rest
  // of the app session — one unsuspendable agent process retained per reviewed
  // change. The in-flight record goes with it: the run is over, so a later
  // stop() must not overwrite the delivered `done` with a failure.
  clearReapExempt(reviewId) {
    this.inFlight.delete(reviewId);
    const sessionId = this.findGuideSession(reviewId)?.sessionId;
    if (sessionId) this.agents.setReapExempt(sessionId, false);
  }
  // The watchdog. A guide terminal that ends without a brief failed, whatever
  // the reason — a crashed CLI, a closed tab, an agent that gave up. The
  // registry, not this map, decides whether the run is still open: a brief that
  // landed through review_submit_brief already closed it, and the terminal
  // exiting afterwards is just the CLI quitting.
  //
  // Correlation is by EXECUTION id, never the agent id: disposing a dead
  // terminal fires its exit after its replacement has already started, and the
  // two share an agent id by design.
  onAgentExit(event) {
    const found = [...this.inFlight].find(([, entry2]) => entry2.executionId === event.executionId);
    if (!found) return;
    const [reviewId, entry] = found;
    this.inFlight.delete(reviewId);
    const sessionId = this.findGuideSession(reviewId)?.sessionId;
    if (sessionId) this.agents.setReapExempt(sessionId, false);
    if (!this.guideRuns.status(reviewId)?.running) return;
    this.emitPhase(entry.recorder, reviewId, "failed", ENDED_WITHOUT_BRIEF_DETAIL);
  }
  // Deliver a prompt to the guide: paste it into the live terminal, or spawn one
  // with the prompt as its opening turn.
  //
  // A live session takes `send` rather than a `reuseLive` spawn, because only
  // that path can lead the prompt with the CLI-native skill invocation this
  // review's spawn already reported.
  async deliver(input, prompt) {
    const { reviewId } = input;
    const liveSession = this.findGuideSession(reviewId);
    if (liveSession?.isLive && !liveSession.suspended && liveSession.executionId) {
      const lead = this.skillInvocations.get(reviewId);
      const sent = await this.agents.send(liveSession.sessionId, lead ? `${lead}

${prompt}` : prompt);
      if (!sent.ok) {
        return { ok: false, error: sent.message ?? "Could not deliver the prompt to the guide terminal." };
      }
      return {
        ok: true,
        reused: true,
        executionId: liveSession.executionId,
        guide: {
          workspaceId: liveSession.workspaceId ?? input.workspaceId,
          agentId: liveSession.agentId ?? reviewGuideAgentId(reviewId),
          sessionId: liveSession.sessionId,
          cli: liveSession.cli ?? ""
        }
      };
    }
    const spawned = await this.agents.spawn({
      workspaceId: input.workspaceId,
      cwd: (0, import_path5.resolve)(input.projectRoot),
      prompt: `${this.fallbackSkillLead()}

${prompt}`,
      skill: { id: REVIEW_GUIDE_SKILL_ID },
      agentIdPrefix: REVIEW_GUIDE_AGENT_PREFIX,
      agentIdKey: reviewId,
      // The guide reads the change, the surrounding code, and the knowledge
      // graph, then calls the review tools — unattended. On the default preset
      // it stalls at the first approval prompt with nobody watching.
      permissionPreset: "bypass",
      label: REVIEW_GUIDE_AGENT_NAME,
      role: REVIEW_GUIDE_ROLE,
      reuseLive: true,
      ...input.cli?.trim() ? { cli: input.cli.trim() } : {},
      ...input.cliModel?.trim() ? { cliModel: input.cliModel.trim() } : {}
    });
    if (!spawned.ok) return { ok: false, error: spawned.message };
    if (spawned.skillInvocation) this.skillInvocations.set(reviewId, spawned.skillInvocation);
    else this.skillInvocations.delete(reviewId);
    return {
      ok: true,
      reused: spawned.reused,
      executionId: spawned.executionId,
      guide: {
        workspaceId: spawned.workspaceId,
        agentId: spawned.agentId,
        sessionId: spawned.sessionId,
        cli: spawned.cli
      }
    };
  }
  // This review's guide terminal, live or retained, found by AGENT id — the one
  // identity that is stable across spawns now that session ids are minted. The
  // host filters `list()` to this module's own agent-id namespaces, so nothing
  // here can see another module's agents or the reviewer's own.
  findGuideSession(reviewId) {
    const agentId = reviewGuideAgentId(reviewId);
    return this.agents.list().find((session) => session.agentId === agentId);
  }
  // The join prompt carries ONLY run coordinates. Every word about what a
  // walkthrough is and how to build one lives in the skill.
  buildRunPrompt(input) {
    const refresh = input.affectedStepIds?.length ? [`Refresh: regenerate only these steps, carry the rest over verbatim: ${input.affectedStepIds.join(", ")}`] : [];
    return [
      "You are the Review guide for this review. Build its walkthrough and deliver it with review_submit_brief.",
      "",
      `Review: ${input.reviewId}`,
      `Project root: ${input.projectRoot}`,
      `Depth: ${input.depth}`,
      ...refresh
    ].join("\n");
  }
  buildAskPrompt(input) {
    return [
      "You are the Review guide for this review. This is a question from the reviewer, not a request for a",
      "walkthrough: answer it in this terminal and submit nothing.",
      "",
      `Review: ${input.reviewId}`,
      `Project root: ${input.projectRoot}`,
      "",
      `Question: ${input.question}`
    ].join("\n");
  }
  // How the guide gets its instructions on the opening turn. The host installs
  // the skill into the project before the CLI starts, so pointing at the
  // harness-neutral file works under every CLI — including the ones whose
  // plugin declares no native skill form. The craft text reaches the agent from
  // the skill and is never restated here.
  fallbackSkillLead() {
    return `Read ${REVIEW_GUIDE_SKILL_FILE} and follow it for this whole session.`;
  }
  // The terminal a joinable run is running in, or null when nothing is live
  // under this review's guide id.
  currentHandle(reviewId) {
    const session = this.findGuideSession(reviewId);
    if (!session?.isLive) return null;
    return {
      workspaceId: session.workspaceId ?? "",
      agentId: session.agentId ?? reviewGuideAgentId(reviewId),
      sessionId: session.sessionId,
      cli: session.cli ?? ""
    };
  }
  // Both sinks, one decision: the registry (which outlives the renderer) and the
  // live event channel. A run the registry has already replaced goes silent on
  // both, so a dying run never reports on the one that replaced it.
  emitPhase(recorder, reviewId, phase, detail) {
    if (!recorder.record(phase, detail)) return;
    this.deps.emit(detail ? { workspaceId: reviewId, phase, detail } : { workspaceId: reviewId, phase });
  }
  fail(recorder, reviewId, error) {
    this.emitPhase(recorder, reviewId, "failed", error);
    return { ok: false, error };
  }
};
function createReviewGuideTerminalService(deps) {
  return new ReviewGuideTerminalService(deps);
}
function recordGuideRunEvent(event, registry = guideRunRegistry) {
  registry.record(event.workspaceId, event.phase, event.detail);
}
function validateTarget(input) {
  if (typeof input.reviewId !== "string" || !REVIEW_ID_PATTERN2.test(input.reviewId)) {
    return "That review id is not a review this app can address.";
  }
  if (typeof input.projectRoot !== "string" || input.projectRoot.trim().length === 0) {
    return NO_WORKSPACE_DETAIL;
  }
  return null;
}

// src/main/review-ipc.ts
var import_promises6 = require("fs/promises");
var import_path8 = require("path");

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

// src/main/review-state-store.ts
var import_promises4 = require("fs/promises");
var import_crypto3 = require("crypto");
var import_path6 = require("path");
var STATE_FILE = "state.json";
async function readReviewState(reviewDir) {
  let raw;
  try {
    raw = await (0, import_promises4.readFile)((0, import_path6.join)(reviewDir, STATE_FILE), "utf-8");
  } catch (error) {
    if (error?.code === "ENOENT") return { ok: true, state: null };
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: "Stored review state is not valid JSON." };
  }
  const validation = validateReviewWorkspaceState(parsed);
  if (!validation.ok) return { ok: false, error: `Stored review state is invalid: ${validation.errors[0]}` };
  return { ok: true, state: validation.value };
}
async function writeReviewState(reviewDir, state) {
  const validation = validateReviewWorkspaceState(state);
  if (!validation.ok) {
    throw new Error(`Refusing to persist an invalid review state: ${validation.errors[0]}`);
  }
  await (0, import_promises4.mkdir)(reviewDir, { recursive: true });
  const finalPath = (0, import_path6.join)(reviewDir, STATE_FILE);
  const tempPath = (0, import_path6.join)(reviewDir, `.${STATE_FILE}.${(0, import_crypto3.randomUUID)()}.tmp`);
  const data = `${JSON.stringify(validation.value, null, 2)}
`;
  try {
    await (0, import_promises4.writeFile)(tempPath, data, "utf-8");
    await (0, import_promises4.rename)(tempPath, finalPath);
  } catch (error) {
    await (0, import_promises4.unlink)(tempPath).catch(() => {
    });
    throw error;
  }
}

// src/main/providers/github-pr-provider.ts
var PROBE_TIMEOUT_MS = 3e3;
var BUILD_FETCH_TIMEOUT_MS = 6e4;
var JSON_ACCEPT = "application/vnd.github+json";
var DIFF_ACCEPT = "application/vnd.github.v3.diff";
var API_VERSION = "2022-11-28";
var USER_AGENT = "SprintEngine-Review";
var NOT_A_GITHUB_PR = "That does not look like a GitHub pull request URL (expected \u2026/owner/repo/pull/123).";
var BITBUCKET_UNSUPPORTED = "Bitbucket support is planned. For now, paste a GitHub pull request URL or use a branch/patch source.";
var ProbeTimeout = class extends Error {
};
function createGithubPrProvider(deps) {
  return {
    async build(input) {
      const parsed = requirePullRequest(input);
      const { meta, diff } = await fetchPullRequest(parsed, deps);
      assertFileCount2(meta.changedFiles);
      assertDiffSize(diff);
      const result = parsePatch(diff);
      if (!result.ok) throw new Error(result.error);
      assertFileCount2(result.files.length);
      const source = {
        kind: "pull-request",
        provider: parsed.provider,
        host: parsed.host,
        owner: parsed.owner,
        repo: parsed.repo,
        number: parsed.number,
        url: canonicalPullRequestUrl(parsed)
      };
      return {
        source,
        title: meta.title,
        description: meta.description,
        baseRef: meta.baseRef,
        baseSha: meta.baseSha,
        headRef: meta.headRef,
        headSha: meta.headSha,
        files: result.files,
        stats: result.stats,
        // headSha pins the identity: re-ingesting the same PR head yields the same
        // change-set id; a new push changes it.
        identity: `pull-request
${parsed.host}
${parsed.owner}/${parsed.repo}
${parsed.number}
${meta.headSha}`
      };
    },
    async probe(input) {
      if (input.kind !== "pull-request") return { ok: false, error: NOT_A_GITHUB_PR };
      const parsed = parsePullRequestUrl(input.url);
      if (!parsed) return { ok: false, error: NOT_A_GITHUB_PR };
      if ("unsupported" in parsed) return { ok: false, error: BITBUCKET_UNSUPPORTED };
      try {
        const meta = await withTimeout(fetchMeta(parsed, deps, PROBE_TIMEOUT_MS), PROBE_TIMEOUT_MS);
        return {
          ok: true,
          title: meta.title,
          stats: { files: meta.changedFiles ?? 0, additions: meta.additions, deletions: meta.deletions },
          headSha: meta.headSha
        };
      } catch (error) {
        if (error instanceof ProbeTimeout || isAbortLike(error)) {
          return { ok: true, title: `${parsed.owner}/${parsed.repo} #${parsed.number}` };
        }
        return { ok: false, error: messageOf2(error) };
      }
    }
  };
}
function requirePullRequest(input) {
  if (input.kind !== "pull-request") throw new Error("GitHub provider received a non-pull-request source.");
  const parsed = parsePullRequestUrl(input.url);
  if (!parsed) throw new Error(NOT_A_GITHUB_PR);
  if ("unsupported" in parsed) throw new Error(BITBUCKET_UNSUPPORTED);
  return parsed;
}
async function fetchPullRequest(parsed, deps) {
  if (await deps.gh.available()) {
    const viaGh = await ghFetchFull(parsed, deps);
    if (viaGh.ok) return { meta: viaGh.meta, diff: viaGh.diff };
  }
  const token = await deps.resolveToken(parsed.host, parsed.provider);
  const url = restPullUrl(parsed);
  const meta = await restJson(deps, url, token, BUILD_FETCH_TIMEOUT_MS);
  if (!meta.ok) throw httpError(meta.status, parsed, Boolean(token));
  const diff = await restDiff(deps, url, token, BUILD_FETCH_TIMEOUT_MS);
  if (!diff.ok) throw httpError(diff.status, parsed, Boolean(token));
  return { meta: metaFromRest(meta.json), diff: diff.diff };
}
async function fetchMeta(parsed, deps, timeoutMs) {
  if (await deps.gh.available()) {
    const viaGh = await ghView(parsed, deps);
    if (viaGh.ok) return viaGh.meta;
  }
  const token = await deps.resolveToken(parsed.host, parsed.provider);
  const meta = await restJson(deps, restPullUrl(parsed), token, timeoutMs);
  if (!meta.ok) throw httpError(meta.status, parsed, Boolean(token));
  return metaFromRest(meta.json);
}
async function ghFetchFull(parsed, deps) {
  const view = await ghView(parsed, deps);
  if (!view.ok) return { ok: false };
  const diff = await deps.gh.run(["pr", "diff", String(parsed.number), "--repo", ghRepoArg(parsed), "--patch"]);
  if (diff.code !== 0) return { ok: false };
  return { ok: true, meta: view.meta, diff: diff.stdout };
}
async function ghView(parsed, deps) {
  const result = await deps.gh.run([
    "pr",
    "view",
    String(parsed.number),
    "--repo",
    ghRepoArg(parsed),
    "--json",
    "title,body,baseRefName,headRefName,baseRefOid,headRefOid,additions,deletions,changedFiles"
  ]);
  if (result.code !== 0) return { ok: false };
  let json;
  try {
    json = JSON.parse(result.stdout);
  } catch {
    return { ok: false };
  }
  return { ok: true, meta: metaFromGh(json) };
}
function ghRepoArg(parsed) {
  return `${parsed.host}/${parsed.owner}/${parsed.repo}`;
}
function restPullUrl(parsed) {
  const base = parsed.provider === "github" ? "https://api.github.com" : `https://${parsed.host}/api/v3`;
  return `${base}/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}/pulls/${parsed.number}`;
}
function restHeaders(accept, token) {
  const headers = {
    Accept: accept,
    "User-Agent": USER_AGENT,
    "X-GitHub-Api-Version": API_VERSION
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}
async function restJson(deps, url, token, timeoutMs) {
  const res = await deps.fetchImpl(url, { headers: restHeaders(JSON_ACCEPT, token), signal: timeoutSignal(timeoutMs) });
  if (!res.ok) return { ok: false, status: res.status };
  return { ok: true, json: await res.json() };
}
async function restDiff(deps, url, token, timeoutMs) {
  const res = await deps.fetchImpl(url, { headers: restHeaders(DIFF_ACCEPT, token), signal: timeoutSignal(timeoutMs) });
  if (!res.ok) return { ok: false, status: res.status };
  return { ok: true, diff: await res.text() };
}
function metaFromRest(json) {
  if (!isRecord(json)) throw unexpectedPayload();
  const base = json.base;
  const head = json.head;
  if (!isRecord(base) || !isRecord(head)) throw unexpectedPayload();
  const meta = {
    title: requireString(json.title),
    description: optionalString(json.body),
    baseRef: requireString(base.ref),
    baseSha: requireString(base.sha),
    headRef: requireString(head.ref),
    headSha: requireString(head.sha),
    changedFiles: optionalInt(json.changed_files),
    additions: optionalInt(json.additions) ?? 0,
    deletions: optionalInt(json.deletions) ?? 0
  };
  return meta;
}
function metaFromGh(json) {
  if (!isRecord(json)) throw unexpectedPayload();
  return {
    title: requireString(json.title),
    description: optionalString(json.body),
    baseRef: requireString(json.baseRefName),
    baseSha: requireString(json.baseRefOid),
    headRef: requireString(json.headRefName),
    headSha: requireString(json.headRefOid),
    changedFiles: optionalInt(json.changedFiles),
    additions: optionalInt(json.additions) ?? 0,
    deletions: optionalInt(json.deletions) ?? 0
  };
}
function httpError(status, parsed, hasToken) {
  const setup = authSetupHint(parsed);
  if (status === 401) {
    return new Error(`GitHub rejected the credentials (401). ${setup}`);
  }
  if (status === 404) {
    return hasToken ? new Error(`Pull request not found, or the token cannot access ${parsed.owner}/${parsed.repo} (404).`) : new Error(`Pull request not found. If the repository is private, set up access \u2014 ${lowerFirst(setup)}`);
  }
  if (status === 403) {
    return new Error(`GitHub denied the request (403) \u2014 rate limit or missing scope. ${setup}`);
  }
  return new Error(`GitHub request failed (HTTP ${status}).`);
}
function authSetupHint(parsed) {
  return `Install the GitHub CLI and run \`gh auth login\`, or set a ${tokenEnvName(parsed.provider)} environment token with access to this repository.`;
}
function tokenEnvName(provider) {
  return provider === "github" ? "GH_TOKEN" : "GH_ENTERPRISE_TOKEN";
}
function assertFileCount2(count) {
  if (typeof count === "number" && count > MAX_CHANGESET_FILES) {
    throw new Error(`Pull request has too many files to review (${count}; limit ${MAX_CHANGESET_FILES}).`);
  }
}
function assertDiffSize(diff) {
  const bytes = Buffer.byteLength(diff, "utf8");
  if (bytes > MAX_PATCH_BYTES) {
    throw new Error(`Pull request diff is too large to review (limit ${(MAX_PATCH_BYTES / (1024 * 1024)).toFixed(0)} MiB).`);
  }
}
function withTimeout(promise, ms) {
  return new Promise((resolve3, reject) => {
    const timer = setTimeout(() => reject(new ProbeTimeout()), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve3(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}
function timeoutSignal(ms) {
  try {
    return AbortSignal.timeout(ms);
  } catch {
    return void 0;
  }
}
function requireString(value) {
  if (typeof value !== "string" || value.length === 0) throw unexpectedPayload();
  return value;
}
function optionalString(value) {
  return typeof value === "string" && value.length > 0 ? value : void 0;
}
function optionalInt(value) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : void 0;
}
function unexpectedPayload() {
  return new Error("GitHub returned an unexpected pull request payload.");
}
function lowerFirst(text) {
  return text.length > 0 ? text[0].toLowerCase() + text.slice(1) : text;
}
function messageOf2(error) {
  return error instanceof Error ? error.message : String(error);
}
function isAbortLike(error) {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}
function parseGitRemoteRef(rawRemote) {
  const trimmed = rawRemote.trim();
  if (!trimmed) return null;
  if (!trimmed.includes("://")) {
    if (/^[a-zA-Z]:[\\/]/.test(trimmed)) return null;
    const scp = /^(?:[^@/]+@)?([^/:]+):(.+)$/.exec(trimmed);
    return scp ? refFromHostAndPath(scp[1], scp[2]) : null;
  }
  let url;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  return refFromHostAndPath(url.hostname, url.pathname);
}
function refFromHostAndPath(host, path) {
  const normalizedHost = host.trim().toLowerCase();
  if (!normalizedHost) return null;
  const segments = path.replace(/\.git$/i, "").split("/").map((segment) => segment.trim()).filter((segment) => segment.length > 0);
  if (segments.length < 2) return null;
  return {
    host: normalizedHost,
    owner: segments[segments.length - 2].toLowerCase(),
    repo: segments[segments.length - 1].toLowerCase()
  };
}
function remoteMatchesPullRequest(remote, pr) {
  return remote.host === pr.host.toLowerCase() && remote.owner === pr.owner.toLowerCase() && remote.repo === pr.repo.toLowerCase();
}
async function readProjectRemoteUrls(root) {
  const result = await runGitCommand(root, ["config", "--get-regexp", "^remote\\..*\\.url$"]);
  if (!result.ok) return [];
  return result.stdout.split(/\r?\n/).map((line) => {
    const space = line.indexOf(" ");
    return space === -1 ? "" : line.slice(space + 1).trim();
  }).filter((value) => value.length > 0);
}
async function matchPrProjectRoots(url, roots, readRemoteUrls = readProjectRemoteUrls) {
  const parsed = parsePullRequestUrl(url);
  if (!parsed || "unsupported" in parsed) return [];
  const matches = [];
  const seen = /* @__PURE__ */ new Set();
  for (const root of roots) {
    if (typeof root !== "string" || root.length === 0 || seen.has(root)) continue;
    seen.add(root);
    const remoteUrls = await readRemoteUrls(root);
    const matched = remoteUrls.some((remoteUrl) => {
      const ref = parseGitRemoteRef(remoteUrl);
      return ref !== null && remoteMatchesPullRequest(ref, parsed);
    });
    if (matched) matches.push(root);
  }
  return matches;
}
function defaultDeps() {
  return {
    gh: sharedGhRunner(),
    fetchImpl: (url, init) => fetch(url, init),
    resolveToken: defaultResolveToken
  };
}
var githubPrProvider = createGithubPrProvider(defaultDeps());
registerReviewSourceProvider("pull-request", githubPrProvider);

// src/main/providers/github-review-sync.ts
var import_promises5 = require("fs/promises");
var import_os = require("os");
var import_path7 = require("path");
var JSON_ACCEPT2 = "application/vnd.github+json";
var DIFF_ACCEPT2 = "application/vnd.github.v3.diff";
var API_VERSION2 = "2022-11-28";
var USER_AGENT2 = "SprintEngine-Review";
var POST_FETCH_TIMEOUT_MS = 6e4;
var MOVED = "moved";
var HttpError = class extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
};
async function postReview(changeset, comments, deps) {
  const source = changeset.source;
  if (source.kind !== "pull-request") {
    return { ok: false, error: "Only pull-request reviews can be posted to a remote." };
  }
  const pr = {
    provider: source.provider,
    host: source.host,
    owner: source.owner,
    repo: source.repo,
    number: source.number
  };
  const postable = comments.filter((c) => c.sync.state === "pending" || c.sync.state === "failed");
  if (postable.length === 0) return { ok: true, outcomes: [] };
  let currentHead;
  try {
    currentHead = await fetchHeadSha(pr, deps);
  } catch (error) {
    return { ok: false, error: authAwareMessage(error, pr) };
  }
  const headMoved = Boolean(changeset.headSha) && changeset.headSha !== currentHead;
  let currentFiles;
  let deltasByPath;
  try {
    if (headMoved) {
      currentFiles = indexFiles(await fetchPullRequestDiff(pr, deps));
      deltasByPath = await fetchNewSideDeltas(pr, changeset.headSha, currentHead, deps);
    } else {
      currentFiles = indexFiles(changeset.files);
      deltasByPath = /* @__PURE__ */ new Map();
    }
  } catch (error) {
    return { ok: false, error: authAwareMessage(error, pr) };
  }
  const outcomes = [];
  const batch = [];
  for (const comment of postable) {
    const resolved = resolveComment(comment, headMoved, deltasByPath, currentFiles);
    if (resolved.ok) batch.push(resolved.value);
    else outcomes.push({ id: comment.id, sync: { state: "pending" }, anchorStatus: MOVED });
  }
  if (batch.length === 0) {
    return { ok: true, outcomes };
  }
  let review;
  try {
    review = await createReview(pr, currentHead, batch, deps);
  } catch (error) {
    return { ok: false, error: authAwareMessage(error, pr) };
  }
  const postedAt = deps.now();
  for (const resolved of batch) {
    const url = review.commentUrls.get(commentKey(resolved)) ?? review.reviewUrl;
    outcomes.push({ id: resolved.id, sync: { state: "posted", url, postedAt } });
  }
  return { ok: true, reviewUrl: review.reviewUrl, outcomes };
}
function resolveComment(comment, headMoved, deltasByPath, currentFiles) {
  if (comment.anchorStatus === MOVED) return { ok: false };
  let startLine = comment.anchor.startLine;
  let endLine = comment.anchor.endLine;
  if (headMoved && comment.anchor.side === "new") {
    const deltas = deltasByPath.get(comment.path);
    if (deltas && deltas.length > 0) {
      const shifted = shiftAnchor(comment.anchor, deltas);
      if (!shifted) return { ok: false };
      startLine = shifted.startLine;
      endLine = shifted.endLine;
    }
  }
  const file = currentFiles.get(comment.path);
  if (!file) return { ok: false };
  const commentable = commentableLines(file, comment.anchor.side);
  if (!commentable.has(startLine) || !commentable.has(endLine)) return { ok: false };
  return { ok: true, value: { id: comment.id, path: comment.path, side: comment.anchor.side, startLine, endLine, body: comment.body } };
}
function commentableLines(file, side) {
  const lines = /* @__PURE__ */ new Set();
  for (const hunk of file.hunks) {
    let oldLine = hunk.oldStart;
    let newLine = hunk.newStart;
    for (const { kind } of hunk.lines) {
      if (side === "new") {
        if (kind === "add" || kind === "context") lines.add(newLine);
      } else if (kind === "del" || kind === "context") {
        lines.add(oldLine);
      }
      if (kind !== "add") oldLine++;
      if (kind !== "del") newLine++;
    }
  }
  return lines;
}
function indexFiles(files) {
  return new Map(files.map((file) => [file.path, file]));
}
function newSideDeltasFromCompare(files) {
  const byPath = /* @__PURE__ */ new Map();
  for (const file of files) {
    const deltas = [];
    for (const hunk of file.hunks) {
      let oldLine = hunk.oldStart;
      let runStart = 0;
      let removed = 0;
      let added = 0;
      const flush = () => {
        if (removed > 0 || added > 0) deltas.push({ start: runStart, removed, added });
        removed = 0;
        added = 0;
      };
      for (const { kind } of hunk.lines) {
        if (kind === "context") {
          flush();
          oldLine++;
          continue;
        }
        if (removed === 0 && added === 0) runStart = oldLine;
        if (kind === "del") {
          removed++;
          oldLine++;
        } else {
          added++;
        }
      }
      flush();
    }
    if (deltas.length > 0) byPath.set(file.path, deltas);
  }
  return byPath;
}
async function fetchNewSideDeltas(pr, oldHead, newHead, deps) {
  const diff = await fetchCompareDiff(pr, oldHead, newHead, deps);
  const parsed = parsePatch(diff);
  if (!parsed.ok) throw new Error(parsed.error);
  return newSideDeltasFromCompare(parsed.files);
}
async function fetchHeadSha(pr, deps) {
  if (await deps.gh.available()) {
    const result = await deps.gh.run(["api", ...ghApiHost(pr), pullApiPath(pr)]);
    if (result.code === 0) {
      const head2 = readHeadSha(safeJson(result.stdout));
      if (head2) return head2;
    }
  }
  const token = await deps.resolveToken(pr.host, pr.provider);
  const res = await deps.fetchImpl(restUrl(pr, pullApiPath(pr)), {
    headers: restHeaders2(JSON_ACCEPT2, token),
    signal: timeoutSignal2(POST_FETCH_TIMEOUT_MS)
  });
  if (!res.ok) throw new HttpError(`GitHub request failed (HTTP ${res.status}).`, res.status);
  const head = readHeadSha(await res.json());
  if (!head) throw new Error("GitHub returned an unexpected pull request payload.");
  return head;
}
async function fetchPullRequestDiff(pr, deps) {
  let diff = null;
  if (await deps.gh.available()) {
    const result = await deps.gh.run(["pr", "diff", String(pr.number), "--repo", ghRepoArg2(pr), "--patch"]);
    if (result.code === 0) diff = result.stdout;
  }
  if (diff === null) {
    const token = await deps.resolveToken(pr.host, pr.provider);
    const res = await deps.fetchImpl(restUrl(pr, pullApiPath(pr)), {
      headers: restHeaders2(DIFF_ACCEPT2, token),
      signal: timeoutSignal2(POST_FETCH_TIMEOUT_MS)
    });
    if (!res.ok) throw new HttpError(`GitHub request failed (HTTP ${res.status}).`, res.status);
    diff = await res.text();
  }
  const parsed = parsePatch(diff);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.files;
}
async function fetchCompareDiff(pr, base, head, deps) {
  const path = `repos/${pr.owner}/${pr.repo}/compare/${base}...${head}`;
  if (await deps.gh.available()) {
    const result = await deps.gh.run(["api", ...ghApiHost(pr), path, "-H", `Accept: ${DIFF_ACCEPT2}`]);
    if (result.code === 0) return result.stdout;
  }
  const token = await deps.resolveToken(pr.host, pr.provider);
  const res = await deps.fetchImpl(restUrl(pr, path), {
    headers: restHeaders2(DIFF_ACCEPT2, token),
    signal: timeoutSignal2(POST_FETCH_TIMEOUT_MS)
  });
  if (!res.ok) throw new HttpError(`GitHub request failed (HTTP ${res.status}).`, res.status);
  return res.text();
}
async function createReview(pr, commitId, batch, deps) {
  const body = JSON.stringify({
    commit_id: commitId,
    event: "COMMENT",
    comments: batch.map(githubComment)
  });
  const reviewsPath = `repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/reviews`;
  let review;
  if (await deps.gh.available()) {
    review = await ghPostJson(reviewsPath, body, pr, deps);
  }
  if (review === void 0) {
    const token = await deps.resolveToken(pr.host, pr.provider);
    const res = await deps.fetchImpl(restUrl(pr, reviewsPath), {
      method: "POST",
      headers: { ...restHeaders2(JSON_ACCEPT2, token), "Content-Type": "application/json" },
      body,
      signal: timeoutSignal2(POST_FETCH_TIMEOUT_MS)
    });
    if (!res.ok) throw new HttpError(reviewPostMessage(res.status), res.status);
    review = await res.json();
  }
  const reviewId = readReviewId(review);
  const reviewUrl = readString(review, "html_url") ?? prWebUrl(pr);
  const commentUrls = reviewId !== void 0 ? await fetchReviewCommentUrls(pr, reviewId, deps).catch(() => /* @__PURE__ */ new Map()) : /* @__PURE__ */ new Map();
  return { reviewUrl, commentUrls };
}
function githubComment(resolved) {
  const side = resolved.side === "new" ? "RIGHT" : "LEFT";
  const comment = { path: resolved.path, line: resolved.endLine, side, body: resolved.body };
  if (resolved.endLine !== resolved.startLine) {
    comment.start_line = resolved.startLine;
    comment.start_side = side;
  }
  return comment;
}
async function fetchReviewCommentUrls(pr, reviewId, deps) {
  const path = `repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/reviews/${reviewId}/comments`;
  let payload;
  if (await deps.gh.available()) {
    const result = await deps.gh.run(["api", ...ghApiHost(pr), path]);
    if (result.code === 0) payload = safeJson(result.stdout);
  }
  if (payload === void 0) {
    const token = await deps.resolveToken(pr.host, pr.provider);
    const res = await deps.fetchImpl(restUrl(pr, path), {
      headers: restHeaders2(JSON_ACCEPT2, token),
      signal: timeoutSignal2(POST_FETCH_TIMEOUT_MS)
    });
    if (!res.ok) return /* @__PURE__ */ new Map();
    payload = await res.json();
  }
  const urls = /* @__PURE__ */ new Map();
  if (Array.isArray(payload)) {
    for (const entry of payload) {
      if (!isRecord(entry)) continue;
      const path_ = readString(entry, "path");
      const url = readString(entry, "html_url");
      const line = typeof entry.line === "number" ? entry.line : void 0;
      const side = entry.side === "LEFT" ? "old" : "new";
      if (path_ && url && line !== void 0) urls.set(`${path_}
${side}
${line}`, url);
    }
  }
  return urls;
}
function commentKey(resolved) {
  return `${resolved.path}
${resolved.side}
${resolved.endLine}`;
}
async function ghPostJson(apiPath, body, pr, deps) {
  const dir = await (0, import_promises5.mkdtemp)((0, import_path7.join)((0, import_os.tmpdir)(), "review-post-"));
  const file = (0, import_path7.join)(dir, "body.json");
  try {
    await (0, import_promises5.writeFile)(file, body, "utf-8");
    const result = await deps.gh.run(["api", ...ghApiHost(pr), apiPath, "--method", "POST", "--input", file]);
    if (result.code !== 0) throw new HttpError(ghErrorMessage(result.stderr), ghStatus(result.stderr));
    return safeJson(result.stdout) ?? {};
  } finally {
    await (0, import_promises5.rm)(dir, { recursive: true, force: true }).catch(() => {
    });
  }
}
function ghApiHost(pr) {
  return pr.provider === "github" ? [] : ["--hostname", pr.host];
}
function ghRepoArg2(pr) {
  return `${pr.host}/${pr.owner}/${pr.repo}`;
}
function pullApiPath(pr) {
  return `repos/${pr.owner}/${pr.repo}/pulls/${pr.number}`;
}
function restUrl(pr, apiPath) {
  const base = pr.provider === "github" ? "https://api.github.com" : `https://${pr.host}/api/v3`;
  return `${base}/${apiPath}`;
}
function prWebUrl(pr) {
  return `https://${pr.host}/${pr.owner}/${pr.repo}/pull/${pr.number}`;
}
function restHeaders2(accept, token) {
  const headers = { Accept: accept, "User-Agent": USER_AGENT2, "X-GitHub-Api-Version": API_VERSION2 };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}
function authAwareMessage(error, pr) {
  if (error instanceof HttpError) {
    const setup = authSetupHint2(pr.provider);
    if (error.status === 401) return `GitHub rejected the credentials (401). ${setup}`;
    if (error.status === 403) return `GitHub denied the request (403) \u2014 rate limit or missing scope. ${setup}`;
    if (error.status === 404) return `Pull request not found, or your credentials cannot access ${pr.owner}/${pr.repo} (404). ${setup}`;
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}
function reviewPostMessage(status) {
  if (status === 422) return "GitHub could not anchor one of the comments (422) \u2014 the pull request may have changed. Refresh the review and try again.";
  return `Posting the review failed (HTTP ${status}).`;
}
function authSetupHint2(provider) {
  const token = provider === "github" ? "GH_TOKEN" : "GH_ENTERPRISE_TOKEN";
  return `Install the GitHub CLI and run \`gh auth login\`, or set a ${token} environment token with access to this repository.`;
}
function ghStatus(stderr) {
  const match = stderr.match(/HTTP (\d{3})/);
  return match ? Number(match[1]) : 0;
}
function ghErrorMessage(stderr) {
  const status = ghStatus(stderr);
  if (status === 401 || status === 403 || status === 404 || status === 422) return `GitHub request failed (HTTP ${status}).`;
  const firstLine = stderr.split("\n").find((line) => line.trim().length > 0);
  return firstLine?.trim() || "The GitHub CLI could not post the review.";
}
function readHeadSha(json) {
  if (!isRecord(json)) return null;
  const head = json.head;
  if (isRecord(head) && typeof head.sha === "string" && head.sha.length > 0) return head.sha;
  return null;
}
function readReviewId(json) {
  if (isRecord(json) && typeof json.id === "number") return json.id;
  return void 0;
}
function readString(json, key) {
  if (isRecord(json) && typeof json[key] === "string" && json[key].length > 0) return json[key];
  return void 0;
}
function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return void 0;
  }
}
function timeoutSignal2(ms) {
  try {
    return AbortSignal.timeout(ms);
  } catch {
    return void 0;
  }
}
function defaultReviewSyncDeps() {
  return {
    gh: createDefaultGhRunner(),
    fetchImpl: (url, init) => fetch(url, init),
    resolveToken: defaultResolveToken,
    now: () => (/* @__PURE__ */ new Date()).toISOString()
  };
}

// src/main/review-ipc.ts
var BRIEF_FILE2 = "brief.json";
async function readBrief(targetDir) {
  let raw;
  try {
    raw = await (0, import_promises6.readFile)((0, import_path8.join)(targetDir, BRIEF_FILE2), "utf-8");
  } catch (error) {
    if (error?.code === "ENOENT") return { ok: true, brief: null };
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { ok: false, error: `brief.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  const validation = validateReviewBrief(parsed);
  if (!validation.ok) return { ok: false, error: validation.errors.join("\n") };
  return { ok: true, brief: validation.value };
}
function failure(error) {
  return { ok: false, error: error instanceof Error ? error.message : String(error) };
}
function registerReviewIpc(host, { changeSetService, guideTerminals, isUserWindowSender, reviewSyncDeps, guideRuns }) {
  const guideRunState = guideRuns ?? guideRunRegistry;
  host.registerIpc(REVIEW_CHANNELS.detectSource, (_event, payload) => {
    return changeSetService.detect(payload);
  });
  host.registerIpc(REVIEW_CHANNELS.ingestSource, async (_event, raw) => {
    const { input, target } = raw;
    try {
      const changeset = await changeSetService.ingest(
        input,
        reviewChangeSetDir(target.workspaceRoot, target.workspaceId)
      );
      return { ok: true, changeset };
    } catch (error) {
      return failure(error);
    }
  });
  host.registerIpc(REVIEW_CHANNELS.readChangeset, async (_event, raw) => {
    const target = raw;
    try {
      return await changeSetService.read(reviewChangeSetDir(target.workspaceRoot, target.workspaceId));
    } catch (error) {
      return failure(error);
    }
  });
  host.registerIpc(REVIEW_CHANNELS.readBrief, async (_event, raw) => {
    const target = raw;
    try {
      return await readBrief(reviewChangeSetDir(target.workspaceRoot, target.workspaceId));
    } catch (error) {
      return failure(error);
    }
  });
  host.registerIpc(REVIEW_CHANNELS.readState, async (_event, raw) => {
    const target = raw;
    try {
      return await readReviewState(reviewChangeSetDir(target.workspaceRoot, target.workspaceId));
    } catch (error) {
      return failure(error);
    }
  });
  host.registerIpc(REVIEW_CHANNELS.writeState, async (_event, raw) => {
    const { target, state } = raw;
    try {
      await writeReviewState(reviewChangeSetDir(target.workspaceRoot, target.workspaceId), state);
      return { ok: true };
    } catch (error) {
      return failure(error);
    }
  });
  host.registerIpc(REVIEW_CHANNELS.list, async (_event, raw) => {
    const { roots } = raw ?? {};
    try {
      return { ok: true, reviews: await enumerateReviews(Array.isArray(roots) ? roots : []) };
    } catch (error) {
      return failure(error);
    }
  });
  host.registerIpc(REVIEW_CHANNELS.matchPrProject, async (_event, raw) => {
    const { url, roots } = raw ?? {};
    try {
      const matches = await matchPrProjectRoots(
        typeof url === "string" ? url : "",
        Array.isArray(roots) ? roots : []
      );
      return { ok: true, matches };
    } catch (error) {
      return failure(error);
    }
  });
  host.registerIpc(REVIEW_CHANNELS.probeChangeset, async (_event, raw) => {
    try {
      return { ok: true, changeset: await changeSetService.build(raw) };
    } catch (error) {
      return failure(error);
    }
  });
  host.registerIpc(REVIEW_CHANNELS.listBranches, async (_event, raw) => {
    const { projectRoot } = raw ?? {};
    if (typeof projectRoot !== "string" || projectRoot.trim().length === 0) {
      return { ok: false, error: "Choose a project before picking branches." };
    }
    try {
      const { current, branches } = await listGitBranches(projectRoot);
      return { ok: true, current, branches };
    } catch (error) {
      return failure(error);
    }
  });
  host.registerIpc(REVIEW_CHANNELS.startBriefRun, async (_event, raw) => {
    const input = raw;
    const result = await guideTerminals.startRun({
      reviewId: input.reviewId,
      projectRoot: input.workspaceRoot,
      workspaceId: input.workspaceId,
      depth: input.depth,
      ...input.affectedStepIds ? { affectedStepIds: input.affectedStepIds } : {},
      ...input.cli ? { cli: input.cli } : {},
      ...input.cliModel ? { cliModel: input.cliModel } : {},
      ...input.restart ? { restart: true } : {}
    });
    if (!result.ok) return { ok: false, reason: "guide-error", errors: [result.error] };
    if ("joined" in result) return { ok: true, joined: true, status: result.status, guide: result.guide };
    return { ok: true, guide: result.guide };
  });
  host.registerIpc(REVIEW_CHANNELS.stopBriefRun, (_event, raw) => {
    const target = raw;
    guideTerminals.stop(target.workspaceId);
    return { ok: true };
  });
  host.registerIpc(REVIEW_CHANNELS.briefRunStatus, (_event, raw) => {
    const target = raw;
    return { ok: true, status: guideRunState.status(target.workspaceId) };
  });
  host.registerIpc(REVIEW_CHANNELS.askGuide, async (_event, raw) => {
    const input = raw;
    const result = await guideTerminals.ask({
      reviewId: input.reviewId,
      projectRoot: input.workspaceRoot,
      workspaceId: input.workspaceId,
      question: input.message,
      ...input.cli ? { cli: input.cli } : {},
      ...input.cliModel ? { cliModel: input.cliModel } : {}
    });
    return result.ok ? { ok: true, guide: result.guide } : { ok: false, error: result.error };
  });
  host.registerIpc(REVIEW_CHANNELS.postReview, async (event, raw) => {
    if (!isUserWindowSender || !isUserWindowSender(event)) {
      return { ok: false, error: "Posting a review must be initiated from the review window." };
    }
    const input = raw;
    try {
      const read = await changeSetService.read(
        reviewChangeSetDir(input.target.workspaceRoot, input.target.workspaceId)
      );
      if (!read.ok) return { ok: false, error: read.error };
      if (!read.changeset) return { ok: false, error: "There is no review to post yet." };
      return await postReview(read.changeset, input.comments, reviewSyncDeps ?? defaultReviewSyncDeps());
    } catch (error) {
      return failure(error);
    }
  });
}

// src/main/tokens.ts
var ReviewChangeSetServiceToken = createServiceToken("review.change-set-service");
var ReviewGuideTerminalServiceToken = createServiceToken("review.guide-terminal-service");

// src/main.ts
var STUDIO_REVIEW_SKILL_ID = "studio-review";
var registerMain = (host) => {
  const changeSetService = host.provideService(
    ReviewChangeSetServiceToken,
    () => createReviewChangeSetService()
  );
  const emit = (event) => {
    host.emit(BRIEF_RUN_EVENT_TOPIC, event);
  };
  const guideTerminals = host.provideService(
    ReviewGuideTerminalServiceToken,
    () => createReviewGuideTerminalService({ agents: getAgentSessionService(host), emit })
  );
  host.onShutdown(() => guideTerminals.dispose());
  host.registerMcpTools(
    createReviewGatewayTools({
      listOpenProjectRoots: () => openProjectRoots(host),
      homeDir: () => (0, import_os2.homedir)(),
      emitBriefRunEvent: (event) => {
        recordGuideRunEvent(event);
        if (event.phase === "done") guideTerminals.clearReapExempt(event.workspaceId);
        host.emit(BRIEF_RUN_EVENT_TOPIC, event);
      }
    })
  );
  registerReviewIpc(host, {
    changeSetService,
    guideTerminals,
    // Posting a review is human-outward; allow it only when the invocation
    // resolves to a real application window. The guide runs in a terminal with
    // no renderer, so it can never satisfy this (or reach an IPC handler). The
    // SDK types the raw event `unknown` to stay Electron-free, so the cast to
    // Electron's own event type happens here, at the one edge that needs it.
    isUserWindowSender: (event) => import_electron.BrowserWindow.fromWebContents(event.sender) !== null
  });
  host.registerSkills([
    {
      id: REVIEW_GUIDE_SKILL_ID,
      sourceDir: "skills/review-guide",
      targetPolicy: "all-native",
      description: "Build the walkthrough a human reviewer reads before reviewing a code change, and answer their questions about that change. Use when a terminal is started as the Review guide for a review, when asked to prepare or refresh a review walkthrough, or when a reviewer asks a question about the change under review."
    },
    {
      id: STUDIO_REVIEW_SKILL_ID,
      sourceDir: "skills/studio-review",
      targetPolicy: "all-native",
      description: "Read and write SprintEngine Studio code reviews through the review_* tools - list pending reviews, read a review's change set, read the current walkthrough, and submit a new one. Use when a terminal is started as the Review guide for a review, when asked to prepare, refresh or re-run a review walkthrough or brief, when asked which reviews are waiting, or when a reviewer asks a question about the change under review."
    }
  ]);
  host.onStartup(async () => {
    for (const root of await openProjectRoots(host)) {
      try {
        const result = await host.ensureSkillInstalled(root, STUDIO_REVIEW_SKILL_ID);
        if (!result.ok) {
          console.warn(`[review] ${STUDIO_REVIEW_SKILL_ID} not installed in ${root}: ${result.status}`);
        }
      } catch (error) {
        console.warn(`[review] ${STUDIO_REVIEW_SKILL_ID} install failed in ${root}:`, error);
      }
    }
  });
};
async function openProjectRoots(host) {
  try {
    const workspaces = await host.requireService(WorkspaceContextToken).list();
    return workspaces.map((workspace) => workspace.folderPath).filter((folderPath) => typeof folderPath === "string" && folderPath.length > 0);
  } catch (error) {
    console.warn("[review] could not read the open workspaces:", error);
    return [];
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  registerMain
});
