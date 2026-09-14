/**
 * Browser mirror of the partner surface rules.
 *
 * The implementation lives in `supabase/functions/_shared/aml/` — the same
 * file the edge function executes — so the mode the server decides and the
 * page the browser draws cannot drift. The browser NEVER derives a mode of
 * its own: `surface_mode` arrives on the server's response and this module
 * only turns it into a panel list.
 */
export {
  partnerSurfaceMode,
  partnerWorkspacePanels,
  passportDisclosure,
  type PartnerAdapterPanels,
  type PartnerPanelVisibility,
  type PartnerSurfaceFlags,
  type PartnerSurfaceMode,
  type PassportDisclosure,
  type PassportDisclosureCode,
  type PassportDisclosureFacts,
} from "../../../supabase/functions/_shared/aml/partnerSurface.pure";
