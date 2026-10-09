// A markdown or HTML image: the reply draws it, so the prose carrying it is
// something to see. Its own module so the timeline and the folds both read it
// without importing each other; turnFolds is where it is exported from.
const PICTURE = /!\[[^\]]*\]\([^)\s]+[^)]*\)|<img\b/i

/** Prose between steps that puts a picture in front of the person. */
export function proseShownToUser(text: string): boolean {
  return PICTURE.test(text)
}
