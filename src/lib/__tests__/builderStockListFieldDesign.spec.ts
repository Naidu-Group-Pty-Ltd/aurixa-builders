import { describe, expect, it } from 'vitest';
import { recoverPackageImage } from '../../../supabase/functions/_shared/builderStock/packageImages';
import {
  designTokenFrom, driveDownloadUrl, lotAndDesignFrom, type DriveEntry,
} from '../../../supabase/functions/_shared/builderStock/drivePackage.pure';
import { listFieldsAfterAddress } from '../../../supabase/functions/_shared/builderStockAddress.pure';

/**
 * MEASURED 30 SEPTEMBER 2026. The live Notion list (upload 6c025d69) titles
 * its rows `Lot 60415 Beveridge VIC · Esme 13`: the design is a field of its
 * own, not a bracket, and the list has no design column. Lots 60415 and 60416
 * each sell two designs from ONE shared folder, and with the lot as the only
 * key both packages in each folder named the property — four rows, no image,
 * `That folder names no document for this exact property.`
 */
const FOLDER = 'https://drive.google.com/drive/folders/1p53q91hfGJcqtTESTFOLDER?usp=sharing';
const ROOT = '1p53q91hfGJcqtTESTFOLDER';

function fakeLibrary(tree: Record<string, DriveEntry[]>) {
  const asked: string[] = [];
  return {
    asked,
    deps: {
      cache: { list: async (id: string) => tree[id] ?? [], listings: 0 } as never,
      // The document download is the decision under test; stop there.
      fetchPackage: async (url: string) => {
        asked.push(url);
        throw Object.assign(new Error('stopped'), { safeMessage: 'stopped by the test' });
      },
      readPageTexts: async () => [] as string[],
    },
  };
}

const pdf = (id: string, name: string): DriveEntry => ({ id, name, mimeType: 'application/pdf' });

describe('the design a list writes in a field of its own', () => {
  it('is read from the first field after the address, in the matcher\'s own token form', () => {
    expect(listFieldsAfterAddress('Lot 60415 Beveridge VIC · Esme 13')).toEqual(['Esme 13']);
    expect(designTokenFrom(listFieldsAfterAddress('Lot 52 Tweed Heads · Bravo 217 · Best Price')[0]))
      .toBe('bravo 217');
    expect(designTokenFrom(listFieldsAfterAddress('Lot 104 Redbank Plains QLD · Chester 242 Dual-Key')[0]))
      .toBe('chester 242');
    // A configuration or a bare word is not a design.
    expect(designTokenFrom(listFieldsAfterAddress('Lot 60941 Kalkallo VIC · 3 Bed')[0])).toBeNull();
    expect(designTokenFrom(listFieldsAfterAddress('Unit 19 Thornton NSW · Industrial')[0])).toBeNull();
    // The bracket rule is unchanged.
    expect(lotAndDesignFrom('Lot 36 - Tringa Street, Tweed Heads South NSW 2486 [Stradbroke 180]'))
      .toEqual({ lot: '36', design: 'stradbroke 180' });
  });

  it('decides between two packages filed for one lot', async () => {
    const library = fakeLibrary({
      [ROOT]: [
        pdf('esme-package', 'Lot 60415 Beveridge - Esme 13 - Package.pdf'),
        pdf('ilya-package', 'Lot 60415 Beveridge - Ilya 15 - Package.pdf'),
      ],
    });
    await recoverPackageImage({ packageUrl: FOLDER, label: 'Lot 60415 Beveridge VIC · Esme 13' }, library.deps);
    expect(library.asked).toEqual([driveDownloadUrl('esme-package')]);

    const other = fakeLibrary({
      [ROOT]: [
        pdf('esme-package', 'Lot 60415 Beveridge - Esme 13 - Package.pdf'),
        pdf('ilya-package', 'Lot 60415 Beveridge - Ilya 15 - Package.pdf'),
      ],
    });
    await recoverPackageImage({ packageUrl: FOLDER, label: 'Lot 60415 Beveridge VIC · Ilya 15' }, other.deps);
    expect(other.asked).toEqual([driveDownloadUrl('ilya-package')]);
  });

  it('never refuses the folder that works today: one package naming only the lot', async () => {
    const library = fakeLibrary({
      [ROOT]: [pdf('only-package', 'Lot 1482 Coridale - Package.pdf')],
    });
    await recoverPackageImage({ packageUrl: FOLDER, label: 'Lot 1482 Lara VIC · Aura 178' }, library.deps);
    expect(library.asked).toEqual([driveDownloadUrl('only-package')]);
  });

  it('still refuses where neither package names the design the row states', async () => {
    const library = fakeLibrary({
      [ROOT]: [
        pdf('a', 'Lot 60415 Beveridge - Package A.pdf'),
        pdf('b', 'Lot 60415 Beveridge - Package B.pdf'),
      ],
    });
    const outcome = await recoverPackageImage(
      { packageUrl: FOLDER, label: 'Lot 60415 Beveridge VIC · Esme 13' }, library.deps);
    expect(library.asked).toEqual([]);
    expect(outcome.status).toBe('not_identified');
  });
});
