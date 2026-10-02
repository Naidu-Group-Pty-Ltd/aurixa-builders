/**
 * A SEGMENT THE READER CANNOT NAME MUST NOT DESTROY THE ADDRESS AROUND IT.
 *
 * Measured 2 October 2026 on two real builder packages.
 *
 * `Lot 208, 46 Satinwood Crescent, Peppercorn Hill, Donnybrook VIC 3064` read
 * as NOTHING, and its whole document with it — while the SAME document's
 * shorter `Lot 208, 46 Satinwood Crescent, Donnybrook VIC 3064` read
 * perfectly. The street and the locality are both stated plainly; the only
 * difference is an estate name sitting between them that does not declare
 * itself one. The head was asked for a street as ONE JOINED STRING, so
 * `46 Satinwood Crescent, Peppercorn Hill` ends in no street type and carries
 * a digit, and a line that states MORE voided itself where a line stating
 * less was read.
 *
 * The same join lost a street it already had: `Lot 12, 5 Hill Road, Riverstone
 * Estate, Truganina VIC 3029` matched `NAMED_DEVELOPMENT` ACROSS the comma and
 * produced a development of `5 Hill Road, Riverstone Estate` with no street at
 * all — a street number swallowed into an estate's name, which is how a pin
 * ends up on nobody's house. That one shipped silently and nothing could see
 * it, because a wrong development still looks like a row.
 *
 * WHAT MUST NOT MOVE is the deliberate rule above this one: a segment that
 * merely LOOKS like a name is still not a development. `Peppercorn Hill` says
 * nothing about what it is, and the alternative on one of these very documents
 * was `PROPLAUNCH` read off a caption. So an unnamed segment is left unread —
 * it is simply no longer allowed to take the address down with it.
 */
import { describe, expect, it } from 'vitest';
import {
  readComposedAddressLine,
} from '../../../supabase/functions/_shared/builderStock/pdfDeterministicRows.pure';

describe('a composed address line is read segment by segment', () => {
  it('an undeclared segment between the street and the locality is left unread, not fatal', () => {
    const read = readComposedAddressLine(
      'Lot 208, 46 Satinwood Crescent, Peppercorn Hill, Donnybrook VIC 3064');
    expect(read).toMatchObject({
      street: '46 Satinwood Crescent',
      lot: '208',
      suburb: 'Donnybrook',
      state: 'VIC',
      postcode: '3064',
    });
    // Never promoted to the development: it never said it was one.
    expect(read?.development).toBeNull();
  });

  it('the same line without that segment is unchanged', () => {
    expect(readComposedAddressLine('Lot 208, 46 Satinwood Crescent, Donnybrook VIC 3064'))
      .toMatchObject({ street: '46 Satinwood Crescent', lot: '208', suburb: 'Donnybrook' });
  });

  it('with no lot either, the street and locality still stand', () => {
    expect(readComposedAddressLine('46 Satinwood Crescent, Peppercorn Hill, Donnybrook VIC 3064'))
      .toMatchObject({ street: '46 Satinwood Crescent', lot: null, suburb: 'Donnybrook' });
  });

  it('a declared estate beside a numbered street keeps BOTH, and the street is not swallowed', () => {
    expect(readComposedAddressLine('Lot 12, 5 Hill Road, Riverstone Estate, Truganina VIC 3029'))
      .toMatchObject({
        street: '5 Hill Road',
        development: 'Riverstone Estate',
        lot: '12',
        suburb: 'Truganina',
      });
  });

  it('an estate with no street is the shape it always was', () => {
    expect(readComposedAddressLine('Lot 1482, Coridale Estate, Lara VIC 3212'))
      .toMatchObject({ street: '', lot: '1482', development: 'Coridale Estate', suburb: 'Lara' });
    expect(readComposedAddressLine('Lot 37, Sandpiper Estate, Tweed Heads NSW'))
      .toMatchObject({ street: '', lot: '37', development: 'Sandpiper Estate' });
  });

  it('two numbered streets refuse the line: reading by segment must not choose by order', () => {
    /*
     * Codex P1, 2 October 2026, on this change. Reading segment by segment
     * made it possible to take the FIRST of several streets and silently
     * discard a contradictory second address — choosing by segment order,
     * which is the one thing the dispute rules here never do. The joined
     * parsing refused this line and it must still refuse it.
     */
    expect(readComposedAddressLine('Lot 12, 5 Hill Road, 7 Main Street, Truganina VIC 3029'))
      .toBeNull();
  });

  it('a lot and an undeclared name, with no street stated anywhere, is still nothing', () => {
    // The negative control: this rule widens what is READ, never what is INVENTED.
    expect(readComposedAddressLine('Lot 208, Peppercorn Hill, Donnybrook VIC 3064')).toBeNull();
  });
});
