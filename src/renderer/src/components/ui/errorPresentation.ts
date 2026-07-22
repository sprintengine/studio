// Shared humanized-error presentation (T13 / backlog 1732). Maps a structural
// failure class to a plain sentence + suggested action, so every surface shows
// the same "one error card" instead of a raw ENOENT / HTTP body / zod dump
// behind a human prefix. Pure and React-free so it unit-tests as a node module
// and can be consumed from any renderer surface (trackers, review, roadmap,
// door surfaces). The raw technical string is the CALLER's `detail`, rendered
// only behind InlineNotice's "Show details" disclosure — never inline.

// The structural failure classes a surface can distinguish. Domain adapters
// (e.g. presentTrackerError) map their own error kinds onto these.
export type FailureClass =
  | 'auth' // credential rejected or expired (401/403)
  | 'rate_limit' // throttled (429)
  | 'network' // unreachable / timeout
  | 'not_found' // the target no longer exists (404)
  | 'validation' // the input or configuration is incomplete/invalid
  | 'permission' // authenticated but not allowed
  | 'unknown' // anything we could not classify

export type PresentedError = {
  // The plain sentence: what happened, in the user's terms. No codes, no stack.
  title: string
  // What it means / the one next action. Kept to a single short clause.
  hint: string
}

export type PresentErrorOptions = {
  // The thing being acted on, folded into the sentence where grammar allows
  // ("Couldn't reach Jira."). Omit for a subject-free sentence.
  subject?: string
  // Seconds until a throttled retry is worth trying, when the failure reports it.
  retryAfterSeconds?: number
}

// Maps a failure class to the plain sentence + suggested action every surface
// renders through the shared error card. Every branch pairs the failure with a
// concrete next step — never a dead end.
export function presentError(failure: FailureClass, options: PresentErrorOptions = {}): PresentedError {
  const { subject, retryAfterSeconds } = options
  switch (failure) {
    case 'auth':
      return {
        title: 'That didn’t sign in.',
        hint: 'The credentials were refused — reconnect, then try again.',
      }
    case 'rate_limit':
      return {
        title: 'Too many requests just now.',
        hint:
          typeof retryAfterSeconds === 'number' && retryAfterSeconds > 0
            ? `Wait ${retryAfterSeconds} seconds, then try again.`
            : 'Wait a moment, then try again.',
      }
    case 'network':
      return {
        title: subject ? `Couldn’t reach ${subject}.` : 'Couldn’t connect.',
        hint: 'Check your internet connection, then try again.',
      }
    case 'not_found':
      return {
        title: subject ? `${subject} couldn’t be found.` : 'That couldn’t be found.',
        hint: 'It may have been moved or deleted. Refresh to see the latest.',
      }
    case 'validation':
      return {
        title: 'Some details need fixing.',
        hint: 'Check the highlighted fields, then try again.',
      }
    case 'permission':
      return {
        title: 'You don’t have permission for this.',
        hint: 'Ask an admin for access, or switch to an account that has it.',
      }
    case 'unknown':
    default:
      return {
        title: 'Something went wrong.',
        hint: 'Try again. If it keeps happening, open Show details below.',
      }
  }
}
