/**
 * Browser mirror of the Compliance Passport projection modules.
 *
 * The implementations live in `supabase/functions/_shared/aml/passport/` —
 * the same files the edge functions execute — so the browser and the server
 * cannot drift: there is exactly one credential format, one state derivation,
 * one stamp vocabulary and one view shape.
 *
 * The browser uses these for TYPES and PRESENTATION only. It never derives a
 * passport state of its own from raw records — every surface renders the
 * state embedded in the server projection. Re-deriving client-side would
 * reintroduce the two-truths bug this architecture exists to prevent.
 */

export {
  passportCredential,
  passportVersionLabel,
  shortFingerprint,
} from '../../../../supabase/functions/_shared/aml/passport/passportCredential.pure';

export {
  derivePassportState,
  refreshRemedy,
  versionRegisterState,
  PASSPORT_STATE_REASONS,
  type PassportRefreshRemedy,
  type PassportAttestationFact,
  type PassportStateCode,
  type PassportStateInput,
  type PassportStateResult,
  type PassportStateTone,
  type PassportVersionState,
} from '../../../../supabase/functions/_shared/aml/passport/passportState.pure';

export {
  STAMP_VOCABULARY,
  clientSafePending,
  clientSafeStamps,
  derivePassportStamps,
  derivePendingStamps,
  stampFaceTone,
  stampInk,
  stampRotation,
  type StampFaceTone,
  type StampInk,
  type PassportStamp,
  type PassportStampCode,
  type PassportStampInput,
  type PassportStampShape,
  type PassportStampTone,
  type PendingStamp,
  type StampProgrammeFacts,
} from '../../../../supabase/functions/_shared/aml/passport/passportStamps.pure';

export {
  assertClientSafe,
  assertPartnerSafe,
  buildPassportView,
  findClientRestrictedKeys,
  findPartnerRestrictedKeys,
  type PassportAudience,
  type PassportCaseFact,
  type PassportClientRequestFact,
  type PassportDocumentFact,
  type PassportEventFact,
  type PassportPartnerFact,
  type PassportTransactionFact,
  type PassportVersionRow,
  type PassportView,
  type PassportViewInput,
} from '../../../../supabase/functions/_shared/aml/passport/passportView.pure';

export {
  IDV_COMPONENTS,
  classifyIdvCheck,
  summariseIdv,
  type IdvCheckFact,
  type IdvComponent,
  type IdvComponentCode,
  type IdvComponentResult,
  type IdvSummary,
} from '../../../../supabase/functions/_shared/aml/passport/passportIdv.pure';

export {
  BOOKLET_ZOOM_STEPS,
  LEAF_H,
  LEAF_W,
  bookletCover,
  bookletGeometry,
  bookletLabel,
  bookletSpreads,
  bookletZoom,
  buildBooklet,
  nextBookletZoom,
  type BookletGeometry,
  type BookletBlock,
  type BookletPage,
  type BookletTone,
  type BookletZoom,
} from '../../../../supabase/functions/_shared/aml/passport/passportBooklet.pure';

export {
  DISTRIBUTION_BLOCKERS,
  DISTRIBUTION_STATES,
  EVIDENCE_CLASSES,
  NEVER_DISCLOSABLE,
  classifyEvidence,
  distributionStateFor,
  evaluateDistribution,
  evaluateDistributionBatch,
  summariseBatch,
  type DistributionBlocker,
  type DistributionCandidate,
  type DistributionContext,
  type DistributionReadiness,
  type DistributionState,
  type EvidenceClass,
  type EvidenceFacts,
  type EvidenceReadiness,
  type ExistingGrantInput,
  type MembershipInput,
  type PassportCurrency,
} from '../../../../supabase/functions/_shared/aml/passport/passportDistribution.pure';

export {
  DISCLOSABLE_CAPTURE_KEY,
  WITHHELD_CAPTURE_KEYS,
  describeIdentityPortrait,
  describeIdentityPortraitSlot,
  identityPortraitObject,
  backfillPending,
  backfillStampFor,
  captureObjectsFor,
  parseBackfillStamp,
  portraitAbsenceNote,
  portraitBackfillCandidate,
  portraitCaption,
  portraitRecoverable,
  readBackfillStamp,
  slotCaption,
  type IdentityDocumentKind,
  type IdentityPortraitDescriptor,
  type IdentityPortraitSlot,
  type PortraitAbsenceReason,
  type PortraitBackfillStamp,
} from '../../../../supabase/functions/_shared/aml/passport/identityPortrait.pure';
