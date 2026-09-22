// How long "New" lasts, in days, everywhere the app says it.
//
// Two surfaces wear the word: the model picker's chip on a model a probe on
// this machine first listed recently (cliRuntimeOptions.mergeModelCatalog), and
// the Design door's marker on a design-system entry that arrived since the
// person last looked (src/shared/design-system/new-entries.ts). They count from
// different events, but a person reads one word, so they must not be able to
// disagree about how long it lasts — and a second `30` typed out somewhere else
// is exactly how they would. Both import this constant; neither restates it.
export const NEW_FOR_DAYS = 30

export const NEW_FOR_MS = NEW_FOR_DAYS * 24 * 60 * 60 * 1000
