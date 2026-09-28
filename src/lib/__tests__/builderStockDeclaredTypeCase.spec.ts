import { describe, expect, it } from 'vitest';
import {
  STOCK_ALLOWED_DECLARED_MIME,
  STOCK_EXTENSIONS,
  declaredTypeIsAllowed,
} from '../../../supabase/functions/_shared/builderStock/fileTypes.pure.ts';

/**
 * A DECLARED TYPE IS COMPARED THE WAY IT IS WRITTEN DOWN: IN LOWER CASE.
 *
 * MEASURED 28 SEPTEMBER 2026 on the live product (Tier-0 audit, phase
 * `stock-tier0-formats`): a macro-enabled workbook (.xlsm) — a format the file
 * picker offers and the reader parses — was refused at `create_upload` with
 * "That file type cannot be uploaded." The upload door lower-cases the type the
 * browser declares before looking it up, and the allow-list spelled the one
 * entry registered in mixed case (`…sheet.macroEnabled.12`), so no spelling of
 * it could ever match. A browser that declared nothing was let through; one that
 * declared the file's real type was turned away. Media types are
 * case-insensitive, so the list is kept in the case the door compares in.
 */
describe('the declared content type of a stock list', () => {
  it('accepts a macro-enabled workbook under the type browsers declare for it (the measured defect)', () => {
    expect(declaredTypeIsAllowed('application/vnd.ms-excel.sheet.macroEnabled.12')).toBe(true);
    expect(declaredTypeIsAllowed('application/vnd.ms-excel.sheet.macroenabled.12')).toBe(true);
    expect(declaredTypeIsAllowed('APPLICATION/VND.MS-EXCEL.SHEET.MACROENABLED.12; charset=binary')).toBe(true);
  });

  it('keeps every allow-list entry in the case the door compares in', () => {
    const mixed = [...STOCK_ALLOWED_DECLARED_MIME].filter((type) => type !== type.toLowerCase());
    expect(mixed).toEqual([]);
  });

  it('still refuses a type the list does not name, however it is spelled', () => {
    expect(declaredTypeIsAllowed('application/x-msdownload')).toBe(false);
    expect(declaredTypeIsAllowed('APPLICATION/X-SH')).toBe(false);
    expect(declaredTypeIsAllowed('')).toBe(true); // a browser that cannot type the file declares nothing
  });

  it('offers xlsm in the picker, so the door must accept it', () => {
    expect(Object.values(STOCK_EXTENSIONS).flat()).toContain('xlsm');
  });
});
