/**
 * A DOCUMENT THAT CANNOT ANSWER DIFFERENTLY IS NOT ASKED SIX TIMES.
 *
 * WHAT THIS FILE HOLDS. `unreachable` is one word over two opposite failures.
 * A sign-in wall, a 404, a rate limit, a cold origin and a killed worker are
 * TRANSIENT — the same link may read perfectly tomorrow, which is why
 * `MAX_UNREACHABLE_ATTEMPTS` is six and why it must stay six. A brochure whose
 * every page is text-free, whose folder had already tied it to this one
 * property, and whose cover rasters were decoded and elected nothing is not
 * that: every step of it is a pure function of the bytes, so the same bytes
 * answer the same way for ever.
 *
 * MEASURED, AND THAT IS WHY THIS EXISTS. Lot 208 / `46 Satinwood Crescent
 * Donnybrook` — production, 19 September 2026. Seven elections in the 12:12
 * import and seven more in the 13:33 one, 4,178,756 bytes every time, the same
 * verdict every time, across two isolate populations, durations 3.3 s to
 * 16.3 s. The whole eighteen-property stock list could not publish until that
 * branch retired: 10 min 47 s in the first import, 8 min 13 s in the second.
 * The property had held a stored picture since 41 seconds after the upload
 * began, so not one of those thirteen surplus elections could have changed any
 * outcome.
 *
 * THE TWO RULES THIS FILE IS HERE TO BREAK IF THEY SLIP.
 *
 *   The budget keys on a CODE, never on a sentence. Prose is reworded for
 *   operators and a retry budget must not move when somebody fixes a comma.
 *
 *   Two attempts means TWO ELECTIONS. The generic path checks a STORED count
 *   after an election returns, so at six it spends seven — that behaviour is
 *   deliberately untouched here and is recorded as its own finding. This
 *   budget must not inherit it, so the exhaustion test counts the refusal in
 *   hand and the third election is never dispatched.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_PACKAGE_ATTEMPTS, MAX_TEXT_FREE_COVER_ATTEMPTS, MAX_UNREACHABLE_ATTEMPTS,
  attemptsSoFar, recordPackageAttempt, recordPackageTextFreeCover,
  recordPackageUnreachable, recordTextFreeCoverAttempt, recordUnreachableAttempt,
  textFreeCoverExhaustedAfter, textFreeCoverSoFar, unreachableAttemptsExhausted,
  unreachableSoFar,
} from '../../../supabase/functions/_shared/builderStock/packageAttempt.pure';
import {
  branchTerminal, writeBranchState,
  type RowSourceBranch,
} from '../../../supabase/functions/_shared/builderStock/sourceBranches.pure';
import {
  NO_DETERMINISTIC_IMAGE,
} from '../../../supabase/functions/_shared/builderStock/negativeProvenance.pure';
import {
  classifyBranchRecord,
} from '../../../supabase/functions/_shared/builderStock/suppliedEvidence.pure';
import {
  PDF_ELECTION_PROTOCOL, TEXT_FREE_COVER_NOT_ELECTED, electionProtocolFor,
  isElectionRefusalReason,
} from '../../../supabase/functions/_shared/builderStock/pdfElectionBoundary.pure';
import {
  coverRastersInspected,
} from '../../../supabase/functions/_shared/builderStock/pdfSourcePhoto';
import {
  runElectionOnRoute,
} from '../../../supabase/functions/_shared/builderStock/pdfElectionClient';
import {
  readPdfPageTextResult,
} from '../../../supabase/functions/_shared/builderStock/pdfText';
import {
  RUNTIME_VERSION,
} from '../../../supabase/functions/_shared/builderStock/runtimeVersion.pure';

/** Lot 208's own branch, as the row records it. */
const BRANCH: RowSourceBranch = {
  url: 'https://drive.google.com/drive/folders/1pUm82XKTJawUD96_nZdJ_gH9ZjcG9JyR',
  column: 'Complete Package Pack',
  kind: 'drive_folder',
};

const QUESTION = {
  provenanceVersion: 26,
  runtimeVersion: RUNTIME_VERSION,
  packageReference: BRANCH.url,
  sourceAnchor: 'notion:3a8cabf9-2010-80d2-8589-cb2a7f6ec26f',
};

/**
 * ONE CLAIM OF THE REAL SETTLER, REDUCED TO THE PART UNDER TEST.
 *
 * The branch is elected only while `branchTerminal` — the REAL predicate the
 * settler's `openBranches` uses — still says it is owed a look, and the
 * banking is the real recorders and the real exhaustion tests. Nothing here
 * re-implements a decision; what it stands in for is the database and the
 * two-minute claim backoff between laps.
 */
function driveBranchToRetirement(
  answer: () => { reason?: string },
  laps = 12,
): { elections: number; stored: unknown } {
  let stored: unknown = null;
  let elections = 0;
  for (let lap = 0; lap < laps; lap += 1) {
    if (branchTerminal(stored, BRANCH, QUESTION)) break;
    const branchBefore = (stored as { branches?: Record<string, unknown> } | null)
      ?.branches?.[BRANCH.url] ?? null;
    elections += 1;
    const outcome = answer();
    if (outcome.reason === TEXT_FREE_COVER_NOT_ELECTED) {
      stored = writeBranchState(stored, BRANCH.url,
        textFreeCoverExhaustedAfter(branchBefore, QUESTION)
          ? recordPackageTextFreeCover(QUESTION)
          : recordTextFreeCoverAttempt(branchBefore, QUESTION));
    } else {
      stored = writeBranchState(stored, BRANCH.url,
        unreachableAttemptsExhausted(branchBefore, QUESTION)
          ? recordPackageUnreachable(QUESTION)
          : recordUnreachableAttempt(branchBefore, QUESTION));
    }
  }
  return { elections, stored };
}

/** A shared edge module's own source, for the rules only the source can hold. */
const readSource = (name: string) => readFileSync(
  join(process.cwd(), 'supabase/functions/_shared/builderStock', name), 'utf8');

/** The two answers a claim can come back with, to one shape the loop reads. */
type Answer = () => { reason?: string };
const deterministic: Answer = () => ({ reason: TEXT_FREE_COVER_NOT_ELECTED });
const generic: Answer = () => ({});

describe('the deterministic text-free cover refusal retires after exactly two elections', () => {
  /** (1) and (2). The whole point of the change, in one assertion each. */
  it('runs exactly two elections and then retires', () => {
    const { elections, stored } = driveBranchToRetirement(deterministic);
    expect(elections).toBe(MAX_TEXT_FREE_COVER_ATTEMPTS);
    expect(elections).toBe(2);
    expect(branchTerminal(stored, BRANCH, QUESTION)).toBe(true);
  });

  /**
   * (2) again, stated as the thing that actually went wrong in production: a
   * third dispatch. Twenty laps of a loop that would happily run them proves
   * the branch closes rather than merely slowing down.
   */
  it('never dispatches a third election, however many laps it is offered', () => {
    expect(driveBranchToRetirement(deterministic, 20).elections).toBe(2);
  });

  /**
   * The first refusal must NOT retire.
   *
   * `coverRastersInspected` now rules out the decode that produced NOTHING,
   * so the residual is narrower and sharper: a decode that materialised SOME
   * of a page's rasters and was starved of the rest would satisfy the
   * predicate while a healthier run might still find the photograph. One
   * retry covers exactly that; a budget of one would bank on the first of
   * them.
   */
  it('does not retire on the first refusal', () => {
    const first = writeBranchState(null, BRANCH.url,
      recordTextFreeCoverAttempt(null, QUESTION));
    expect(branchTerminal(first, BRANCH, QUESTION)).toBe(false);
    expect(textFreeCoverSoFar(
      (first as { branches: Record<string, unknown> }).branches[BRANCH.url], QUESTION)).toBe(1);
  });

  /**
   * The exhaustion test counts the refusal IN HAND. This is the off-by-one
   * the generic path has and this one must not: asserted on the predicate
   * itself so it cannot be reintroduced by a caller that looks reasonable.
   */
  it('counts the refusal in hand, unlike the generic stored-count test', () => {
    expect(textFreeCoverExhaustedAfter(null, QUESTION)).toBe(false);
    const one = recordTextFreeCoverAttempt(null, QUESTION);
    expect(textFreeCoverExhaustedAfter(one, QUESTION)).toBe(true);

    // The generic one, unchanged, for contrast: six stored before it fires.
    let generic: unknown = null;
    for (let n = 0; n < MAX_UNREACHABLE_ATTEMPTS; n += 1) {
      expect(unreachableAttemptsExhausted(generic, QUESTION)).toBe(false);
      generic = recordUnreachableAttempt(generic, QUESTION);
    }
    expect(unreachableAttemptsExhausted(generic, QUESTION)).toBe(true);
  });
});

/**
 * THE SHAPES, MEASURED THROUGH THE BUNDLED READER ON THE REAL DOCUMENTS.
 *
 * `coverPages.length > 0` is NOT proof that anything was decoded — the
 * selection contract says in as many words that a non-empty list with no
 * asset is OURS, and `pdfElection.ts` already refuses that shape as a starved
 * raster step further down. The mint therefore has to gate on positive
 * evidence, or a brochure we merely ran out of CPU on drops from six attempts
 * to two.
 *
 * Every row below is a real reading, not a supposition:
 *
 *   Lot 208's own 4,178,756-byte document — coverPages [1], ONE decoded asset
 *   of 2,375,240 bytes on page 1, page order authoritative, no unread
 *   streams, refused "every picture on the property cover is a plan or a
 *   graphic rather than a photograph of the property".
 *
 *   The no-raster fixture — coverPages [1], ZERO assets. Byte-for-byte the
 *   shape a starved decode yields, and indistinguishable from it.
 */
describe('the mint demands positive evidence that the rasters were inspected', () => {
  /** Lot 208, exactly as the bundled reader reported it on 20 Sep 2026. */
  const LOT_208 = {
    assets: [{ page: 1 }],
    coverPages: [1],
    pageOrderAuthoritative: true,
    objectStreamsUnread: 0,
  };

  it('accepts the measured Lot 208 shape', () => {
    expect(coverRastersInspected(LOT_208)).toBe(true);
  });

  /** THE ONE THIS REVIEW EXISTS FOR. Nothing decoded is never the document. */
  it('refuses a cover page with nothing decoded — a starved or failed raster step', () => {
    expect(coverRastersInspected({ ...LOT_208, assets: [] })).toBe(false);
  });

  it('refuses a document whose page tree could not be decompressed', () => {
    expect(coverRastersInspected({
      ...LOT_208, pageOrderAuthoritative: false, objectStreamsUnread: 3,
    })).toBe(false);
  });

  /**
   * A catalogue that genuinely names no page tree, with every stream read, is
   * the DOCUMENT speaking — so the predicate does not refuse on page order
   * alone. It refuses only when a stream went unread with it.
   */
  it('does not refuse on page order alone when every stream was read', () => {
    expect(coverRastersInspected({
      ...LOT_208, pageOrderAuthoritative: false, objectStreamsUnread: 0,
    })).toBe(true);
  });

  it('refuses when no cover page was named at all', () => {
    expect(coverRastersInspected({ ...LOT_208, coverPages: [] })).toBe(false);
  });

  it('refuses when the decoded assets are on pages that are not the cover', () => {
    expect(coverRastersInspected({ ...LOT_208, assets: [{ page: 4 }] })).toBe(false);
  });

  it('refuses an asset whose page is unknown', () => {
    expect(coverRastersInspected({ ...LOT_208, assets: [{}] })).toBe(false);
  });
});

describe('a text-free failed raster decode keeps the full generic allowance', () => {
  /**
   * The end of the same argument, stated as a budget rather than a predicate.
   * A text-free document whose decode produced nothing answers `unreachable`
   * with NO code, so it walks the six-attempt path exactly as a sign-in wall
   * does — it must never be one of the two-attempt retirements.
   */
  const textFreeDecodeFailed: Answer = () => ({});

  it('spends the generic budget, not the deterministic one', () => {
    const { elections, stored } = driveBranchToRetirement(textFreeDecodeFailed, 20);
    expect(elections).toBe(MAX_UNREACHABLE_ATTEMPTS + 1);
    expect(elections).not.toBe(MAX_TEXT_FREE_COVER_ATTEMPTS);
    expect(branchTerminal(stored, BRANCH, QUESTION)).toBe(true);
  });

  it('leaves the deterministic counter untouched throughout', () => {
    let record: unknown = null;
    for (let n = 0; n < MAX_UNREACHABLE_ATTEMPTS; n += 1) {
      record = recordUnreachableAttempt(record, QUESTION);
    }
    expect(unreachableSoFar(record, QUESTION)).toBe(MAX_UNREACHABLE_ATTEMPTS);
    expect(textFreeCoverSoFar(record, QUESTION)).toBe(0);
    expect(textFreeCoverExhaustedAfter(record, QUESTION)).toBe(false);
  });
});

describe('the generic allowance is untouched', () => {
  /** (5)-(8) at the budget level: every uncoded refusal still gets six. */
  it('still spends the full generic allowance on an uncoded refusal', () => {
    const { elections, stored } = driveBranchToRetirement(generic, 20);
    // Seven, because the generic path checks the STORED count — the known
    // finding this change deliberately does not touch.
    expect(elections).toBe(MAX_UNREACHABLE_ATTEMPTS + 1);
    expect(branchTerminal(stored, BRANCH, QUESTION)).toBe(true);
  });

  /** (12) The three budgets are what they were. */
  it('leaves every existing budget constant where it was', () => {
    expect(MAX_UNREACHABLE_ATTEMPTS).toBe(6);
    expect(MAX_PACKAGE_ATTEMPTS).toBe(4);
    expect(MAX_TEXT_FREE_COVER_ATTEMPTS).toBe(2);
  });
});

describe('the two counters cannot spend each other', () => {
  /**
   * (9), and the exact sequence the brief names: a transient failure first,
   * then two deterministic refusals, must retire on the SECOND deterministic
   * one with the generic failure contributing nothing.
   */
  it('retires on the second deterministic refusal after an earlier transient one', () => {
    let stored: unknown = null;
    let elections = 0;
    const answers: Answer[] = [generic, deterministic, deterministic, deterministic];
    for (const answer of answers) {
      if (branchTerminal(stored, BRANCH, QUESTION)) break;
      const before = (stored as { branches?: Record<string, unknown> } | null)
        ?.branches?.[BRANCH.url] ?? null;
      elections += 1;
      const outcome = answer();
      stored = writeBranchState(stored, BRANCH.url,
        outcome.reason === TEXT_FREE_COVER_NOT_ELECTED
          ? (textFreeCoverExhaustedAfter(before, QUESTION)
            ? recordPackageTextFreeCover(QUESTION)
            : recordTextFreeCoverAttempt(before, QUESTION))
          : (unreachableAttemptsExhausted(before, QUESTION)
            ? recordPackageUnreachable(QUESTION)
            : recordUnreachableAttempt(before, QUESTION)));
    }
    // One transient + two deterministic. The fourth answer is never asked for.
    expect(elections).toBe(3);
    expect(branchTerminal(stored, BRANCH, QUESTION)).toBe(true);
  });

  it('a transient failure does not advance the deterministic count', () => {
    const after = recordUnreachableAttempt(null, QUESTION);
    expect(unreachableSoFar(after, QUESTION)).toBe(1);
    expect(textFreeCoverSoFar(after, QUESTION)).toBe(0);
  });

  it('a deterministic refusal does not advance the generic count', () => {
    const after = recordTextFreeCoverAttempt(null, QUESTION);
    expect(textFreeCoverSoFar(after, QUESTION)).toBe(1);
    expect(unreachableSoFar(after, QUESTION)).toBe(0);
  });

  it('carries each count across the other kind of failure', () => {
    const deterministicOnce = recordTextFreeCoverAttempt(null, QUESTION);
    const thenTransient = recordUnreachableAttempt(deterministicOnce, QUESTION);
    expect(textFreeCoverSoFar(thenTransient, QUESTION)).toBe(1);
    expect(unreachableSoFar(thenTransient, QUESTION)).toBe(1);
  });

  /**
   * The pre-election claim record is written BEFORE every attempt and
   * overwritten by the verdict. Dropping either count here would silently
   * reset it on every lap and no budget could ever be reached — the exact
   * defect `provenanceAfterAttempt` records for the kill counter.
   */
  it('carries both counts through the record written before an election', () => {
    const both = recordUnreachableAttempt(recordTextFreeCoverAttempt(null, QUESTION), QUESTION);
    const claim = recordPackageAttempt(both, QUESTION);
    expect(textFreeCoverSoFar(claim, QUESTION)).toBe(1);
    expect(unreachableSoFar(claim, QUESTION)).toBe(1);
    expect(attemptsSoFar(claim, QUESTION)).toBe(1);
  });

  /** A deterministic refusal destroyed no worker, so the kill count is clear. */
  it('never pushes a document towards the resource-limit retirement', () => {
    const after = recordTextFreeCoverAttempt(
      recordPackageAttempt(null, QUESTION), QUESTION);
    expect(attemptsSoFar(after, QUESTION)).toBe(0);
  });
});

describe('the question identity decides when it may be asked again', () => {
  /** (10) A bumped extractor is a new question and starts from zero. */
  it('reopens the deterministic question on a provenance bump', () => {
    const spent = writeBranchState(null, BRANCH.url, recordPackageTextFreeCover(QUESTION));
    expect(branchTerminal(spent, BRANCH, QUESTION)).toBe(true);
    const bumped = { ...QUESTION, provenanceVersion: QUESTION.provenanceVersion + 1 };
    expect(branchTerminal(spent, BRANCH, bumped)).toBe(false);
    expect(textFreeCoverSoFar(recordTextFreeCoverAttempt(null, QUESTION), bumped)).toBe(0);
  });

  it('starts from zero for a different package or a different source row', () => {
    const one = recordTextFreeCoverAttempt(null, QUESTION);
    expect(textFreeCoverSoFar(one, { ...QUESTION, packageReference: 'https://other' })).toBe(0);
    expect(textFreeCoverSoFar(one, { ...QUESTION, sourceAnchor: 'notion:other' })).toBe(0);
  });

  /**
   * A runtime bump must NOT reopen it. A better worker does not make a drawn
   * page carry text, so re-chasing these on every deploy is a treadmill —
   * the same asymmetry `recordPackageUnreachable` already embodies.
   */
  it('is not reopened by a runtime bump', () => {
    const spent = writeBranchState(null, BRANCH.url, recordPackageTextFreeCover(QUESTION));
    const newer = { ...QUESTION, runtimeVersion: RUNTIME_VERSION + 1 };
    expect(branchTerminal(spent, BRANCH, newer)).toBe(true);
    const one = recordTextFreeCoverAttempt(null, QUESTION);
    expect(textFreeCoverSoFar(one, newer)).toBe(1);
  });
});

describe('the terminal record says what happened and claims nothing more', () => {
  const terminal = recordPackageTextFreeCover(QUESTION);

  /** (11) The word that decides whether the online fallback may be bought. */
  it('retires as operational, never as an inspection of the document', () => {
    expect(terminal.exhaustion).toBe('operational');
    expect(terminal.result).toBe(NO_DETERMINISTIC_IMAGE);
  });

  /**
   * (12) And the fallback reads it exactly as it reads the dead-link
   * retirement — asserted through the real reader rather than by trusting
   * the field, because that reader is the one consumer of `exhaustion`.
   */
  it('is classified identically to the existing operational retirement', () => {
    const mine = writeBranchState(null, BRANCH.url, terminal);
    const theirs = writeBranchState(null, BRANCH.url, recordPackageUnreachable(QUESTION));
    expect(classifyBranchRecord(mine, BRANCH, QUESTION)).toBe('operational');
    expect(classifyBranchRecord(mine, BRANCH, QUESTION))
      .toBe(classifyBranchRecord(theirs, BRANCH, QUESTION));
  });

  /**
   * IT MUST NOT READ AS "THE BROCHURE HAS NO PHOTOGRAPH". Nothing in the
   * document was ever read — its pages carry no extractable text — so the
   * sentence an operator sees has to be about this reader's reach.
   */
  it('says the limit is ours and not the document’s', () => {
    expect(terminal.detail).toContain('limit of what this reader can extract');
    // Every mention of an absent photograph must sit inside the disclaimer.
    expect(terminal.detail).toContain('not a finding that the document holds no photograph');
    expect(terminal.detail.replace('not a finding that the document holds no photograph', ''))
      .not.toMatch(/holds no photograph|contains no photograph/);
  });

  /** A better worker cannot help, so it carries no runtime stamp to reopen on. */
  it('carries no runtime stamp', () => {
    expect(terminal.runtime_version).toBeUndefined();
  });
});

describe('the code travels on the wire and is never invented on this side', () => {
  const CONTEXT = {
    label: 'Lot 208, 46 Satinwood Crescent Donnybrook',
    identifiedBy: 'folder_structure' as const,
    design: null,
    identityHints: ['Peppercorn Hill'],
    documentName: 'Lot 208, 46 Satinwood Crescent Donnybrook VIC_Package.pdf',
    url: 'https://drive.google.com/uc?export=download&id=abc',
  };
  const ROUTE = {
    kind: 'worker' as const,
    endpoint: 'https://pdf.example.workers.dev',
    token: 'tok',
  };
  const SOME_PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** The protocol this unconfirmed election is asked in, and so answered in. */
  const ASKED = electionProtocolFor(CONTEXT);
  const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' },
  });
  const run = () => runElectionOnRoute(SOME_PDF, readPdfPageTextResult, CONTEXT, ROUTE);

  it('relays the code when the worker earned it by reading the document', async () => {
    fetchMock.mockResolvedValue(reply({
      protocol: ASKED,
      status: 'unreachable',
      reason: TEXT_FREE_COVER_NOT_ELECTED,
      detail: 'That document’s pages carry no extractable text and its first page '
        + 'presents no single photograph, so it could not be read.',
    }));
    const outcome = await run();
    expect(outcome.status).toBe('unreachable');
    expect((outcome as { reason?: string }).reason).toBe(TEXT_FREE_COVER_NOT_ELECTED);
  });

  /**
   * (5)-(8). Every one of these is a way the pipeline reaches `unreachable`
   * WITHOUT the worker having read a document, and each must keep the six.
   * A code appearing on any of them would shorten a transient failure's
   * budget, which is the one way this change could do harm.
   */
  it.each([
    ['the origin could not be reached', () => fetchMock.mockRejectedValue(new Error('ECONNRESET'))],
    ['the document answered 404', () => fetchMock.mockResolvedValue(reply({ error: 'nope' }, 404))],
    ['a sign-in wall answered', () => fetchMock.mockResolvedValue(reply({ error: 'unauthorised' }, 401))],
    ['the origin rate-limited us', () => fetchMock.mockResolvedValue(reply({ error: 'slow down' }, 429))],
    ['the origin failed', () => fetchMock.mockResolvedValue(reply({ error: 'bad gateway' }, 502))],
    ['the worker is unconfigured', () => fetchMock.mockResolvedValue(
      reply({ error: 'worker_token_not_configured' }, 503))],
    ['the answer is not JSON', () => fetchMock.mockResolvedValue(
      new Response('<html>502</html>', { status: 200 }))],
    ['the answer speaks another protocol', () => fetchMock.mockResolvedValue(reply({
      protocol: PDF_ELECTION_PROTOCOL + 1, status: 'unreachable',
      reason: TEXT_FREE_COVER_NOT_ELECTED, detail: 'x',
    }))],
    ['the answer is an outcome we do not know', () => fetchMock.mockResolvedValue(
      reply({ protocol: ASKED, status: 'elected_probably' }))],
  ])('carries no code when %s', async (_name, arrange) => {
    arrange();
    const outcome = await run();
    expect(outcome.status).toBe('unreachable');
    expect((outcome as { reason?: string }).reason).toBeUndefined();
  });

  /**
   * A worker running ahead of this build must not be able to introduce a
   * budget this build has never heard of.
   */
  it('ignores a refusal code it does not recognise', async () => {
    fetchMock.mockResolvedValue(reply({
      protocol: ASKED, status: 'unreachable',
      reason: 'some_future_reason', detail: 'x',
    }));
    const outcome = await run();
    expect(outcome.status).toBe('unreachable');
    expect((outcome as { reason?: string }).reason).toBeUndefined();
  });

  /** The code belongs to `unreachable`. It may not ride a banked verdict. */
  it('does not attach the code to a not_identified verdict', async () => {
    fetchMock.mockResolvedValue(reply({
      protocol: ASKED, status: 'not_identified',
      reason: TEXT_FREE_COVER_NOT_ELECTED, detail: 'names no image',
    }));
    const outcome = await run();
    expect(outcome.status).toBe('not_identified');
    expect((outcome as { reason?: string }).reason).toBeUndefined();
  });

  it('recognises exactly one code and nothing else', () => {
    expect(isElectionRefusalReason(TEXT_FREE_COVER_NOT_ELECTED)).toBe(true);
    for (const other of ['', 'unreachable', 'not_identified', null, undefined, 0, {}]) {
      expect(isElectionRefusalReason(other)).toBe(false);
    }
  });
});

describe('the settler reads the code, not the sentence', () => {
  /**
   * (12), and the rule that keeps the fix honest. A `detail` match would pass
   * every behavioural test in this file and break the first time somebody
   * reworded the message for an operator, so the source is asserted directly.
   */
  it('dispatches on the constant and never on the refusal prose', () => {
    const source = readSource('repairSourceImages.ts');
    expect(source).toContain('recovered.reason === TEXT_FREE_COVER_NOT_ELECTED');
    expect(source).not.toMatch(/recovered\.detail\s*(===|\.includes|\.match|\.startsWith)/);
  });

  /**
   * (3) and (4) are properties of the ELECTION rather than of the budget, and
   * they are proved where this repository proves elections: the worker canary
   * runs the real shared election over real documents. Asserted here only as
   * the structural condition, so a refactor cannot quietly widen the code to
   * a document whose text WAS read or whose cover was never inspected.
   */
  it('mints the code only for a text-free document whose cover was inspected', () => {
    const source = readSource('pdfElection.ts');
    // Exactly one MINT — counted as a value assignment, so the constant may
    // still be named in prose without weakening the assertion.
    expect(source.match(/reason: TEXT_FREE_COVER_NOT_ELECTED/g)?.length).toBe(1);
    // And it is gated on the PREDICATE, never on `coverPages` alone — which
    // is the whole correctness question this rule exists to answer.
    expect(source).toContain('if (coverRastersInspected(selection)) {');
    expect(source).not.toMatch(/coverPages\??\.length[^\n]*\?\s*\{\s*reason/);
    // The early return — the one taken when the document was NOT tied to this
    // property by its folder — must stay uncoded, on the generic allowance.
    const early = source.indexOf('if (textFree && identifiedBy !== \'folder_structure\')');
    const mint = source.indexOf('if (coverRastersInspected(selection)) {');
    expect(early).toBeGreaterThan(-1);
    expect(mint).toBeGreaterThan(early);
    expect(source.slice(early, source.indexOf('}', early) + 1))
      .not.toContain('TEXT_FREE_COVER_NOT_ELECTED');
  });
});
