/**
 * The struck impression, as the approved design draws it.
 *
 * Transcribed from `stampFace()` in `AML Compliance Passport.dc.html`
 * (Claude Design project `a663070e-…`). A stamp there is FIVE layers, and the
 * face this replaces had one — which is why it read as a coloured box rather
 * than as something pressed into the page:
 *
 *   face        shape, rule, inset shadows, gradient wash, rotation, glow
 *   grain       two ±38° hatchings under `mix-blend-mode: overlay`
 *   tick        conic ticks around a circle, hairline rules on a rect
 *   inner       a dashed inner ring
 *   watermark   the Aurixa emblem, screened at 26% through the face
 *
 * The watermark is the layer the design is built around and the one that was
 * absent altogether: every impression carries the mark of the system that
 * struck it.
 *
 * The geometry lives in `passport-tokens.css`; nothing here carries a colour.
 * The two things this component decides are per-stamp and derived: which of
 * the seven inks the impression takes (`stampInk` — authority first, then
 * what the certification is ABOUT) and its angle (`stampRotation` — fixed by
 * position, because a random one would move on every render).
 *
 * `StampSeal` is deliberately NOT replaced. It still draws the partner
 * compliance strip, which is a different, already-shipped surface with no
 * entry in this design; restyling it as a side effect of the Passport page is
 * exactly the unrelated regression this programme keeps being asked to avoid.
 */
import type { CSSProperties } from "react";
import {
  stampInk,
  stampRotation,
  type PassportStamp,
  type PendingStamp,
} from "@/lib/aml/passport";
import { cn } from "@/lib/utils";
import { formatStampStruck } from "../format";

/**
 * The emblem, at 240px rather than the 700px original.
 *
 * It is a MASK now, not a picture, and a mask needs a silhouette rather than
 * detail: 240px covers the largest die at more than twice its drawn size, for
 * 78KB instead of 482KB. The same file, for the same reason, that the
 * submission record already chose.
 */
const EMBLEM = "/brand/aurixa-emblem-240.png";

/** The design steps a long title down so it still fits the die. */
const LONG_TITLE = 22;

/**
 * The same treatment for the issuer line, and it is NOT cosmetic.
 *
 * The design's own issuer is "AURIXA SYSTEMS" — fourteen characters — and its
 * org line is set nowrap at 6.8px on 0.2em tracking with a rule either side.
 * A tenant name is whatever the operator typed: "Naidu Property Consulting
 * Services" is thirty-four, which measures ~200px against a 164px die, so the
 * line and its rules ran clean across the neighbouring impressions on the
 * register — and would now do the same on a client's Passport. The name is the
 * one thing on a stamp that may not be abbreviated, so a long one steps down
 * and is allowed a second line rather than being truncated.
 */
const LONG_ORG = 18;

function Inscription({
  org, title, date, sub,
}: {
  org: string;
  title: string;
  date: string;
  sub: string | null;
}) {
  const longOrg = org.length > LONG_ORG;
  return (
    <div className="passport-stamp__body">
      <div className={cn("passport-stamp__org", longOrg && "passport-stamp__org--long")}>
        <span aria-hidden="true" />
        <span
          className={cn(
            "passport-stamp__orgname",
            longOrg && "passport-stamp__orgname--long",
          )}
        >
          {org}
        </span>
        <span aria-hidden="true" />
      </div>
      <div
        className={cn(
          "passport-stamp__title",
          title.length > LONG_TITLE && "passport-stamp__title--long",
        )}
      >
        {title}
      </div>
      <div className="passport-stamp__rule" aria-hidden="true">
        <span />
        <span className="passport-stamp__diamond">◆</span>
        <span />
      </div>
      <div className="passport-stamp__date">{date}</div>
      {sub && <div className="passport-stamp__sub">{sub}</div>}
    </div>
  );
}

/**
 * The decorative layers, shared by struck and unstruck faces.
 *
 * ── Why the watermark is a MASK and no longer an image ────────────────
 * It was an `<img>` of the emblem laid over the die under
 * `mix-blend-mode: screen`, and it was invisible on both surfaces for two
 * different reasons. `screen` LIGHTENS, so on the booklet's cream leaf it
 * pushed a near-white surface to white and erased the mark outright; a later
 * fix swapped the leaf to `multiply` at 0.15, which is fainter than the
 * paper's own texture. And on the dark register it screened a dark artwork
 * over a dark field, which lifts almost nothing. The layer the whole design
 * is built around was, in practice, never on screen.
 *
 * A real stamp is ONE ink. So the emblem is now the mask and the ink is the
 * fill: the watermark takes `--stamp-ink`, the same colour as the lettering
 * of the impression it sits inside. That is why it survives both surfaces
 * without a blend mode to get wrong — gold on the dark register, the same
 * gold darkened for paper on the leaf — and why it cannot be erased again by
 * a change of background.
 *
 * The source rides as an inline custom property rather than living in the
 * stylesheet, so the asset a die is struck with stays visible in this file
 * and assertable from a test.
 */
function Layers({ watermark }: { watermark: boolean }) {
  return (
    <>
      <span aria-hidden="true" className="passport-stamp__grain" />
      <span aria-hidden="true" className="passport-stamp__burnish" />
      <span aria-hidden="true" className="passport-stamp__tick" />
      <span aria-hidden="true" className="passport-stamp__inner" />
      {watermark && (
        <span
          aria-hidden="true"
          className="passport-stamp__watermark"
          data-emblem={EMBLEM}
          style={{ "--stamp-watermark-src": `url("${EMBLEM}")` } as CSSProperties}
        />
      )}
    </>
  );
}

export function StampFace({
  stamp, issuerOrg, index = 0, upright = false, className,
}: {
  stamp: PassportStamp;
  /** Decides the partner ink: a stamp that speaks for somebody else. */
  issuerOrg: string;
  /** Position in the register — fixes the angle. */
  index?: number;
  /**
   * Presented on its own rather than struck into a register.
   *
   * The angle exists because a register of impressions pressed by hand is not
   * a grid. A single die shown as the SPECIMEN of one record — the dialog
   * behind a stamp — is not a register, and tilting it there reads as a
   * misaligned dialog rather than as a stamp.
   */
  upright?: boolean;
  className?: string;
}) {
  const ink = stampInk(stamp, issuerOrg);
  const sub = [stamp.version ? `v${stamp.version}` : null, stamp.actor]
    .filter(Boolean)
    .join(" · ");
  return (
    <div
      className={cn(
        "passport-stamp",
        `passport-stamp--${ink}`,
        `passport-stamp--${stamp.shape}`,
        className,
      )}
      style={{ "--stamp-rot": `${upright ? 0 : stampRotation(index)}deg` } as CSSProperties}
    >
      <Layers watermark />
      <Inscription
        org={stamp.org}
        title={stamp.title}
        date={formatStampStruck(stamp.at)}
        sub={sub || null}
      />
    </div>
  );
}

/**
 * The same die, never struck.
 *
 * No ink in the field, no watermark, no rotation — an unstruck die was never
 * pressed. The accessible name says so in words, because a dashed border is
 * not a distinction a screen reader can hear, and there is nothing to open so
 * it is not a button.
 */
export function PendingStampFace({
  stamp, className,
}: {
  stamp: PendingStamp;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "passport-stamp passport-stamp--pending",
        `passport-stamp--${stamp.shape}`,
        className,
      )}
      role="img"
      aria-label={`${stamp.title} — not yet earned. ${stamp.awaiting}`}
    >
      <Layers watermark={false} />
      <div aria-hidden="true">
        <Inscription
          org={stamp.org ?? "AWAITING"}
          title={stamp.title}
          date={stamp.expected_at ? formatStampStruck(stamp.expected_at) : "NOT YET EARNED"}
          sub={null}
        />
      </div>
    </div>
  );
}
