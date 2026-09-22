/**
 * ===========================================================================
 * WHAT A DOCUMENT SAYS, BEFORE ANYONE ASKS WHAT IT MEANS.
 * ===========================================================================
 *
 * THE SEAM THIS OCCUPIES. A PDF reaches this product as two things: page text
 * (`readPdfPageTexts`) and positioned runs (`readPdfTextLayout`). Both are
 * turned into `BrochureUnit`s — a string, an x, a row — and everything after
 * that point reads units: the brochure reader, the schedule reconstructor, the
 * cover election. THIS module is the only thing between the two, and it is
 * where a document's TYPOGRAPHY stops being the reader's problem.
 *
 * WHY IT HAS TO EXIST AT ALL. `Lot 37 - Miami 190 - Property Package.pdf` is
 * typeset with tracked-out headings, so extraction returns
 *
 *     "L O T"   "3 7"   "E S T A T E"   "B E D"   "B A T H"   "G A R A G E"
 *     "T O T A L"   "H O M E"
 *
 * and not one of them matches a vocabulary entry. The tempting repair is a
 * rule per field — recognise `B E D`, recognise `B A T H`, recognise
 * `T O T A L  H O M E` — and it is the wrong repair twice over: it is five
 * copies of one idea, and every one of them is a rule about a document rather
 * than about documents. Letter-spacing is a property of the TYPE, so it is
 * resolved once, here, before any reader is asked a question.
 *
 * THE RAW EVIDENCE IS NEVER DESTROYED. A normalised unit carries `raw` — the
 * text as the page drew it — beside `text`, and says which rule transformed it
 * and from what. A reader that wants the literal string still has it, a
 * refusal can quote what was actually on the page, and nothing downstream has
 * to trust this module to have been right.
 *
 * AND IT DECIDES NOTHING ABOUT FIELDS. `BED` is a phrase, not a bedroom count;
 * `LAND` beside `$547,407` is a phrase beside a currency amount, and whether
 * that may become a land size is a question for `fieldTypes.pure.ts`, which
 * answers no. Normalisation makes a document legible. It does not make it
 * mean anything.
 */

/** A unit as the extractor produced it, before any normalisation. */
export interface RawUnit {
  text: string;
  x: number;
  row: number;
  /** The drawn width, where the extractor supplied one. 0 means unknown. */
  width?: number;
  /** The drawn type size, where the extractor supplied one. 0 means unknown. */
  height?: number;
}

/**
 * WHICH RULE FIRED, AND — FOR THE TRACKED-OUT ONES — ON WHAT.
 *
 * A word and a number are separated deliberately. `L O T` is display type: a
 * designer tracks out a HEADING, never a value, so the word it collapses to is
 * a label candidate and must never be written into a field. `3 7` is the value
 * under that heading, tracked out by the same treatment because it sits in the
 * same display line, and it IS the lot number. One rule name cannot say both,
 * and the claim gate has to be able to tell them apart — see
 * `trackedOutHeadings`.
 */
export type NormalisationRule =
  | 'field_separator'
  | 'letter_spaced_word'
  | 'letter_spaced_number'
  | 'letter_spaced_phrase';

/** What a normalisation did, kept so a reader never has to believe it. */
export interface NormalisationProvenance {
  /** Which rule fired. A fixed vocabulary; never a document's own words. */
  rule: NormalisationRule;
  /** The units it was derived from, verbatim. */
  sources: string[];
}

export interface NormalisedUnit {
  /** The canonical reading. What every downstream reader consumes. */
  text: string;
  /** The page's own string, unchanged. Equal to `text` where nothing fired. */
  raw: string;
  x: number;
  row: number;
  width?: number;
  height?: number;
  /** Absent where the unit was taken exactly as drawn. */
  normalisation?: NormalisationProvenance;
}

/**
 * A MIDDLE DOT BETWEEN TWO FIELDS IS A SEPARATOR, NOT A WORD.
 *
 * Measured on the same document: it is dot-delimited throughout, and read as
 * whole lines none of its runs matches anything —
 *
 *     Miami 190 · Spectral
 *     Sandpiper · Tweed Heads NSW
 *     190.38 m² · 4 bed · 2 bath · double garage
 *
 * Split on the dot, every segment is an ordinary statement.
 *
 * ONLY WHERE IT SEPARATES: whitespace on BOTH sides, so a decimal and
 * `1300·555·020` are untouched, and an empty segment is dropped rather than
 * becoming a unit. The bullet `•` is deliberately excluded — it opens a list
 * item rather than separating two fields, and every inclusions list is full of
 * them.
 */
const FIELD_SEPARATOR = /\s+[·–—]\s+/;

/**
 * AND A SPACED HYPHEN, BUT ONLY ON A LINE THAT CARRIES NO LABEL.
 *
 * `LOT 88 - HARLOW 21` is a lot and a design — one of the commonest headings a
 * builder writes, and the shape a scanned cover produced that this reader left
 * entirely unaccounted. `Package Price - $712,000` is the same punctuation
 * doing the same job.
 *
 * But `Design: ENZO 10.5 - MODERN` is ONE value with a hyphen in it, and
 * splitting it makes the design `ENZO 10.5`. A pinned spec already says so.
 *
 * WHAT TELLS THEM APART IS PUNCTUATION, NOT VOCABULARY, which is the only kind
 * of thing this layer is allowed to know. A colon means the line has already
 * named its field and everything after it is that field's value — so the value
 * is not cut. A line with no colon has named nothing, so a spaced hyphen on it
 * is separating two statements rather than sitting inside one.
 *
 * The hyphen must have whitespace on BOTH sides, so `266-268`, `Land-Size` and
 * a hyphenated street name are untouched — the same guard the middle dot
 * answers to.
 */
const DASH_SEPARATOR = /\s+-\s+/;

export function splitOnFieldSeparators(text: string): string[] {
  const source = String(text ?? '');
  const parts = source.split(FIELD_SEPARATOR);
  const out = source.includes(':')
    ? parts
    : parts.flatMap((part) => part.split(DASH_SEPARATOR));
  return out.map((part) => part.trim()).filter(Boolean);
}

/**
 * How many single characters make a run TRACKED OUT rather than a coincidence.
 *
 * Three. `U 3` is two tokens and a unit designation; `4 / 2` carries a token
 * that is not a single letter or digit; `A B` is two. At three the shape stops
 * being something a page produces by accident — and the joined result still
 * has to match a vocabulary entry downstream before it means anything, so the
 * cost of a false join is a phrase nobody asks for rather than a wrong field.
 */
const MIN_TRACKED_TOKENS = 3;

/** Is every token of this text a single letter, or every token a single digit? */
function trackedOutTokens(
  text: string,
  floor: number = MIN_TRACKED_TOKENS,
): { tokens: string[]; letters: boolean } | null {
  const tokens = String(text ?? '').trim().split(/ +/).filter(Boolean);
  if (tokens.length < floor) return null;
  if (!tokens.every((t) => t.length === 1)) return null;
  const letters = tokens.every((t) => /\p{L}/u.test(t));
  const digits = tokens.every((t) => /\p{N}/u.test(t));
  // Uniform class only. `L O T 3 7` as one run is two statements, and joining
  // it would invent the word `LOT37` the page never drew.
  if (!letters && !digits) return null;
  return { tokens, letters };
}

/**
 * THE WORD GAP INSIDE A TRACKED-OUT PHRASE IS THE ONLY THING THAT SEPARATES
 * `TOTAL HOME` FROM `TOTALHOME`.
 *
 * A designer tracking out a heading sets the gap BETWEEN its words wider than
 * the gap between its letters, and a text layer preserves that as a run of
 * spaces. Collapsing whitespace before looking — which every other reader in
 * this file does, correctly, for ordinary prose — destroys the one piece of
 * evidence that says where the words are, and `T O T A L  H O M E` becomes a
 * word no vocabulary has.
 *
 * So the segments are split on the WIDER gap first and collapsed separately.
 * Two spaces is the floor because that is what one extra space is; where the
 * page supplies positions instead of spaces, `joinsAsPhrase` measures the same
 * thing geometrically and this never has to fire.
 */
const TRACKED_WORD_GAP = / {2,}/;

/**
 * ===========================================================================
 * A TRACKED-OUT RUN HAS TO CONTAIN A WORD. DIGITS ALONE ARE COLUMNS.
 * ===========================================================================
 *
 * This is the rule that keeps "recognise letter-spaced type" from meaning
 * "join every sequence of characters", and it was written because the first
 * version did mean that. Every brochure in this corpus draws
 *
 *     3 2 1
 *
 * under its design name — the bed, bath and car icons, three values in three
 * columns — and a rule that collapsed any run of three single characters read
 * it as the number `321`. Three bedroom counts became one meaningless figure,
 * on four fixtures, and the suite caught it on the first run.
 *
 * Letter-spacing is DISPLAY TYPOGRAPHY: it is applied to words. So the run
 * must carry one, and a run of bare digits is left exactly as the page drew
 * it. `L O T  3 7` still reads, because its first segment is a word and that
 * is the evidence the whole line is set that way; `3 7` on its own does not,
 * and reaches the same reading through `joinsAdjacentNumber` below, where the
 * heading beside it supplies the proof instead.
 */
export function collapseTrackedRun(text: string): { text: string } | null {
  const source = String(text ?? '').replace(/[^\S ]+/g, ' ').trim();
  if (!source) return null;
  const segments = source.split(TRACKED_WORD_GAP).filter(Boolean);
  /*
   * Every segment must be tracked out, or the run is ordinary text that
   * happens to contain one — `Set out  A B C  below` is a sentence. And at
   * least one of them must be a WORD, which is the rule above.
   *
   * The floor is lower for the segments AFTER that word, and for the same
   * reason `joinsAdjacentNumber` exists: `L O T  3 7` is one display line, the
   * word proves it is set that way, and demanding three characters of its
   * value would refuse the very field the heading introduces. Nothing is
   * relaxed for a run with no word in it, which is where the icon row lives.
   */
  const runs = segments.map((segment) => trackedOutTokens(segment, 2));
  if (runs.some((run) => run === null)) return null;
  const words = runs as Array<{ tokens: string[]; letters: boolean }>;
  if (!words.some((run) => run.letters && run.tokens.length >= MIN_TRACKED_TOKENS)) {
    return null;
  }
  return { text: words.map((run) => run.tokens.join('')).join(' ') };
}

/**
 * How few characters make a tracked-out NUMBER, once a word has vouched for it.
 *
 * Two, where `collapseTrackedRun` demands three. The floor exists to keep an
 * accident from reading as display type, and a heading drawn immediately
 * beside the run has already ruled the accident out — so `L O T` over `3 7`
 * reads, and the icon row, which has no heading beside it, still does not.
 */
const MIN_TRACKED_DIGITS = 2;

/** Is this run bare tracked-out digits — a value, if something vouches for it? */
function trackedOutNumber(text: string): string | null {
  const source = String(text ?? '').replace(/[^\S ]+/g, ' ').trim();
  if (!source || TRACKED_WORD_GAP.test(source)) return null;
  const tokens = source.split(/ +/).filter(Boolean);
  if (tokens.length < MIN_TRACKED_DIGITS) return null;
  if (!tokens.every((t) => t.length === 1 && /\p{N}/u.test(t))) return null;
  return tokens.join('');
}

/** Is this run tracked-out type? Exported because two rules ask. */
export function isTrackedOut(text: string): boolean {
  return collapseTrackedRun(text) !== null;
}

/**
 * HOW FAR APART TWO TRACKED-OUT RUNS MAY SIT AND STILL BE ONE PHRASE.
 *
 * `T O T A L` and `H O M E` are one heading; `T O T A L` and `P A C K A G E`
 * from a different block are not, and neither is a tracked-out word at the
 * other end of the page. Where the extractor gives widths, the gap is measured
 * against the run's own set width — a phrase's inter-word gap is of the order
 * of its letter gaps, never a column away. Where it does not, adjacency in
 * reading order on one row is all that is claimed, which is the same standard
 * `unitBeside` already reads a value by.
 */
const PHRASE_GAP_RATIO = 0.6;

function joinsAsPhrase(left: NormalisedUnit, right: NormalisedUnit): boolean {
  if (left.row !== right.row) return false;
  const width = Number(left.width ?? 0);
  if (!(width > 0)) return true;
  const gap = Number(right.x) - (Number(left.x) + width);
  if (!Number.isFinite(gap)) return true;
  return gap >= 0 && gap <= width * PHRASE_GAP_RATIO;
}

/**
 * ===========================================================================
 * A TRACKED HEADING REACHES THIS LAYER AS ONE CELL PER GLYPH.
 * ===========================================================================
 *
 * MEASURED 22 SEPTEMBER 2026 by building a brochure with real PDF character
 * spacing and reading the bytes back through this product's own extractor.
 * The two transports disagree about what a tracked-out heading even IS:
 *
 *   FLATTENED PAGE TEXT gives one string, `M A S T E R P L A N`, because the
 *   extractor inserts a space wherever the glyphs did not abut. That is the
 *   shape the production Lot 37 row recorded, and it is what
 *   `collapseTrackedRun` reads.
 *
 *   POSITIONED RUNS give TEN CELLS — `M` at x=57, `A` at x=80, `S` at 101 —
 *   because the cell assembler joins runs that abut and these do not, by
 *   design. `collapseTrackedRun` never sees a string to collapse; there is no
 *   unit longer than one character to look at.
 *
 * So the geometry has to be read directly, and it says so plainly. On that
 * page the inter-glyph gap is 12.0 units, EVERY TIME, against a mean glyph
 * advance of 8.7 — and the gap between `T O T A L` and `P A C K A G E` is
 * 26.0. Regular, bounded, and a word break that is twice the letter gap. That
 * is what tracking is, and it is not what anything else looks like.
 *
 * FOUR CONDITIONS, ALL REQUIRED, and each is the page's own evidence:
 *
 *   1 · ONE BASELINE. Cells are already grouped by row, and a run may not
 *       leave it.
 *   2 · SINGLE GLYPHS. A cell of two or more characters is a word the
 *       assembler already joined, and joining words is not this rule's
 *       business.
 *   3 · BOUNDED. Each gap is measured against the run's own glyph advance, so
 *       nothing here is a fixed number of points that a 9pt caption and a 40pt
 *       cover title would both have to satisfy. A column is not a letter gap
 *       at any size.
 *   4 · REGULAR. The letter gaps must agree with each other. This is the
 *       condition that makes the rule safe: three single-letter cells at
 *       column positions are three columns, and their gaps do not agree.
 *
 * AND AT LEAST ONE LETTER, for the reason `collapseTrackedRun` states —
 * letter-spacing is applied to words, and `3 2 1` is an icon row.
 */

/** A gap this much of the run's glyph advance or less is between LETTERS. */
const GLYPH_GAP_RATIO = 2.0;
/** And this much or less is between WORDS of one tracked phrase. */
const GLYPH_WORD_GAP_RATIO = 4.0;
/** How far a letter gap may differ from the run's own median and still agree. */
const GLYPH_GAP_TOLERANCE = 0.5;

const advanceOf = (unit: RawUnit): number => {
  const width = Number(unit.width ?? 0);
  return Number.isFinite(width) && width > 0 ? width : 0;
};

/**
 * Consecutive single-glyph cells on one row, as one tracked run — or null.
 *
 * Returns the text the page drew (glyphs separated by single spaces, words by
 * two, which is the shape `collapseTrackedRun` then reads) so that ONE rule
 * decides what a tracked run means whichever transport produced it.
 */
function glyphRunText(units: readonly RawUnit[]): string | null {
  if (units.length < MIN_TRACKED_TOKENS) return null;
  if (!units.every((u) => String(u.text ?? '').trim().length === 1)) return null;
  /*
   * A RUN BREAKS AT ANYTHING THAT IS NOT A LETTER OR A DIGIT.
   *
   * The same page draws `L A N D  +  B U I L D`, and the `+` is a glyph of the
   * display line rather than a letter of either word. Folding the lot together
   * gives `LAND + BUILD`, which is a phrase no vocabulary has, and loses the
   * two labels the document actually wrote. Broken at the sign it yields
   * `LAND`, `+`, `BUILD` — three units, two of which are labels — and the
   * phrase rule then declines to join them across it, which is right: they are
   * two fields, not one heading.
   */
  if (!units.every((u) => /[\p{L}\p{N}]/u.test(String(u.text)))) return null;
  if (!units.some((u) => /\p{L}/u.test(String(u.text)))) return null;

  const advances = units.map(advanceOf);
  if (!advances.every((a) => a > 0)) return null;
  const advance = advances.reduce((sum, a) => sum + a, 0) / advances.length;

  const gaps: number[] = [];
  for (let i = 1; i < units.length; i++) {
    const gap = Number(units[i].x) - (Number(units[i - 1].x) + advances[i - 1]);
    if (!Number.isFinite(gap) || gap < 0) return null;
    if (gap > advance * GLYPH_WORD_GAP_RATIO) return null;
    gaps.push(gap);
  }

  const letterGaps = gaps.filter((gap) => gap <= advance * GLYPH_GAP_RATIO);
  if (letterGaps.length < MIN_TRACKED_TOKENS - 1) return null;
  const sorted = [...letterGaps].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  // A tracked run's letter gaps are one gap, repeated. Where they disagree,
  // the cells are columns that happen to hold one character each.
  if (!letterGaps.every((gap) => Math.abs(gap - median) <= Math.max(
    median * GLYPH_GAP_TOLERANCE, 1))) return null;

  let out = String(units[0].text).trim();
  for (let i = 1; i < units.length; i++) {
    out += gaps[i - 1] <= advance * GLYPH_GAP_RATIO ? ' ' : '  ';
    out += String(units[i].text).trim();
  }
  return out;
}

/**
 * Fold every tracked glyph run on the page back into the run the page drew.
 *
 * Longest first at each position, because a shorter prefix of a tracked run is
 * also a tracked run and taking it would break the phrase in half.
 */
function foldGlyphRuns(units: readonly RawUnit[]): RawUnit[] {
  const out: RawUnit[] = [];
  let i = 0;
  while (i < units.length) {
    let taken: { text: string; end: number } | null = null;
    for (let end = units.length; end > i + MIN_TRACKED_TOKENS - 1; end--) {
      if (units[end - 1].row !== units[i].row) continue;
      const slice = units.slice(i, end);
      if (slice.some((u) => u.row !== units[i].row)) continue;
      const text = glyphRunText(slice);
      if (text) { taken = { text, end }; break; }
    }
    if (!taken) { out.push(units[i]); i += 1; continue; }
    const last = units[taken.end - 1];
    out.push({
      text: taken.text,
      x: units[i].x,
      row: units[i].row,
      width: Math.max(0, Number(last.x) + advanceOf(last) - Number(units[i].x)),
      height: units[i].height,
    });
    i = taken.end;
  }
  return out;
}

/**
 * The one entry point. Raw units in, canonical units out.
 *
 * Order matters and is not arbitrary. Separators are split FIRST, because a
 * run may carry both (`Miami 190 · Spectral`); tracked runs are collapsed
 * second, so a phrase is assembled from words rather than from letters; and
 * phrases are joined last, over units that are already words.
 */
export function normaliseUnits(input: readonly RawUnit[]): NormalisedUnit[] {
  // 0 · glyph runs, where the transport gave glyphs rather than strings
  const units = foldGlyphRuns(input);

  // 1 · separators
  //
  // Whitespace is NOT collapsed here. A run of spaces is the word gap inside a
  // tracked-out heading and the only evidence of where its words are; step 2
  // reads it, and anything step 2 leaves alone is tidied there instead.
  const split: NormalisedUnit[] = [];
  for (const unit of units) {
    const raw = String(unit.text ?? '').replace(/[^\S ]+/g, ' ').trim();
    if (!raw) continue;
    const parts = splitOnFieldSeparators(raw);
    if (parts.length <= 1) {
      split.push({ text: raw, raw, x: unit.x, row: unit.row,
                   width: unit.width, height: unit.height });
      continue;
    }
    for (const part of parts) {
      split.push({
        text: part, raw, x: unit.x, row: unit.row,
        width: unit.width, height: unit.height,
        normalisation: { rule: 'field_separator', sources: [raw] },
      });
    }
  }

  // 2 · tracked-out runs
  const collapsed: NormalisedUnit[] = split.map((unit) => {
    const joined = collapseTrackedRun(unit.text);
    if (!joined) {
      const tidied = unit.text.replace(/ +/g, ' ').trim();
      return tidied === unit.text ? unit : { ...unit, text: tidied };
    }
    return {
      ...unit,
      text: joined.text,
      normalisation: { rule: 'letter_spaced_word', sources: [unit.text] },
    };
  });

  // 3 · tracked-out phrases
  const out: NormalisedUnit[] = [];
  for (const unit of collapsed) {
    const previous = out[out.length - 1];
    const joinable = (u: NormalisedUnit | undefined) =>
      u?.normalisation?.rule === 'letter_spaced_word'
      || u?.normalisation?.rule === 'letter_spaced_phrase';
    if (previous && joinable(previous) && joinable(unit)
      && joinsAsPhrase(previous, unit)) {
      const sources = [...(previous.normalisation?.sources ?? []),
                       ...(unit.normalisation?.sources ?? [])];
      out[out.length - 1] = {
        ...previous,
        text: `${previous.text} ${unit.text}`,
        raw: previous.raw === unit.raw ? previous.raw : `${previous.raw} ${unit.raw}`,
        width: Number(previous.width ?? 0) + Number(unit.width ?? 0),
        normalisation: { rule: 'letter_spaced_phrase', sources },
      };
      continue;
    }
    out.push(unit);
  }

  /*
   * 4 · THE VALUE UNDER THE HEADING.
   *
   * `L O T` and `3 7` are one display line and the page draws them as two
   * runs. The word is what proves the line is tracked out; the digits beside
   * it are the value it introduces. So a bare digit run is read only where a
   * collapsed word sits beside it on the same row, within the same gap the
   * phrase rule measures — which is why the icon row, drawn under a design
   * name and beside nothing, is left alone.
   *
   * The digits stay their OWN unit. Joining them into the phrase would make
   * `LOT 37` where the document said a heading and a value, and the pairing
   * readers downstream exist precisely to keep those two apart.
   */
  for (let i = 0; i < out.length; i++) {
    if (out[i].normalisation) continue;
    const digits = trackedOutNumber(out[i].text);
    if (!digits) continue;
    const before = out[i - 1];
    const after = out[i + 1];
    const vouches = (u: NormalisedUnit | undefined) =>
      !!u && (u.normalisation?.rule === 'letter_spaced_word'
        || u.normalisation?.rule === 'letter_spaced_phrase');
    const proved = (vouches(before) && joinsAsPhrase(before, out[i]))
      || (vouches(after) && joinsAsPhrase(out[i], after));
    if (!proved) continue;
    out[i] = {
      ...out[i],
      text: digits,
      normalisation: { rule: 'letter_spaced_number', sources: [out[i].text] },
    };
  }
  return out;
}

/**
 * ===========================================================================
 * A WORD A DESIGNER TRACKED OUT IS A HEADING. IT IS NEVER A VALUE.
 * ===========================================================================
 *
 * Letter-spacing is display typography: it is applied to `E S T A T E`,
 * `B E D`, `M A S T E R P L A N` — the words that LABEL things — and never to
 * the estate's name, the bedroom count or the price. That asymmetry is what
 * makes normalising it safe, and it is also the guarantee that has to survive
 * normalising it.
 *
 * MEASURED 21 SEPTEMBER 2026 on `Lot 37 - Miami 190 - Property Package.pdf`:
 * the record carried `development_name = M A S T E R P L A N` beside
 * `development_name = PROPLAUNCH`, a page heading offered as the estate. The
 * old guard refused any letter-spaced VALUE, which worked precisely because
 * nothing had made it legible. Once it collapses to `MASTERPLAN` that guard
 * can no longer see it — so the fact travels instead: this document set these
 * words as display type, therefore they are its headings, therefore no field
 * may hold one.
 *
 * NUMBERS ARE DELIBERATELY EXCLUDED. `3 7` is tracked out by the same
 * treatment because it sits in the same display line, and it is the lot
 * number — the value the heading above it labels. A rule that refused it would
 * refuse the one field the heading exists to introduce.
 */
export function trackedOutHeadings(units: readonly NormalisedUnit[]): Set<string> {
  const headings = new Set<string>();
  const add = (value: string | null | undefined) => {
    const text = String(value ?? '').replace(/\s+/g, ' ').trim().toUpperCase();
    if (text) headings.add(text);
  };
  for (const unit of units) {
    const rule = unit.normalisation?.rule;
    if (rule !== 'letter_spaced_word' && rule !== 'letter_spaced_phrase') continue;
    add(unit.text);
    /*
     * ====================================================================
     * A PHRASE'S OWN WORDS ARE HEADINGS TOO, AND THAT COST A PRODUCTION ROW.
     * ====================================================================
     *
     * MEASURED 22 SEPTEMBER 2026 on the deployed reader, from the import
     * log rather than from reading the code: `development_name:
     * leading_field_name` on `Lot 37 - Miami 190 - Property Package.pdf`,
     * with the estate written onto the builder's card as `MASTERPLAN`.
     *
     * The page sets `E S T A T E` and `M A S T E R P L A N` side by side.
     * Joining them is RIGHT — that is how the page reads, and it is what
     * makes `ESTATE` legible as a label at all. `readLeadingFieldName` then
     * does exactly its job: a line opening with a field name, the rest its
     * value. So the claim was `development_name = MASTERPLAN`, and the guard
     * held only the phrase `ESTATE MASTERPLAN` and did not recognise it.
     *
     * One join and one split, each correct, and the display type came out
     * the other side as a value. So every word the page set as display type
     * is recorded, not only the phrase they were assembled into: a reader
     * may legitimately take a phrase apart, and what it hands back is still
     * type a designer tracked out.
     */
    const spellings = [unit.text];
    for (const source of unit.normalisation?.sources ?? []) {
      spellings.push(collapseTrackedRun(source)?.text ?? source);
    }
    /*
     * The WORDS, not only the sources, because the two transports assemble the
     * same phrase differently. Positioned runs give `E S T A T E` and
     * `M A S T E R P L A N` as two units the phrase rule joins, so the sources
     * carry both words; flattened page text gives ONE string with the wider
     * word gap inside it, so the single source IS the phrase and collapsing it
     * hands back exactly what was already recorded. Reading the words off the
     * result covers both, and every word of a tracked phrase is display type
     * by construction.
     */
    for (const spelling of spellings) {
      for (const word of spelling.split(/\s+/)) add(word);
    }
  }
  return headings;
}
