import { useMemo } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { ShieldCheck, FileWarning } from "lucide-react";

import { PassportBook } from "@/components/aml/passport/design/PassportBook";
import { buildBooklet, type PassportView } from "@/lib/aml/passport";

/**
 * The Compliance Passport, inside the partner's own portal.
 *
 * ── Why this is not a new document ────────────────────────────────────
 * The standing requirement is that what a partner holds and what the
 * Command Centre holds are ONE record, so that a partner does not have to
 * repeat customer due diligence they are entitled to rely on. That is a
 * property of having one implementation, not of two implementations
 * agreeing: `buildBooklet` is the Command Centre's own composer, and the
 * `PassportView` it is handed came from `buildCasePassportView(…, "partner")`
 * — the same assembler, behind the same `assertPartnerSafe` boundary, that
 * serves the emailed one-time link.
 *
 * So this component draws. It does not select, filter, relabel or decide.
 * If a page of the booklet should not reach a partner, that is settled by
 * the audience the server built for and never by anything here.
 *
 * ── Why an absent document still renders something ────────────────────
 * A partner can be correctly enrolled, correctly linked to a matter, and
 * still have nothing to read: the grant lapsed, it was withdrawn, the
 * attestation was superseded, or a material change flagged it for refresh.
 * Every one of those is a real answer and the server names it. Drawing
 * nothing at all — which is what an empty area is — would read as a broken
 * page, and a partner would ring about it.
 */
export function PartnerPassportPanel({
  passport, availability,
}: {
  passport: PassportView | null | undefined;
  availability?: { code: string; message: string };
}) {
  const pages = useMemo(() => (passport ? buildBooklet(passport) : []), [passport]);

  if (!passport) {
    // `not_enabled` is not a partner-facing state: the surface simply has no
    // Passport on it, and saying "not enabled" would describe our
    // configuration to somebody outside our organisation.
    if (!availability || availability.code === "not_enabled") return null;
    return (
      <Alert>
        <FileWarning className="h-4 w-4" />
        <AlertTitle className="text-sm">The Compliance Passport is not available</AlertTitle>
        <AlertDescription className="text-xs">
          {availability.message} Your organisation&apos;s own AML/CTF obligations are unaffected —
          you may complete independent customer due diligence at any time.
        </AlertDescription>
      </Alert>
    );
  }

  const header = passport.header;

  return (
    <div className="space-y-3">
      {/* ── where the statutory statement lives now ──────────────────────
          Every partner portal used to open with a standing "Your organisation
          remains responsible" banner, on every state of the page. It was
          removed as unnecessary repetition — a partner reaches this page only
          after signing the written arrangement and giving its acknowledgements
          — so this is the sentence's home: attached to the document it
          qualifies, where a person reading the record reads it too, rather
          than restated as page furniture. */}
      <Alert data-testid="partner-reliance-notice">
        <ShieldCheck className="h-4 w-4" />
        <AlertTitle className="text-sm">
          The issuing organisation&apos;s completed customer due diligence
        </AlertTitle>
        <AlertDescription className="text-xs">
          This is the same record the issuing organisation holds, prepared for partner disclosure:
          the procedures that were <em>performed</em> and their outcomes, never the issuer&apos;s own
          risk assessment. Under your written CDD arrangement (AML/CTF Act Pt&nbsp;2 Div&nbsp;7) you
          may rely on it without re-approaching the customer. Your organisation remains responsible
          for its own AML/CTF compliance.
        </AlertDescription>
      </Alert>

      {/* The same chrome the public link uses, so a partner who has seen one
          recognises the other immediately. */}
      <Card className="glass-panel overflow-hidden p-0">
        <CardContent className="p-0">
          {/* ── how tall the board is, and why it matters ────────────────
              `bookletGeometry` fits the spread to this box: two leaves side
              by side once there is room, and one pixel more of height is one
              pixel more of legible document, up to the 1.15 cap. 78vh was
              chosen when a standing banner sat above it. That banner is gone,
              so the space it held goes here — to the artefact this page
              exists to show, which had twice been reported as too small to
              read. */}
          <div className="passport-scope flex h-[min(84vh,1180px)] min-h-[28rem] flex-col">
            <div className="passport-bookbar flex flex-none flex-wrap items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <div className="passport-display text-sm font-semibold uppercase tracking-[0.12em]">
                  AML/CTF Compliance Passport
                </div>
                <div className="passport-mono passport-faint mt-0.5 truncate text-[10px]">
                  {[
                    header.credential,
                    header.current_version_label,
                    header.last_issued_at
                      ? `Issued ${new Date(header.last_issued_at).toLocaleDateString('en-AU')}`
                      : null,
                  ].filter(Boolean).join("  ·  ")}
                </div>
              </div>
              {header.evidence_fingerprint_short && (
                <span className="passport-mono passport-faint text-[10px]">
                  sha {header.evidence_fingerprint_short}
                </span>
              )}
            </div>
            <PassportBook pages={pages} className="min-h-0 flex-1" />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
