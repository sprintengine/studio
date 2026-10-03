// The images a user attaches to a turn, as a projection carries them.

// An image the user attached to a turn, carried live to a vision-capable
// provider as a base64 content block. `dataBase64` is the raw base64 payload
// (no data: URI prefix); `mediaType` is the image MIME type. The bytes never
// enter the JSONL transcript: the server copies them into its attachment store
// and the `user_message` event records a `ConversationStoredImageAttachment`
// for each, which a replayed bubble reads back by reference.
export type ConversationImageAttachment = {
  id: string
  mediaType: string
  dataBase64: string
  name?: string
  byteLength: number
}

// An attached image as the transcript remembers it. `ref` is relative to the
// attachment store (`<conversation>/<file>`), never a filesystem path: the only
// way to its bytes is through the server, which resolves it inside that store
// and nowhere else.
export type ConversationStoredImageAttachment = {
  id: string
  mediaType: string
  name?: string
  byteLength: number
  ref: string
}
