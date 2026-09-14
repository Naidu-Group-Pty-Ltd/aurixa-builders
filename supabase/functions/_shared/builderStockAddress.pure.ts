/**
 * Builder stock's address, taken out of the one free-text line that holds it.
 *
 * ## What the rows actually contain
 *
 * `builder_stock_items` has `address_line`, `suburb`, `state` and `postcode`
 * columns. Measured over the 124 distinct items live on 7 September 2026, the
 * structured columns are nearly empty and the free-text line is nearly
 * complete:
 *
 * | fact                          | structured column | inside `address_line` |
 * |-------------------------------|-------------------|-----------------------|
 * | postcode                      | 2                 | 93                    |
 * | suburb                        | 50                | ~all                  |
 *
 * The lines look like this, verbatim:
 *
 *     Lot 209 - 44 Satinwood Crescent Donnybrook VIC
 *     Lot 104 - Finch Road, Century Estate, Redbank Plains QLD 4301 [Dual Key 4+1]
 *     Lot 36 - Tringa Street, Sandpiper Estate, Tweed Heads South NSW 2486 [Stradbroke 180]
 *     Lot 2 - 13/15 Rose Street, Yamanto QLD 4305
 *
 * Every one of those was handed to the geocoder whole, with the lot prefix and
 * the design-name suffix still attached, which is why builder stock lands on
 * suburb centroids: `Lot 36 - Tringa Street, Sandpiper Estate, Tweed Heads
 * South NSW 2486 [Stradbroke 180]` is not a question Google can answer at
 * street level, and 16 Armstrong Creek lots therefore stack on one pin.
 *
 * ## Three rules
 *
 * **The bracketed suffix is a house design, not a place.** `[Stradbroke 180]`
 * and `[Dual Key 4+1]` name the building the builder would put on the lot. 52
 * of 124 rows carry one and every one of them pollutes the query.
 *
 * **A lot number is not a street number.** `Lot 209 - 44 Satinwood Crescent` is
 * lot 209 AND number 44; `Lot 104 - Finch Road` is lot 104 and no number at
 * all. Reading the lot as the street number would put lot 104 at 104 Finch
 * Road, which is a different property that may well exist. The lot is captured
 * separately and never promoted.
 *
 * **An estate name is kept and never geocoded.** `Century Estate` and
 * `Sandpiper Estate` are marketing names for land that often predates any
 * street directory entry, so they are the segment most likely to make a
 * provider give up and answer with the suburb. They are worth showing a reader
 * and worth withholding from the query.
 *
 * What this does NOT do is invent precision. A lot in an unregistered estate
 * has no street number, and after every rule here 68 of 124 rows still have a
 * street name and no number. That is the correct answer for them, and
 * `composeListingAddress` reports it as `street` rather than pretending.
 *
 * Pure: no Deno, no DOM, no network.
 */

import { composeListingAddress, type ComposedAddress } from './listingAddress.pure.ts';

const AU_STATE = /\b(NSW|VIC|QLD|WA|SA|TAS|ACT|NT)\b/i;

/**
 * Street types as the sources actually write them, longest first so `Crescent`
 * is tried before any prefix of it could match. The abbreviations matter: the
 * builder lists are typed by hand and mix both forms freely.
 */
const STREET_TYPES: Array<[RegExp, string]> = [
  [/\bboulevards?\b|\bbvd\b/i, 'Boulevard'],
  [/\bcrescents?\b|\bcres\b/i, 'Crescent'],
  [/\bcircuits?\b|\bcct\b/i, 'Circuit'],
  [/\besplanades?\b|\besp\b/i, 'Esplanade'],
  [/\bhighways?\b|\bhwy\b/i, 'Highway'],
  [/\bparades?\b|\bpde\b/i, 'Parade'],
  [/\bterraces?\b|\btce\b/i, 'Terrace'],
  [/\bavenues?\b|\bave\b/i, 'Avenue'],
  [/\bstreets?\b|\bst\b/i, 'Street'],
  [/\bcourts?\b|\bct\b/i, 'Court'],
  [/\bdrives?\b|\bdr\b/i, 'Drive'],
  [/\bplaces?\b|\bpl\b/i, 'Place'],
  [/\broads?\b|\brd\b/i, 'Road'],
  [/\bclose\b|\bcl\b/i, 'Close'],
  [/\blanes?\b|\bln\b/i, 'Lane'],
  [/\bgroves?\b|\bgr\b/i, 'Grove'],
  [/\brises?\b/i, 'Rise'],
  [/\bways?\b/i, 'Way'],
  [/\bmews\b/i, 'Mews'],
  [/\bwalks?\b/i, 'Walk'],
  [/\bcircles?\b/i, 'Circle'],
  [/\bpromenades?\b/i, 'Promenade'],
  // The rest of the Australian vocabulary. New estates favour these heavily —
  // `Magdala Ridge`, `Callistemon Approach`, `Partnership Way` — and a type
  // that is missing here is a street silently demoted to an estate name.
  [/\bapproach\b/i, 'Approach'],
  [/\bridge\b/i, 'Ridge'],
  [/\bgardens?\b|\bgdns?\b/i, 'Gardens'],
  [/\bgreen\b/i, 'Green'],
  [/\bgrange\b/i, 'Grange'],
  [/\bchase\b/i, 'Chase'],
  [/\bviews?\b/i, 'View'],
  [/\bvista\b/i, 'Vista'],
  [/\bloop\b/i, 'Loop'],
  [/\blink\b/i, 'Link'],
  [/\bglade\b/i, 'Glade'],
  [/\bbend\b/i, 'Bend'],
  [/\bretreat\b/i, 'Retreat'],
  [/\bheights\b|\bhts\b/i, 'Heights'],
  [/\bcrest\b/i, 'Crest'],
  [/\boutlook\b/i, 'Outlook'],
  [/\bentrance\b/i, 'Entrance'],
  [/\bsquare\b|\bsq\b/i, 'Square'],
  [/\bwynd\b/i, 'Wynd'],
  [/\bpocket\b/i, 'Pocket'],
  [/\bpassage\b/i, 'Passage'],
  [/\brun\b/i, 'Run'],
  [/\bbanks?\b/i, 'Bank'],
];

export interface ParsedBuilderAddress {
  /** The lot as written on the list. Never used as a street number. */
  lotNumber: string | null;
  unitNumber: string | null;
  streetNumber: string | null;
  streetName: string | null;
  streetType: string | null;
  suburb: string | null;
  state: string | null;
  postcode: string | null;
  /** `Sandpiper Estate` — shown to a reader, withheld from the geocoder. */
  estate: string | null;
  /** `Stradbroke 180` — the house design, never part of the address. */
  designName: string | null;
}

function tidy(value: string | null | undefined): string | null {
  const trimmed = String(value ?? '').trim().replace(/\s+/g, ' ').replace(/^[,\-–]+|[,\-–]+$/g, '');
  return trimmed.trim() || null;
}

/**
 * Everything a list writes AFTER the address, taken off before it is read.
 *
 * This was one square-bracketed group anchored to the very end of the line,
 * which is the shape the first stock lists used — `… NSW 2486 [Stradbroke
 * 180]`. A Notion list measured 10 September 2026 writes three other shapes,
 * and every one of them defeated the anchor, so the annotation stayed in the
 * line and became the suburb:
 *
 *   Lot 60913 Basalt St, Beveridge, VIC 3753 (178 m2)      suburb `3753 (178 m2)`
 *   Lot 60416 Russula St, Beveridge VIC 3753 (141 m2)      suburb `Beveridge 3753 (141 m2)`
 *   Lot 1482 - Coridale Estate, Lara 3212 VIC [178 m2] Aura 19
 *                                                          suburb `Lara 3212 [178 m2] Aura 19`
 *
 * The postcode went with it in all three — `\d{4}` is taken only at the end of
 * a segment, so `3753 (178 m2)` carries no postcode at all — and the composed
 * line handed to the geocoder was `Basalt Street, 3753 (178 m2) VIC`, which is
 * why that property answered "that address could not be located" and the only
 * one of nineteen with no photograph.
 *
 * TWO RULES, AND THE SECOND IS WHAT MAKES THE FIRST SAFE.
 *
 * **A round bracket is a measurement, never a design.** `(178 m2)` is the
 * building's size on every row that carries one; reading it as a house design
 * would put a number where a reader expects a name.
 *
 * **An annotation FOLLOWS the address, so it is only stripped where an address
 * precedes it** — the text before it has to carry a state or a postcode.
 * Without that test `[Something] 44 Satinwood Crescent Donnybrook VIC` strips
 * to nothing, because the words trailing a bracket are taken with it: that is
 * how `[178 m2] Aura 19` loses the design name sitting outside the bracket,
 * and it must not become a way to lose the whole line.
 */
function stripTrailingAnnotations(line: string, out: ParsedBuilderAddress): string {
  let rest = line;
  // A group, then whatever trails it as far as the end — no comma and no
  // second opener, so only the LAST annotation is ever in play.
  const ANNOTATION = /\s*([[(])([^\])]*)[\])]\s*([^,[(]*)$/;

  for (let guard = 0; guard < 4; guard += 1) {
    const match = rest.match(ANNOTATION);
    if (!match || match.index === undefined) break;

    const head = rest.slice(0, match.index);
    // The address has to be in front of it. See the second rule above.
    if (!AU_STATE.test(head) && !/\b\d{4}\b/.test(head)) break;

    const [, opener, inside, trailing] = match;
    const named = tidy(trailing) ?? (opener === '[' ? tidy(inside) : null);
    out.designName ??= named;

    rest = tidy(head) ?? '';
  }
  return rest;
}

/**
 * Pull a free-text builder line apart.
 *
 * Everything is optional and nothing is guessed: a segment that cannot be
 * classified is left out rather than assigned to the nearest field, because a
 * wrong suburb sends a pin to another state and a missing one only leaves it
 * where it was.
 */
export function parseBuilderAddressLine(line: string | null | undefined): ParsedBuilderAddress {
  const empty: ParsedBuilderAddress = {
    lotNumber: null, unitNumber: null, streetNumber: null, streetName: null,
    streetType: null, suburb: null, state: null, postcode: null,
    estate: null, designName: null,
  };

  let rest = tidy(line);
  if (!rest) return empty;

  const out: ParsedBuilderAddress = { ...empty };

  // 1. The trailing annotations.
  rest = stripTrailingAnnotations(rest, out);

  // 2. The leading lot or unit designation.
  const lot = rest.match(/^lot\s*\.?\s*([0-9]+[a-z]?)\s*[-–:,]?\s*/i);
  if (lot) {
    out.lotNumber = lot[1];
    rest = tidy(rest.slice(lot[0].length)) ?? '';
  }
  const unit = rest.match(/^unit\s*\.?\s*([0-9]+[a-z]?)\s*[-–:,]?\s*/i);
  if (unit) {
    out.unitNumber = unit[1];
    rest = tidy(rest.slice(unit[0].length)) ?? '';
  }

  // 3. The postcode: four digits, and only where a segment ENDS after them —
  //    at a comma, at the end of the line, or at the state, so a house number
  //    like `4301 Smith Street` cannot be mistaken for one.
  //
  //    The state belongs in that list because a list writes the pair in either
  //    order. `Redbank Plains QLD 4301` is the common one and ends the line;
  //    `Lara 3212 VIC` is the same fact the other way round, and refusing it
  //    left the digits inside the suburb — `Lara 3212`, which is a suburb no
  //    register holds and which this now stores in a column a card reads.
  const postcode = rest.match(/\b(\d{4})\b(?=\s*(?:,|$|\b(?:NSW|VIC|QLD|WA|SA|TAS|ACT|NT)\b))/i);
  if (postcode) {
    out.postcode = postcode[1];
    rest = tidy(rest.slice(0, postcode.index) + ' ' + rest.slice(postcode.index! + 4)) ?? '';
  }

  // 4. The state.
  const state = rest.match(AU_STATE);
  if (state) {
    out.state = state[0].toUpperCase();
    rest = tidy(rest.slice(0, state.index) + ' ' + rest.slice(state.index! + state[0].length)) ?? '';
  }

  // 5. Segments. The FIRST is the street, the LAST is the suburb, and anything
  //    between them is the estate's marketing name — `Sandpiper Estate`,
  //    `Greenfern Habitat`, `Coridale`. Position settles it rather than a
  //    keyword list, because half the estates here are not called "Estate".
  const segments = rest.split(',').map((seg) => tidy(seg)).filter((seg): seg is string => Boolean(seg));
  let head: string | null = segments[0] ?? null;
  if (segments.length > 1) {
    out.suburb = segments[segments.length - 1];
    const middle = segments.slice(1, -1).filter(Boolean);
    if (middle.length) out.estate = middle.join(', ');
  }

  // 6. Inside the street segment the street TYPE is the boundary: what precedes
  //    it is number and name, what follows it (where no later segment gave us
  //    one) is the suburb.
  if (head) {
    let matched: { index: number; length: number; canonical: string } | null = null;
    for (const [re, canonical] of STREET_TYPES) {
      const m = head.match(re);
      if (m && m.index !== undefined) {
        // The LAST type wins: `Grove Street` is a Street on Grove, not a Grove.
        if (!matched || m.index > matched.index) {
          matched = { index: m.index, length: m[0].length, canonical };
        }
      }
    }

    if (matched) {
      out.streetType = matched.canonical;
      const after = tidy(head.slice(matched.index + matched.length));
      if (!out.suburb && after) out.suburb = after;
      // A single segment carrying an estate before the street type — rare, but
      // it must not end up inside the street name.
      const streetPart = tidy(head.slice(0, matched.index));

      if (streetPart) {
        const unitOverNumber = streetPart.match(/^(\d+[a-z]?)\s*\/\s*(\d+[a-z]?)\s+(.*)$/i);
        const leadingNumber = streetPart.match(/^(\d+[a-z]?)\s+(.*)$/i);

        if (unitOverNumber) {
          // `13/15 Rose` is unambiguous: a unit over a street number.
          out.unitNumber = out.unitNumber ?? unitOverNumber[1];
          out.streetNumber = unitOverNumber[2];
          out.streetName = tidy(unitOverNumber[3]);
        } else if (leadingNumber) {
          const [, value, name] = leadingNumber;
          out.streetName = tidy(name);
          if (out.lotNumber) {
            // The line already said `Lot N -`, so this second number is the
            // street number: `Lot 209 - 44 Satinwood Crescent`.
            out.streetNumber = value;
          } else {
            // Otherwise it is a LOT number, and reading it as a street number
            // is how an honest suburb pin becomes a confidently wrong rooftop.
            //
            // This is measured, not assumed. Of the 44 distinct rows that open
            // with a bare number AND carry a populated `lot_number` column,
            // the leading number equals the lot in **44** and differs in none.
            // It holds at every magnitude — `105 Slide Place` and
            // `119 Socket Drive` as much as `51352 Danube Road` — so size is
            // not the signal and there is no threshold to tune. The corpus
            // shows the same street written both ways by one builder:
            // `1730 Hornsea Street` beside `Lot 1731 Hornsea Street`, and
            // `312 Splitters Road` beside `Lot 323 Splitters Road`.
            //
            // The cost is asymmetric too, which is why this is the safe side
            // even where a row disagrees: calling a street number a lot costs
            // street-level instead of rooftop, which is a pin on the right
            // street. Calling a lot number a street number puts the pin on
            // somebody else's house.
            out.lotNumber = value;
          }
        } else {
          out.streetName = streetPart;
        }
      }
    } else if (!out.suburb) {
      // Nothing names a street and nothing else named a suburb, so this is the
      // suburb: `Armstrong Creek VIC`.
      out.suburb = head;
      head = null;
    } else {
      // A suburb came from a later segment and this one names no street, so it
      // is the estate: `Lot 2065 - Coridale, Lara, VIC 3212`. Recording it here
      // matters as much as recording the street ones — an estate left in the
      // head would otherwise be geocoded as a street that does not exist.
      out.estate = out.estate ? `${head}, ${out.estate}` : head;
      head = null;
    }
  }

  out.suburb = tidy(out.suburb);
  return out;
}

/**
 * The address a builder stock row should be geocoded and displayed by.
 *
 * The structured columns win where they are populated — a builder who typed a
 * suburb into the field meant it — and the parsed line fills the rest, which
 * in practice is nearly everything.
 */
export function builderStockAddress(row: {
  address_line?: string | null;
  suburb?: string | null;
  state?: string | null;
  postcode?: string | null;
  lot_number?: string | null;
  unit_number?: string | null;
}): ComposedAddress & { parsed: ParsedBuilderAddress } {
  const parsed = parseBuilderAddressLine(row.address_line);
  const composed = composeListingAddress({
    unitNumber: tidy(row.unit_number) ?? parsed.unitNumber,
    streetNumber: parsed.streetNumber,
    streetName: parsed.streetName,
    streetType: parsed.streetType,
    suburb: tidy(row.suburb) ?? parsed.suburb,
    state: tidy(row.state) ?? parsed.state,
    postcode: tidy(row.postcode) ?? parsed.postcode,
    // Never the raw line: it still carries the lot prefix and the design name,
    // which is what made the provider answer with the suburb.
    address: null,
    formatted: null,
  });
  return { ...composed, parsed };
}
