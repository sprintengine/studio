import { useCallback, useEffect, useState } from 'react'
import type { ConversationApprovalRule } from '../../../../shared/conversation/approvalRules'
import { GhostButton, InlineNotice, SettingCard, SettingRow, Spinner } from '../ui'
import { SettingsSectionTitle } from './SettingsAtoms'

export function ConversationApprovalSettings() {
  const [rules, setRules] = useState<ConversationApprovalRule[]>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState<string>()
  const load = useCallback(async () => {
    try {
      setError(undefined)
      const result = await window.api.conversationApprovalRules()
      if (!result.ok) throw new Error(result.message)
      setRules(result.rules)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    }
  }, [])
  useEffect(() => {
    void load()
  }, [load])
  async function revoke(rule: ConversationApprovalRule) {
    setBusy(rule.id)
    try {
      const result = await window.api.conversationRevokeApprovalRule({ ruleId: rule.id })
      if (!result.ok) throw new Error(result.message)
      await load()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy(undefined)
    }
  }
  return (
    <section className="space-y-3 pt-2" aria-labelledby="conversation-permissions-title">
      <SettingsSectionTitle id="conversation-permissions-title" count={rules?.length}>
        Remembered chat permissions
      </SettingsSectionTitle>
      <p className="text-body text-[color:var(--sem-color-text-muted)]">
        Workspace grants apply only to the named tool and matcher. Removing one makes future requests ask again.
        Conversation-only grants expire when that chat session closes.
      </p>
      {error ? (
        <InlineNotice
          tone="error"
          action={
            <GhostButton size="inline" onClick={() => void load()}>
              Retry
            </GhostButton>
          }
        >
          {error}
        </InlineNotice>
      ) : !rules ? (
        <Spinner label="Loading chat permissions" />
      ) : rules.length ? (
        <SettingCard>
          {rules.map((rule) => (
            <SettingRow key={rule.id} label={rule.label} help={rule.workspaceRoot}>
              <GhostButton
                size="sm"
                aria-label={`Revoke ${rule.label}`}
                disabled={Boolean(busy)}
                onClick={() => void revoke(rule)}
              >
                {busy === rule.id ? 'Removing…' : 'Revoke'}
              </GhostButton>
            </SettingRow>
          ))}
        </SettingCard>
      ) : (
        <p className="text-body text-[color:var(--sem-color-text-muted)]">
          No workspace permissions have been remembered.
        </p>
      )}
    </section>
  )
}
