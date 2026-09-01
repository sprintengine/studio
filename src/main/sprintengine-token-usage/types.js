export function emptyModelUsage(model) {
    return { model, input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 0, split: true };
}
// Coerce an unknown JSON value to a non-negative finite token count.
export function tokenCount(value) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}
// Derive each split row's total from its components so a row is never handed
// out half-built. Adapters call this on their return value; total-only rows
// (split:false, e.g. Grok) pass through with their explicit total.
//
// Cache READS are deliberately outside the total. Every API turn re-reads the
// whole accumulated context, so a session at a 300k context adds 300k of cache
// reads per turn: summing them counts the same tokens once per turn and the
// headline lands in the hundreds of millions for a run that processed single
// -digit millions. Reads stay on the report as their own figure (they are real,
// and they are billed, at a fraction of the input price) — they are just not
// what "tokens this run used" means. `total` is each token counted once: new
// input, tokens written to the cache, and output.
export function totalFromComponents(row) {
    return row.input + row.output + row.cacheCreation;
}
export function withDerivedTotals(rows) {
    return rows.map((row) => (row.split ? { ...row, total: totalFromComponents(row) } : row));
}
