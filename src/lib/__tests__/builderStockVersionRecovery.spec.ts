/**
 * A NEWER RUNTIME RE-ASKS WHAT OUR WORKER FAILED, AND NOTHING ELSE.
 *
 * Since runtime 5 the Dropbox folder read and the PDF cover election run on
 * the heavy-work worker, so a worker outage answers `unreachable` exactly as a
 * dead link does. The retirement after `MAX_UNREACHABLE_ATTEMPTS` such answers
 * carried no runtime stamp — deliberately, so dead links are not re-chased on
 * every runtime change — which meant a branch our OWN outage retired was never
 * re-asked when the runtime that failed was superseded (found by the worker
 * fault proof, 1 October 2026). The transport now marks its own failures
 * (`cause: 'worker'`) and only those retirements are stamped.
 *
 * Pinned here, on the real record writers and the one predicate that decides
 * whether a retirement still stands:
 *   - our worker's retirement stands at its runtime (no loop) and is re-asked
 *     under a newer one, with a fresh budget that retires — and stands — again;
 *   - a dead link's retirement is NOT re-asked by a runtime change;
 *   - a document's own answer (inspected) is never re-asked by a runtime change;
 *   - a worker killed holding the document is re-asked, as it always was;
 *   - a provenance change re-asks all of them.
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_UNREACHABLE_ATTEMPTS, recordPackageUnprocessable, recordPackageUnreachable, recordUnreachableAttempt,
  unreachableAttemptsExhausted,
} from '../../../supabase/functions/_shared/builderStock/packageAttempt.pure';
import {
  negativeProvenanceStillStands, recordNoDeterministicImage, type ProvenanceQuestion,
} from '../../../supabase/functions/_shared/builderStock/negativeProvenance.pure';

const at = (runtimeVersion: number, provenanceVersion = 30): ProvenanceQuestion => ({
  provenanceVersion, runtimeVersion,
  packageReference: 'https://www.dropbox.com/scl/fo/abc/xyz?dl=0', sourceAnchor: 'row:7',
});

describe('a retirement our worker caused is re-asked by a newer runtime', () => {
  it('stands at its own runtime, so nothing loops', () => {
    const retired = recordPackageUnreachable(at(5), undefined, true);
    expect(retired.runtime_version).toBe(5);
    expect(retired.exhaustion).toBe('operational');
    expect(negativeProvenanceStillStands(retired, at(5))).toBe(true);
  });

  it('is re-asked under a newer runtime, with a fresh, bounded budget that retires and stands again', () => {
    const retired = recordPackageUnreachable(at(5), undefined, true);
    expect(negativeProvenanceStillStands(retired, at(6))).toBe(false);

    // The re-ask starts a new count: the retirement is not an attempt record.
    let stored: unknown = retired;
    for (let n = 0; n < MAX_UNREACHABLE_ATTEMPTS; n += 1) {
      expect(unreachableAttemptsExhausted(stored, at(6))).toBe(false);
      stored = recordUnreachableAttempt(stored, at(6));
    }
    expect(unreachableAttemptsExhausted(stored, at(6))).toBe(true);
    const again = recordPackageUnreachable(at(6), undefined, true);
    expect(negativeProvenanceStillStands(again, at(6))).toBe(true);
  });
});

describe('what a runtime change must NOT re-ask', () => {
  it('a dead link (the source refused) carries no stamp and keeps standing', () => {
    const dead = recordPackageUnreachable(at(5));
    expect(dead.runtime_version).toBeUndefined();
    expect(negativeProvenanceStillStands(dead, at(6))).toBe(true);
  });

  it('a document\'s own answer is a content verdict and keeps standing', () => {
    const inspected = recordNoDeterministicImage(at(5), 'No page names this property.', 'inspected');
    expect(negativeProvenanceStillStands(inspected, at(6))).toBe(true);
  });
});

describe('the recoveries that already existed still hold', () => {
  it('a worker killed holding the document is re-asked by a newer runtime', () => {
    const killed = recordPackageUnprocessable(at(5));
    expect(negativeProvenanceStillStands(killed, at(5))).toBe(true);
    expect(negativeProvenanceStillStands(killed, at(6))).toBe(false);
  });

  it('a provenance change re-asks every retirement, ours or the document\'s', () => {
    for (const record of [
      recordPackageUnreachable(at(5), undefined, true),
      recordPackageUnreachable(at(5)),
      recordNoDeterministicImage(at(5), 'No page names this property.', 'inspected'),
    ]) {
      expect(negativeProvenanceStillStands(record, at(5, 31))).toBe(false);
    }
  });
});
