import { MobileSwarmCommandError } from './command-error'

const maxFollowUpCharacters = 2_000

export function normalizeFollowUpText(value: string): string {
  if (/[\u0000-\u001F\u007F]/u.test(value)) {
    throw new MobileSwarmCommandError('invalid_payload', 'Follow-up text must be a single message without terminal control characters.', false)
  }

  const text = value.trim()
  if (!text) {
    throw new MobileSwarmCommandError('invalid_payload', 'Follow-up text is required.', false)
  }
  if (text.length > maxFollowUpCharacters) {
    throw new MobileSwarmCommandError('invalid_payload', `Follow-up text must be ${maxFollowUpCharacters} characters or less.`, false)
  }
  return text
}
