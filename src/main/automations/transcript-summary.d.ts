/**
 * Derive an automation run summary from a Claude Code JSONL transcript: the text
 * of the agent's last assistant message.
 *
 * The transcript path arrives from an agent-state hook reporter and is therefore
 * UNTRUSTED. This module is the containment boundary: it accepts only an
 * absolute `.jsonl` path to a regular file within {@link MAX_TRANSCRIPT_BYTES},
 * streams it row by row, and never throws — every rejection returns `undefined`
 * so a missing, hostile, or unreadable transcript degrades to the caller's
 * generic summary instead of failing a run finalize.
 *
 * Pure and engine-free by contract (no import of engine.ts).
 */
/**
 * Size cap applied before reading. This is an abuse guard, not a working limit:
 * real transcripts get big (a long local session measured 83MB / 1,420 rows, and
 * streamed in 167ms), so a tight cap would silently drop the summary for exactly
 * the long runs that most need one. Set well above observed sizes; past it the
 * file is treated as not-a-transcript rather than streamed.
 */
export declare const MAX_TRANSCRIPT_BYTES: number;
/** Summary length cap. Longer text is truncated with an ellipsis. */
export declare const MAX_TRANSCRIPT_SUMMARY_LENGTH = 500;
/**
 * Text of the last assistant message in the transcript at `transcriptPath`,
 * truncated to {@link MAX_TRANSCRIPT_SUMMARY_LENGTH}. Returns `undefined` when
 * the path is not an absolute `.jsonl` file, the file is missing, not a regular
 * file, over the size cap, unreadable, or carries no assistant text.
 */
export declare function readTranscriptSummary(transcriptPath: string): Promise<string | undefined>;
