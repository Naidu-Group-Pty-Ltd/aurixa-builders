/**
 * BUILDER STOCK — "HAVE WE FINISHED LOOKING AT WHAT THE BUILDER SUPPLIED?"
 *
 * ONE AUTHORITATIVE ANSWER, ASKED BEFORE THE ONLINE FALLBACK MAY SPEND
 * ANYTHING. The stock list is the source of truth: the builder has usually
 * already handed the marketing material over, as a hyperlink behind the word
 * `Brochure`, as a Dropbox package, as a Drive folder, as a direct image. The
 * external search ladder exists for the rows where they genuinely have not,
 * and it may only run once that is a FACT rather than a guess.
 *
 *
 * WHAT WAS WRONG, AND WHY IT WAS INVISIBLE.
 *
 * The gate used to be the STAGE ORDER alone — `source` runs before `fallback`,
 * therefore source is finished. That is a statement about the scheduler, not
 * about the evidence. `settleClaimedItem` advanced a property the moment its
 * source run RETURNED, whatever the run had actually learned, so a property
 * whose brochure had never been opened reached the ladder exactly like one
 * whose brochure had been read cover to cover.
 *
 * Underneath it, a second and worse collapse: this repository has exactly one
 * negative result, `no_deterministic_image`, and THREE different things wrote
 * it.
 *
 *   1  We opened the document, read it, and it names no image for this
 *      property. That is knowledge.
 *
 *   2  This package destroyed the worker twice — `CPU Time exceeded`,
 *      `Memory limit exceeded` — so it was retired. See
 *      `recordPackageUnprocessable`.
 *
 *   3  This link answered six times with nothing we could read — a 404, a
 *      sign-in wall, a scan with no text layer. See
 *      `recordPackageUnreachable`.
 *
 * Only the first is a fact about the property. The other two are facts about
 * US, and both were being recorded in the same word — so a builder's brochure
 * that was too big to open read, downstream, as a builder who supplied
 * nothing, and the ladder went looking for the house on the open internet.
 *
 * MEASURED, 2 SEPTEMBER 2026, the live Luxton list. Lot 516 (10.6 MB) and Lot
 * 6706 (13.2 MB) both sat at `attempts: 2` — one tick from being retired as
 * "no image" — while their brochures state the lot, the street, the price and
 * the land size in AcroForm fields, and both extract in under 400 ms once the
 * decode is scoped. Lot 818's brochure had been refused before it was ever
 * fetched (the old Drive-only front door), the ladder ran, and the card was
 * given a render from a page titled `lot-118-by-simonds-homes` — a different
 * lot, by a different builder.
 *
 *
 * THE RULE: TIMEOUT IS NOT EXHAUSTION.
 *
 * A worker kill, an HTTP 5xx, a rate limit, a redirect that never resolved, a
 * database read that failed — none of them is "we looked and there was
 * nothing". They are `retryable_failure`, the ladder stays shut, and the card
 * stays BLANK with a reason an engineer can read. A correct blank beats a
 * plausible photograph of somebody else's house, and that asymmetry is the
 * whole posture of this subsystem.
 *
 * WHAT STOPS IT PINNING A PROPERTY FOR EVER is not this module — it is the
 * attempt budgets that run before retirement (`MAX_PACKAGE_ATTEMPTS`,
 * `MAX_UNREACHABLE_ATTEMPTS`) and the provenance VERSION, which is keyed into
 * every branch record. A reader that grows a new capability ships a version
 * bump, every operational retirement at the old version stops standing, and
 * the question is asked again from zero. That is the designed way out, and it
 * is the only one: nothing here may be repaired by editing a row.
 *
 * Pure: no IO, no clock, no network.
 */
import {
  NO_DETERMINISTIC_IMAGE, negativeProvenanceStillStands,
  type ProvenanceQuestion,
} from './negativeProvenance.pure.ts';
import {
  attemptsSoFar, PACKAGE_RECOVERY_ATTEMPT, packageAttemptsExhausted,
} from './packageAttempt.pure.ts';
import {
  branchQuestion, branchRecord, isTraversableBranch, rowSourceBranches,
  unmappedWithRecoveredLinks, type RowSourceBranch,
} from './sourceBranches.pure.ts';

/**
 * WHY A BRANCH IS FINISHED — the distinction the single verdict word lost.
 *
 * `inspected` is a statement about the DOCUMENT: we opened it and it names no
 * image for this property. `operational` is a statement about US: we could not
 * open it, or opening it destroyed the worker.
 */
export type EvidenceExhaustion = 'inspected' | 'operational';

/**
 * How far this property's supplied evidence has got.
 *
 * `no_evidence` is deliberately its own reading rather than a flavour of
 * `exhausted`: "the builder supplied nothing to look at" and "we looked at
 * everything the builder supplied" are different sentences to an operator,
 * they arise from different defects, and only the second is ever surprising.
 * Both admit the ladder.
 */
export type SuppliedEvidenceState =
  /** The row names no source this pipeline can traverse. */
  | 'no_evidence'
  /** Sources exist and at least one has never been opened. */
  | 'pending'
  /** An attempt is in flight — the claim is written and has not returned. */
  | 'processing'
  /** A builder-supplied image has been accepted for this property. */
  | 'found'
  /** Every source was OPENED and READ, and none names an image for this row. */
  | 'exhausted'
  /** At least one source ended on a fault of ours rather than an answer. */
  | 'retryable_failure';

export interface SuppliedEvidenceReading {
  state: SuppliedEvidenceState;
  /** Every traversable source this row names. */
  total: number;
  /** Those successfully opened and read, which named nothing for this row. */
  inspected: number;
  /** Those retired on a fault of ours. Never counted as exhaustion. */
  operational: number;
  /** Those still owed a look. */
  open: number;
  /**
   * Safe to log and to store on the row: why the state is what it is. Never a
   * stack, never a credential, never a signed URL.
   */
  detail: string;
}

/**
 * WHAT THE IMPORT MANAGED TO SEE OF THIS ROW'S LINKS — stamped on the row.
 *
 * THE HOLE THIS CLOSES. A branch is a URL found ON the row, so "no branches"
 * used to mean `no_evidence` — the builder supplied nothing, run the ladder.
 * But there is a second way a row ends up with no URLs: the SPREADSHEET
 * carries them and we could not get them out. The live VG master list is the
 * measured case — every `export?format=…` answers 401, `gviz` serves values
 * only, and before the htmlview reader existed all fifty-six of its document
 * links vanished at the door. Every one of its fourteen properties then read
 * as a builder who supplied nothing, and the external ladder was bought
 * against a stock list whose brochures were sitting in plain sight.
 *
 * OUR FAILURE IS NOT NO EVIDENCE. So the import now writes down, per row,
 * whether the row's link layer was actually enumerable — and a row whose
 * links could not be enumerated can never read as `exhausted` or
 * `no_evidence`, however empty it looks. It reads `retryable_failure`: the
 * ladder stays shut, the card stays blank, and the way in is fixing our
 * reader (a new import stamps the rows afresh) rather than papering the card
 * with somebody else's photograph.
 *
 * A ROW WITH NO STAMP IS A ROW WRITTEN BEFORE THE STAMP EXISTED — or by an
 * adapter whose links are native to its own bytes (an uploaded workbook, a
 * literal CSV, a PDF, a Notion record map, all of which carry their links IN
 * the parsed content). Those rows keep the reading they always had.
 */
export interface RowLinkDiscovery {
  /** `complete`: the row's link layer was read (or genuinely has none). */
  state: 'complete' | 'unavailable';
  /** How the links were (or would have been) read. Provenance, not behaviour. */
  method?: string;
  /** The availability word, when unavailable. Safe to store and to log. */
  reason?: string;
}

/**
 * The stamp for rows imported from a SPREADSHEET SOURCE, from what the fetch
 * managed. `resolved` and `none_present` are readings of the spreadsheet —
 * the links are on the rows, or the tab genuinely has none — and everything
 * else is a reading of our access to it, which no row may mistake for an
 * empty source.
 */
export function linkDiscoveryFromAvailability(
  availability: string | null | undefined,
  method?: string | null,
): RowLinkDiscovery | null {
  if (!availability) return null;
  if (availability === 'resolved' || availability === 'none_present') {
    return { state: 'complete', method: method ?? 'workbook_export' };
  }
  return { state: 'unavailable', reason: availability };
}

/** The stamp as the stored row carries it, however old the row. */
export function readLinkDiscovery(sourceRow: unknown): RowLinkDiscovery | null {
  const row = (sourceRow ?? null) as Record<string, unknown> | null;
  const stamp = row?.link_discovery as Record<string, unknown> | undefined;
  if (!stamp || typeof stamp !== 'object') return null;
  const state = stamp.state === 'unavailable' ? 'unavailable' : 'complete';
  return {
    state,
    method: typeof stamp.method === 'string' ? stamp.method : undefined,
    reason: typeof stamp.reason === 'string' ? stamp.reason : undefined,
  };
}

export interface SuppliedEvidenceInput {
  /** Every traversable source the row names, from `rowSourceBranches`. */
  branches: readonly RowSourceBranch[];
  /** The property's `source_provenance_result`, whatever shape it holds. */
  stored: unknown;
  provenanceVersion: number;
  /**
   * The runtime asking now — compared only against a stored
   * `runtime_version`, which only OUR OWN failures carry. Without it this
   * reader would go on treating a branch the settler is about to re-ask as
   * a closed answer, and the two would disagree on screen.
   */
  runtimeVersion?: number;
  sourceAnchor: string | null;
  /**
   * Whether a builder-supplied image has already been accepted for this
   * property. Passed in rather than derived, because "is there a picture" is a
   * question about `builder_stock_item_images` and this module reads no rows.
   */
  builderImageAccepted?: boolean;
  /** What the import managed to see of this row's link layer. */
  linkDiscovery?: RowLinkDiscovery | null;
}

/**
 * How one branch's stored record classifies.
 *
 * ANYTHING UNRECOGNISED IS `open`, NOT FINISHED. A record from a different
 * question — another provenance version, another anchor — answers something
 * else and says nothing about this one; a record whose shape this does not
 * know is a record this code may not interpret. Both mean "ask again", which
 * costs a fetch. The opposite mistake costs a client a photograph of the
 * wrong house.
 */
export function classifyBranchRecord(
  stored: unknown,
  branch: RowSourceBranch,
  question: ProvenanceQuestion,
): 'open' | 'in_flight' | EvidenceExhaustion {
  /*
   * A BRANCH NOTHING CAN TRAVERSE IS INSPECTED, NOT FAILED — and that is a
   * judgement about the URL, reached without a fetch and without a clock. It
   * cannot become true or false while the code stands still, so it is exactly
   * as final as a document we read: what changes it is a reader that learns
   * the format, which ships as a provenance bump and reopens it.
   */
  if (!isTraversableBranch(branch)) return 'inspected';

  const record = branchRecord(stored, branch.url) as Record<string, unknown> | null;
  if (!record) return 'open';
  if (Number(record.provenance_version) !== question.provenanceVersion) return 'open';
  if ((record.source_anchor ?? null) !== (question.sourceAnchor ?? null)) return 'open';

  if (record.result === NO_DETERMINISTIC_IMAGE) {
    /*
     * FIRST, WHETHER IT IS STILL AN ANSWER AT ALL. A retirement OUR OWN worker
     * caused carries the runtime that caused it, and a better runtime has to
     * ask again — the same rule `branchTerminal` applies, read from the same
     * module, because this reader and the settler disagreeing about one
     * property is precisely the screen the operator was shown: a branch the
     * queue had reopened, reported as four of four sources that could not be
     * read. A document's own answer and a dead link carry no stamp and fall
     * straight through.
     */
    if (!negativeProvenanceStillStands(record, question)) return 'open';

    /*
     * THE DISCRIMINATOR, AND WHY AN ABSENT ONE IS `operational`.
     *
     * Records written before this field existed cannot say which of the three
     * writers produced them, and the safe reading of "we do not know" is the
     * one that keeps the ladder shut. It is not a cliff: `PROVENANCE_VERSION`
     * rises in the same change, so no legacy record is being asked this
     * question in the first place — the field is checked for the record a
     * ROLLBACK would leave behind, and for that record a blank card that
     * re-reads is the right outcome.
     */
    return record.exhaustion === 'inspected' ? 'inspected' : 'operational';
  }

  if (record.result === PACKAGE_RECOVERY_ATTEMPT) {
    /*
     * A SURVIVING ATTEMPT IS A KILLED WORKER — the claim is written before the
     * spend and overwritten by every path that returns, so its presence means
     * the step did not come back. Under budget it is still in flight; past the
     * budget the branch is retired and the retirement is OURS, never the
     * document's.
     */
    if (packageAttemptsExhausted(record, question)) return 'operational';

    /*
     * AND A CLAIM FROM A SUPERSEDED RUNTIME IS NOT IN FLIGHT. Nothing is
     * running: it is the mark of a worker that no longer exists, which is why
     * `attemptsSoFar` answers zero for it. `open` — ask again — is what the
     * settler will do with it, and this reader has to say the same.
     */
    return attemptsSoFar(record, question) > 0 ? 'in_flight' : 'open';
  }

  return 'open';
}

/**
 * The authoritative reading for one property.
 *
 * ORDER MATTERS AND IS DELIBERATE. A found image settles the question before
 * anything else is counted — the builder's own picture is on the card and no
 * ladder may be bought against it. Then "there was nothing to look at". Then
 * anything still owed a look, because one unfinished branch is enough to
 * refuse. Only with every branch finished does the reason they finished decide
 * between `exhausted` and `retryable_failure`, and a SINGLE operational
 * failure is enough to withhold the ladder however many of its siblings were
 * read properly.
 */
export function readSuppliedEvidence(
  input: SuppliedEvidenceInput,
): SuppliedEvidenceReading {
  if (input.builderImageAccepted) {
    return {
      state: 'found', total: input.branches.length,
      inspected: 0, operational: 0, open: 0,
      detail: 'the builder\'s own picture is on this card',
    };
  }

  const branches = input.branches ?? [];
  /*
   * THE ROW'S LINK LAYER COMES BEFORE THE ROW'S LINKS. A row whose links
   * could not be enumerated has an unknown number of sources, and an unknown
   * number is never zero: whatever the branch arithmetic below would have
   * said, `exhausted` and `no_evidence` are both claims to have SEEN
   * everything, and this row's import is on record saying it did not.
   * `found` still wins above — a picture the builder's own source yielded
   * answers the question however it was found — and open branches (a URL that
   * did survive, or one recovered later) are still worked; they simply can
   * never finish the row while the layer they came from is unread.
   */
  const discovery = input.linkDiscovery ?? null;
  const enumerable = discovery?.state !== 'unavailable';

  if (!branches.length) {
    if (!enumerable) {
      return {
        state: 'retryable_failure', total: 0, inspected: 0, operational: 0, open: 0,
        detail: 'the source carries link cells whose targets could not be read'
          + `${discovery?.reason ? ` (${discovery.reason})` : ''}; `
          + 'this is a fault on our side, not a row that supplied nothing',
      };
    }
    return {
      state: 'no_evidence', total: 0, inspected: 0, operational: 0, open: 0,
      detail: 'this row names no source this pipeline can open',
    };
  }

  let inspected = 0;
  let operational = 0;
  let open = 0;
  let inFlight = 0;
  const failing: string[] = [];

  for (const branch of branches) {
    const verdict = classifyBranchRecord(
      input.stored, branch,
      branchQuestion(
        branch, input.provenanceVersion, input.sourceAnchor, input.runtimeVersion));
    if (verdict === 'inspected') inspected += 1;
    else if (verdict === 'operational') { operational += 1; failing.push(branch.column); }
    else if (verdict === 'in_flight') inFlight += 1;
    else open += 1;
  }

  if (open) {
    return {
      state: 'pending', total: branches.length, inspected, operational, open,
      detail: `${open} of ${branches.length} builder sources have not been opened yet`,
    };
  }
  if (inFlight) {
    return {
      state: 'processing', total: branches.length, inspected, operational, open,
      detail: `${inFlight} of ${branches.length} builder sources are being read`,
    };
  }
  if (operational) {
    return {
      state: 'retryable_failure', total: branches.length, inspected, operational, open,
      detail: `${operational} of ${branches.length} builder sources could not be read `
        + `(${[...new Set(failing)].join(', ').slice(0, 120)}); this is a fault on our side, `
        + 'not a document that names no image',
    };
  }
  if (!enumerable) {
    // Every branch that DID survive was read and names nothing — but the
    // layer they came from was never fully read, so there may be more.
    return {
      state: 'retryable_failure', total: branches.length, inspected, operational, open,
      detail: `${inspected} known builder sources were read and name nothing, but the `
        + 'source\'s link targets could not be fully enumerated'
        + `${discovery?.reason ? ` (${discovery.reason})` : ''}; `
        + 'this is a fault on our side, not an exhausted row',
    };
  }
  return {
    state: 'exhausted', total: branches.length, inspected, operational, open,
    detail: `all ${branches.length} builder sources were read and none names an image `
      + 'for this property',
  };
}

/**
 * MAY THIS PROPERTY ENTER THE ONLINE FALLBACK LADDER?
 *
 * The one predicate, so no caller can hold a different opinion. Three states
 * withhold it and they are the point: `pending`, `processing` and
 * `retryable_failure` are all "we have not finished with what the builder
 * supplied", and nothing external may be spent — or accepted — until we have.
 *
 * `found` is ADMITTED, deliberately. The ladder module is also the owner of
 * the bookkeeping for "this property already holds a displayable picture":
 * `nextImageStage` answers `none`, every paid stage records itself skipped
 * ("Skipped: the builder supplied an image for this property"), nothing is
 * fetched and nothing is bought, and the property's enrichment is marked
 * complete — which is what takes it OUT of the fallback queue. Withholding a
 * `found` property would leave that bookkeeping to a second implementation,
 * and a property parked in the queue for ever is how the cron never retires.
 */
export function fallbackMayRun(state: SuppliedEvidenceState): boolean {
  return state === 'exhausted' || state === 'no_evidence' || state === 'found';
}

/**
 * The whole reading in one line, for the row's `image_work_last_result` and
 * for a structured log.
 *
 * Deliberately short and deliberately free of anything sensitive: it is stored
 * on a column operators read, so it names columns and counts and never a URL,
 * a token or a signed address.
 */
export function describeSuppliedEvidence(reading: SuppliedEvidenceReading): string {
  return `supplied evidence ${reading.state}: ${reading.detail}`;
}

/**
 * The reading, straight off a STORED property row.
 *
 * ONE PLACE THAT KNOWS THE ROW'S SHAPE. The branches come from the row's own
 * link columns overlaid with the separately recovered ones (`unmapped` +
 * `recovered_link_columns` — passing null as the base drops every link that
 * never needed recovery, which is how a gate becomes decorative); the anchor
 * is the one the import stamped; the link-discovery stamp rides beside them.
 * `settleFallbackImages` enforces with this and `settleItemImages` routes with
 * it, and because both call THIS function over the same stored row they
 * cannot disagree about a property.
 */
export function readStoredRowEvidence(input: {
  sourceRow: unknown;
  stored: unknown;
  provenanceVersion: number;
  runtimeVersion?: number;
  builderImageAccepted?: boolean;
}): SuppliedEvidenceReading {
  const row = (input.sourceRow ?? null) as Record<string, unknown> | null;
  const unmapped = (row?.unmapped ?? null) as Record<string, string> | null;
  const anchor = typeof row?.source_anchor === 'string' && row.source_anchor
    ? row.source_anchor : null;
  return readSuppliedEvidence({
    branches: rowSourceBranches(unmappedWithRecoveredLinks(unmapped, row)),
    stored: input.stored,
    provenanceVersion: input.provenanceVersion,
    runtimeVersion: input.runtimeVersion,
    sourceAnchor: anchor,
    builderImageAccepted: input.builderImageAccepted,
    linkDiscovery: readLinkDiscovery(row),
  });
}
