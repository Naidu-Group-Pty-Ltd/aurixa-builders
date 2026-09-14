/**
 * Browser mirror of the partner matter index.
 *
 * The implementation lives in `supabase/functions/_shared/aml/` — the same
 * file the edge function's own reasoning is built on — so what the server
 * discloses and what the list renders cannot drift. The browser never decides
 * whether a matter's customer may be NAMED: `subject_label` is simply absent
 * from the response for a matter whose Passport is withheld.
 */
export {
  partnerMatterIndex,
  roleWords,
  type MatterIndexReading,
  type MatterLinkInput,
  type MatterPassportState,
  type MatterRow,
} from "../../../supabase/functions/_shared/aml/partnerMatterIndex.pure";
