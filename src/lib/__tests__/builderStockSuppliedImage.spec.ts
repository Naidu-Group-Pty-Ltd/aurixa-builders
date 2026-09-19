/**
 * THE ONE ACT A BUILDER IS TOLD TO PERFORM, AND WHY IT UNDID ITSELF.
 *
 * MEASURED 19 SEPTEMBER 2026, against production, on a seeded organisation
 * through the real portal path — `create_builder_image`, a PUT to the signed
 * URL, `attach_builder_image`. All three answered 200 and the picture stored
 * correctly: `source_stage: uploaded_document`, `verification_status:
 * source_supplied`, `processing_status: ready`, `role: primary_property` at
 * evidence level 1, against the right organisation and the right upload.
 *
 * The next settler tick demoted it to `processing_status: 'unavailable'`,
 * reason "This image predates the source-provenance record and could not be
 * re-derived from the builder's source, so it is not shown."
 *
 * BOTH DEMOTION SITES in `repairSourceImages` spare a row whose
 * `provenance_version` is current, and `attachBuilderImage` has never written
 * one — correctly, because a supplied image has no derivation to version. So
 * a builder-supplied picture met all four guards and was retired every time.
 *
 * WHAT THAT COST, and why it is not cosmetic. Everything downstream keys on
 * `processing_status = 'ready'`: the eligibility sweep's own query,
 * `isDisplayableSourceImage`, the readiness count behind the Stock List
 * banner. So the demotion was silent and total — the settler logged
 * `eligibility: assessed 0 of 0`, no primary was chosen, and the property
 * retired `supplied evidence no_evidence: this row names no source this
 * pipeline can open`. The builder saw "Picture saved" and a blank card.
 *
 * AND IT IS SELF-INFLICTED IN ORDER. `attachBuilderImage` requeues the
 * property to `source` as part of the act — which is the stage that runs the
 * source repair — so the demotion fires on the very next tick after the
 * builder supplies the picture. The remedy destroyed itself.
 *
 * The rule: the source repair retires images it can no longer RE-DERIVE from
 * the builder's documents. One handed over directly was never derived, so
 * "could not be re-derived" is not a finding about it. `supplied_directly` was
 * written from the first version of that module and read by nothing.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  suppliedDirectly,
} from '../../../supabase/functions/_shared/builderStock/attachBuilderImage';

const SHARED = 'supabase/functions/_shared/builderStock';
const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');

describe('a picture the builder handed over was never derived from anything', () => {
  it('recognises the marker `attachBuilderImage` has always written', () => {
    expect(suppliedDirectly({ supplied_directly: true })).toBe(true);
  });

  it('is not fooled by an absent, null or falsey marker', () => {
    expect(suppliedDirectly(null)).toBe(false);
    expect(suppliedDirectly(undefined)).toBe(false);
    expect(suppliedDirectly({})).toBe(false);
    expect(suppliedDirectly({ supplied_directly: false })).toBe(false);
    // Deliberately strict: a string is what a hand-written row or a loose
    // client would put there, and this decides whether a picture survives.
    expect(suppliedDirectly({ supplied_directly: 'true' })).toBe(false);
  });

  it('the attach still writes the marker, so the guard has something to read', () => {
    expect(read(`${SHARED}/attachBuilderImage.ts`)).toContain('supplied_directly: true');
  });

  it('and still writes no provenance_version, because there is no derivation', () => {
    // If this ever starts stamping one, the guard below becomes dead code and
    // the reason it exists is lost. The honest fix was never to claim a
    // derivation the image does not have.
    const attach = read(`${SHARED}/attachBuilderImage.ts`)
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(attach).not.toContain('provenance_version');
  });
});

describe('the source repair spares what it never derived', () => {
  const repair = read(`${SHARED}/repairSourceImages.ts`);
  const code = repair.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('guards BOTH demotion sites, not just the one that was noticed', () => {
    // Two loops retire stale stage-1 rows — the row path and the document
    // path. A supplied image reaches both, so one guard would fix half the
    // defect and leave the other half to be found in production again.
    const guards = code.match(/if \(suppliedDirectly\([^)]*\)\) continue;/g) ?? [];
    expect(guards.length).toBe(2);
  });

  it('asks BEFORE the provenance-version test, which is what demotes it', () => {
    for (const site of code.split('demoteUnprovenSourceImage(db, {').slice(0, 2)) {
      const guardAt = site.lastIndexOf('suppliedDirectly(');
      const versionAt = site.lastIndexOf('provenance_version');
      expect(guardAt).toBeGreaterThan(-1);
      expect(guardAt).toBeLessThan(versionAt);
    }
  });

  it('reads the rule rather than restating it', () => {
    expect(code).toContain("from './attachBuilderImage.ts'");
    expect(code).not.toMatch(/supplied_directly/);
  });
});
