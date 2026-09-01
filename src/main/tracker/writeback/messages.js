// Write-back comment bodies now live in the node-free shared module so the T11
// settings preview and this engine share ONE source of truth for the exact posted
// wording (MC-1640 / plan §3.7). Re-exported here to preserve the engine's and its
// tests' existing import path.
export { pullRequestComment, runCompletedComment, runStartedComment, WRITEBACK_SIGNATURE, } from '../../../shared/tracker/writeback-messages';
