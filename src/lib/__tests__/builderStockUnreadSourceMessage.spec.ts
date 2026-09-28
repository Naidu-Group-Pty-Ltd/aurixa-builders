import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { unreadWithoutAssistedReader } from '../../../supabase/functions/_shared/builderStock/assistedReaderFailure.pure.ts';

/**
 * A FILE NOTHING HERE COULD READ IS NOT A FILE THAT "DID NOT DESCRIBE A PROPERTY".
 *
 * MEASURED 28 SEPTEMBER 2026 on the live product (Tier-0 audit, phase
 * `stock-tier0-formats`): a photograph of a printed stock list (.png, .jpg,
 * .webp, .gif) and a table in an older Word file (.doc) were each refused with
 * "We read that file, but it did not describe a property we could list. If it
 * should, check that it names the lot or address and its price." — about files
 * that named both. Nothing had read them: a photograph is read only by the
 * assisted reader, which this deployment has switched off, and the legacy Word
 * reader recovers no table. The builder was told to check a document that was
 * never the problem, with no way forward. They are now told what could not be
 * read and what to upload instead.
 */
describe('the refusal for a file only the assisted reader could have read', () => {
  it('tells a builder a photograph of a stock list is not read here, and what to upload (the measured defect)', () => {
    const message = unreadWithoutAssistedReader({ classificationKind: 'image', strategy: 'image_vision' });
    expect(message).toMatch(/photograph/i);
    expect(message).toMatch(/spreadsheet|CSV/);
    expect(message).not.toMatch(/did not describe a property/);
  });

  it('tells a builder an older Word file\'s table could not be read, and how to save it instead', () => {
    const message = unreadWithoutAssistedReader({ classificationKind: 'word', strategy: 'legacy_word_text' });
    expect(message).toMatch(/\.doc\b/);
    expect(message).toMatch(/\.docx|PDF/);
  });

  it('says nothing where a reader did look — the document\'s own finding stands', () => {
    expect(unreadWithoutAssistedReader({ classificationKind: 'image', strategy: 'image_vision+model' })).toBeNull();
    expect(unreadWithoutAssistedReader({ classificationKind: 'word', strategy: 'word_table' })).toBeNull();
    expect(unreadWithoutAssistedReader({ classificationKind: 'word', strategy: 'legacy_word_text+model' })).toBeNull();
    expect(unreadWithoutAssistedReader({ classificationKind: 'pdf', strategy: 'pdf_deterministic_brochure' })).toBeNull();
  });

  it('never tells a document to grow columns', () => {
    for (const [classificationKind, strategy] of [['image', 'image_vision'], ['word', 'legacy_word_text']] as const) {
      expect(unreadWithoutAssistedReader({ classificationKind, strategy })).not.toMatch(/column/i);
    }
  });

  it('is what the import answers before its generic refusal', () => {
    const run = readFileSync(resolve(__dirname,
      '../../../supabase/functions/_shared/builderStock/runImport.ts'), 'utf8');
    const unread = run.indexOf('unreadWithoutAssistedReader({');
    const generic = run.indexOf('`We read that ${what}, but it did not describe a property we could list.`');
    expect(unread).toBeGreaterThan(0);
    expect(generic).toBeGreaterThan(unread);
  });
});
