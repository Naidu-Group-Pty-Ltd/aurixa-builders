/**
 * Compliance Passport — design primitives.
 *
 * The vocabulary the approved Claude Design is built from: tone pills, wax
 * seals, page headings, field grids and record rows. Every Passport page is
 * assembled from these rather than styling itself, which is what keeps twelve
 * pages visually identical to one another and cheap to extend to a thirteenth.
 *
 * Colour lives in `src/styles/passport-tokens.css`, never here — see that
 * file's header for why.
 */
import type { CSSProperties, ReactNode } from "react";
import { cn } from "@/lib/utils";

/* ── tone ─────────────────────────────────────────────────────────────── */

/** The design's four record states, plus "not applicable". */
export type PassportTone = "ok" | "info" | "warn" | "bad" | "na";

const TONE_CLASS: Record<PassportTone, string> = {
  ok: "passport-pill--ok",
  info: "passport-pill--info",
  warn: "passport-pill--warn",
  bad: "passport-pill--bad",
  na: "",
};

/** The glyph the design pairs with each tone. Decorative — never the only cue. */
const TONE_GLYPH: Record<PassportTone, string> = {
  ok: "✓",
  info: "◐",
  warn: "!",
  bad: "✕",
  na: "–",
};

export function TonePill({
  tone = "na",
  children,
  glyph = true,
  className,
}: {
  tone?: PassportTone;
  children: ReactNode;
  glyph?: boolean;
  className?: string;
}) {
  return (
    <span className={cn("passport-pill", TONE_CLASS[tone], className)}>
      {glyph && <span aria-hidden="true">{TONE_GLYPH[tone]}</span>}
      {children}
    </span>
  );
}

/* ── wax seal ─────────────────────────────────────────────────────────── */

export type WaxTone = "gold" | "green" | "navy" | "blue" | "red";

/** The same mark, and the same 240px silhouette, the struck die is masked with. */
const WAX_EMBLEM = "/brand/aurixa-emblem-240.png";

/**
 * The embossed seal. `earned={false}` renders the *impression* of a seal that
 * has not been applied — greyed and dashed. A register that drew unearned
 * seals the same as earned ones would assert certifications no record
 * supports, which is the one thing a compliance artefact must never do.
 *
 * It carries the Aurixa emblem for the same reason the struck die does: every
 * seal on this document is pressed by the same system, and one that is not
 * marked reads as belonging to something else. Drawn the same way too — the
 * emblem as a mask, the seal's own ink as the fill — so it survives the cream
 * leaf and the dark register without a blend mode to get wrong. An UNEARNED
 * seal carries none, because nothing pressed it.
 */
export function Wax({
  tone = "gold",
  title,
  caption,
  size = 104,
  earned = true,
  org = "AURIXA SYSTEMS",
  className,
}: {
  tone?: WaxTone;
  title: string;
  caption?: string;
  size?: number;
  earned?: boolean;
  org?: string;
  className?: string;
}) {
  const small = size < 96;
  return (
    <div
      className={cn(
        "passport-wax",
        `passport-wax--${tone}`,
        !earned && "passport-wax--unearned",
        "passport-wax-hover",
        className,
      )}
      style={{ width: size, height: size }}
    >
      <span aria-hidden="true" className="passport-wax__ring" />
      <span aria-hidden="true" className="passport-wax__ticks" />
      {earned && (
        <span
          aria-hidden="true"
          className="passport-wax__watermark"
          data-emblem={WAX_EMBLEM}
          style={{ "--stamp-watermark-src": `url("${WAX_EMBLEM}")` } as CSSProperties}
        />
      )}
      <div className="relative px-2 text-center">
        <div className="passport-wax__org" style={{ fontSize: small ? 5 : 5.8 }}>
          {org}
        </div>
        <div className="passport-wax__title" style={{ fontSize: small ? 9 : 11 }}>
          {title}
        </div>
        {caption && (
          <div className="passport-wax__cap" style={{ fontSize: small ? 4.6 : 5.2 }}>
            {caption}
          </div>
        )}
      </div>
    </div>
  );
}

/* ── page furniture ───────────────────────────────────────────────────── */

export function PageHead({
  kicker,
  title,
  meta,
  action,
}: {
  kicker: string;
  title: string;
  meta?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3 pb-4">
      <div className="min-w-0">
        <div className="passport-kicker">{kicker}</div>
        <h2 className="passport-display mt-1 text-xl font-semibold sm:text-2xl">{title}</h2>
      </div>
      <div className="flex items-center gap-3">
        {meta && <span className="passport-faint text-xs">{meta}</span>}
        {action}
      </div>
    </div>
  );
}

export function PassportCard({
  children,
  className,
  pending = false,
  as: Tag = "div",
}: {
  children: ReactNode;
  className?: string;
  pending?: boolean;
  as?: "div" | "section" | "li";
}) {
  return (
    <Tag className={cn("passport-card p-4", pending && "passport-card--pending", className)}>
      {children}
    </Tag>
  );
}

export function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <div className="passport-kicker mb-3" style={{ letterSpacing: "0.16em" }}>
      {children}
    </div>
  );
}

/* ── fields ───────────────────────────────────────────────────────────── */

export function Field({
  k,
  v,
  mono = false,
}: {
  k: string;
  v: ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="min-w-0">
      <div className="passport-field__k">{k}</div>
      <div className={cn("passport-field__v", mono && "passport-field__v--mono passport-mono")}>
        {v ?? "—"}
      </div>
    </div>
  );
}

export function FieldGrid({ children, min = 150 }: { children: ReactNode; min?: number }) {
  return (
    <div
      className="grid gap-x-5 gap-y-3"
      style={{ gridTemplateColumns: `repeat(auto-fit,minmax(${min}px,1fr))` }}
    >
      {children}
    </div>
  );
}

/* ── record rows ──────────────────────────────────────────────────────── */

export function RecordRow({
  title,
  detail,
  status,
  tone = "na",
  trailing,
}: {
  title: ReactNode;
  detail?: ReactNode;
  status?: string;
  tone?: PassportTone;
  trailing?: ReactNode;
}) {
  return (
    <div className="passport-rule flex flex-wrap items-center gap-3 border-b py-2.5 last:border-b-0">
      <div className="min-w-0 flex-1">
        <div className="passport-dim text-[13px] font-semibold">{title}</div>
        {detail && <div className="passport-muted mt-0.5 text-xs leading-relaxed">{detail}</div>}
      </div>
      {status && <TonePill tone={tone}>{status}</TonePill>}
      {trailing}
    </div>
  );
}

/**
 * Every page needs the same answer to "there is no record here yet", and it
 * must read as an absent record rather than as a broken page — an operator who
 * cannot tell those apart will chase the wrong problem.
 */
export function NoRecord({ children }: { children: ReactNode }) {
  return (
    <div className="passport-panel passport-muted px-4 py-6 text-center text-xs">{children}</div>
  );
}

/** The design's bordered aside — used for boundaries and legal notes. */
export function PassportNote({
  title,
  children,
  tone = "gold",
}: {
  title: string;
  children: ReactNode;
  tone?: "gold" | "red";
}) {
  return (
    <div
      className={cn(
        "rounded-r-lg border-l-2 py-3 pl-4 pr-4",
        tone === "gold"
          ? "border-l-[color:var(--passport-gold)] bg-[color:var(--passport-tone-warn-wash)]"
          : "border-l-[color:var(--passport-tone-bad-ink)] bg-[color:var(--passport-tone-bad-wash)]",
      )}
    >
      <div className="passport-kicker" style={{ letterSpacing: "0.16em" }}>
        {title}
      </div>
      <div className="passport-muted mt-1.5 text-xs leading-relaxed">{children}</div>
    </div>
  );
}
