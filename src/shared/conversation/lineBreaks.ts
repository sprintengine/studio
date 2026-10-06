/**
 * A message's line and paragraph separators as one plain line break.
 *
 * Text from a phone's recogniser, a keyboard's dictation or a paste can carry
 * U+2028, U+2029, U+0085 or a carriage return. `JSON.stringify` leaves U+2028
 * and U+2029 as they are, and a line reader in Node reads both as the end of
 * a line, so a message carrying one, written as a JSON line to an agent CLI,
 * arrives as pieces that are not JSON. A message goes to an agent with "\n"
 * and nothing else.
 */
export function plainLineBreaks(text: string): string {
  return text.replace(/\r\n?|[\u2028\u2029\u0085]/gu, '\n')
}
