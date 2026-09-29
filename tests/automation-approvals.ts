import {
  automationApprovalFingerprint,
  type AutomationApprovalGate,
  type AutomationApprovalLedger,
} from '../src/main/automations/approval-ledger'

// For suites about something other than approval: every definition reads as
// one this machine already said yes to, so the engine and webhook receiver
// behave exactly as they did before the approval gate existed. Lives here, not
// beside the ledger, so no production import can reach a gate that approves
// everything. The gate itself is covered by approval-ledger.test.ts and
// engine-approval.test.ts.
export const everyAutomationApproved: AutomationApprovalGate = {
  async check(_workspaceRoot, definition) {
    return {
      state: 'approved',
      fingerprint: automationApprovalFingerprint(definition),
      source: 'app',
      approvedAt: '2026-01-01T00:00:00.000Z',
    }
  },
}

// The same, as the full ledger a module or IPC surface takes, for suites that
// wire the automations module end to end. Recording is a no-op.
export const everyAutomationApprovedLedger: AutomationApprovalLedger = {
  ...everyAutomationApproved,
  async approve(_workspaceRoot, definition, source) {
    return {
      state: 'approved',
      fingerprint: automationApprovalFingerprint(definition),
      source,
      approvedAt: '2026-01-01T00:00:00.000Z',
    }
  },
  async revoke() {},
}
