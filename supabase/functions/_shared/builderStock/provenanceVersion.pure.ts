/**
 * BUILDER STOCK — THE EXTRACTOR VERSION, AND NOTHING ELSE.
 *
 * WHY IT IS ITS OWN MODULE. This number is compared by
 * `negativeProvenanceStillStands`, by `branchTerminal`, by the fallback gate in
 * `settleFallbackImages` and by the settler — and it used to live in
 * `sourceImages.ts`, beside the code that writes image rows. Reading a
 * CONSTANT therefore pulled in the writer, its hashing, its eligibility
 * assessment and everything those reach for, which is how a cheap guard
 * acquires an expensive import and how a pure test acquires a runtime.
 *
 * `sourceImages.ts` re-exports it, so every existing import still resolves and
 * there is still exactly one definition. The prose explaining what each
 * version CHANGED stays there, next to the reader whose capability it
 * describes.
 */

/** See `sourceImages.ts` for what each version changed and why. */
export const PROVENANCE_VERSION = 24;
