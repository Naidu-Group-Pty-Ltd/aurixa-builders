/**
 * The passport as a bound document — the shared viewer.
 *
 * ONE implementation, used by the Command Centre dialog and by the Client
 * Portal page. That is deliberate: the client and the officer must be looking
 * at the same artefact, and two renderers of "the passport" would eventually
 * disagree about what it looks like. Audience differences are already handled
 * upstream by the projection, so nothing here needs to know who is reading.
 *
 * ## Why the leaf is scaled rather than laid out fluidly
 *
 * Every type size, rule, seal and grid inside a leaf is authored against a
 * 470×648 box. Letting flexbox squeeze that box — which is what the previous
 * version did — keeps 11px body copy and 30px seals inside a 200px-wide page,
 * so text reflows, wraps one character per line and overflows. Rendering the
 * leaf at its design size and applying a uniform `transform: scale()` keeps
 * every internal proportion exactly as designed, at any viewport. The
 * arithmetic lives in `bookletGeometry` so it is testable without a DOM.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { Columns2, RectangleVertical } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  LEAF_H,
  LEAF_W,
  bookletCover,
  bookletGeometry,
  bookletLabel,
  bookletSpreads,
  bookletZoom,
  nextBookletZoom,
  type BookletGeometry,
  type BookletPage,
  type PassportView,
} from "@/lib/aml/passport";
import { BookletBlockView } from "./BookletBlocks";

/* ── cover ────────────────────────────────────────────────────────────── */

/**
 * The navy leather front board.
 *
 * A passport opens on its cover. A booklet whose first page is a data table
 * reads as a report, which is the opposite of what this artefact is for.
 */
export function BookletCover({ page }: { page: BookletPage }) {
  return (
    <section
      // `passport-cover` is the navy leather MATERIAL and is shared with other
      // surfaces (the partner strip paints itself with it). `--board` is the
      // front-board COMPOSITION — the design's own page margins and vertical
      // rhythm — and belongs only to this element. Keeping them one class put
      // 58px of cover padding on a partner strip that had asked for 16px.
      className="passport-cover passport-cover--board passport-board__leaf relative flex flex-col items-center rounded-[11px] text-center"
      style={{ width: LEAF_W, height: LEAF_H }}
      aria-label="Passport cover"
    >
      <span aria-hidden="true" className="passport-cover__frame" />
      <span aria-hidden="true" className="passport-cover__frame-inner" />

      {/* Emblem zone — the design gives the mark the upper third to itself,
          sitting inside its own engraved halo. */}
      <div className="passport-cover__crest relative">
        <span aria-hidden="true" className="passport-cover__halo" />
        <img
          src="/brand/aurixa-emblem.png"
          alt=""
          aria-hidden="true"
          className="passport-cover__emblem relative"
          width={150}
          height={150}
        />
      </div>

      <h2 className="passport-cover__wordmark relative">Aurixa</h2>
      <div className="passport-cover__systems relative">Systems</div>

      <div className="passport-cover__diamond relative" aria-hidden="true">
        <span className="passport-cover__diamond-rule" />
        <span className="passport-cover__diamond-mark">◆</span>
        <span className="passport-cover__diamond-rule" />
      </div>

      <div className="passport-cover__title relative">
        AML/CTF
        <br />
        Compliance Passport
      </div>

      {/* Issue detail sits in the lower zone, subordinate to the crest, so the
          board still reads as the design's cover rather than as a title page. */}
      <div className="passport-cover__issue relative">
        {page.sub && <div className="passport-cover__holder">{page.sub}</div>}
        {page.foot && <div className="passport-cover__credential mt-1.5">{page.foot}</div>}
        {page.fingerprint && (
          <div className="passport-cover__fingerprint mt-3">
            <div className="passport-cover__fingerprint-k">SHA-256 EVIDENCE FINGERPRINT</div>
            <div className="passport-mono mt-0.5">{page.fingerprint}</div>
          </div>
        )}
      </div>

      <span aria-hidden="true" className="passport-cover__clasp" />
    </section>
  );
}

/* ── leaf ─────────────────────────────────────────────────────────────── */

export function BookletLeaf({ page }: { page: BookletPage }) {
  return (
    <article
      className="passport-leaf passport-board__leaf flex flex-col"
      style={{ width: LEAF_W, height: LEAF_H }}
      aria-label={page.title}
    >
      <span aria-hidden="true" className="passport-leaf__guilloche" />
      <span aria-hidden="true" className="passport-leaf__frame-outer" />
      <span aria-hidden="true" className="passport-leaf__frame-inner" />

      <header className="relative flex-none text-center">
        <div className="passport-leaf__kicker">{page.kicker}</div>
        <h3 className="passport-leaf__title">{page.title}</h3>
        <div className="passport-leaf__divider mx-auto my-2 w-1/2" />
        {page.sub && <p className="passport-leaf__sub m-0 text-[9.5px] leading-relaxed">{page.sub}</p>}
      </header>

      <div className="passport-leaf__body relative mt-3 flex min-h-0 flex-1 flex-col gap-3">
        {page.blocks.map((b, i) => (
          <BookletBlockView key={`${page.id}-${b.kind}-${i}`} block={b} />
        ))}
      </div>

      <footer className="passport-leaf__faint relative mt-2 flex-none text-center text-[8px] tracking-[0.2em]">
        {page.numeral ?? ""}
      </footer>
    </article>
  );
}

/* ── the book ─────────────────────────────────────────────────────────── */

/**
 * The navy margin the board keeps around the leaves, and the spine gap between
 * two facing leaves. Both are shared with `bookletGeometry` so the arithmetic
 * that fits the spread and the arithmetic that draws it cannot disagree — a
 * mismatch of a few pixels is exactly what crops a leaf.
 */
const BOARD_FRAME = 44;
const SPINE = 26;

/** Measures the board and returns the geometry that fits it. */
function useBookGeometry(singleOnly: boolean) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [geometry, setGeometry] = useState<BookletGeometry>(() =>
    bookletGeometry({ availableWidth: LEAF_W, availableHeight: LEAF_H, singleOnly }),
  );

  // Measure the board's OWN box rather than deriving a height from
  // window.innerHeight. The book is nested inside a dialog whose height is
  // itself capped, so a window-derived guess is wrong by however much chrome
  // sits above and below — which is how the page ended up taller than the
  // dialog and spilled off the screen.
  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return;
    setGeometry(
      bookletGeometry({
        availableWidth: rect.width - BOARD_FRAME,
        availableHeight: rect.height - BOARD_FRAME,
        spine: SPINE,
        singleOnly,
      }),
    );
  }, [singleOnly]);

  useLayoutEffect(() => {
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const ro = new ResizeObserver(measure);
    if (ref.current) ro.observe(ref.current);
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [measure]);

  return { ref, geometry };
}

export function PassportBook({
  pages,
  singleOnly = false,
  className,
  onClose,
}: {
  pages: BookletPage[];
  /** Force one leaf at a time — the client booklet reads better this way. */
  singleOnly?: boolean;
  className?: string;
  onClose?: () => void;
}) {
  /* ── reading controls ───────────────────────────────────────────────
     The fit is correct and the page is still too small to read: the design
     authors 9.5-11px body copy at 470x648, so a two-up spread in a dialog
     draws that copy at 6-7px. Two controls answer it, and both are the
     reader's rather than the caller's — the document is unchanged, only how
     large it is drawn.

     `onePage` starts wherever the caller asked, so every existing surface
     opens exactly as it did; the reader may then take a single leaf, which
     roughly doubles the scale before any magnification at all. */
  const [onePage, setOnePage] = useState(singleOnly);
  useEffect(() => { setOnePage(singleOnly); }, [singleOnly]);
  const [zoom, setZoom] = useState(1);

  const { ref, geometry } = useBookGeometry(onePage);
  const view = bookletZoom(geometry, zoom);

  /* ── panning a magnified document ───────────────────────────────────
     Scrollbars alone are a poor way to move around a page you are reading
     at 250%: they are at the edges of a box the document fills, and the
     reader's attention is in the middle of it. Every document viewer a
     person has used — a PDF reader, a map, a photo — is dragged, so this
     one is too. It is offered only while the board actually overflows, so
     a fitted document keeps ordinary text selection and an ordinary
     cursor. */
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const [panning, setPanning] = useState(false);

  /* Whether there is anywhere to pan is asked of the DOM, every time the
     drawing changes size. See the note on `BookletZoom` for why it is not
     derived from the magnification: `zoom > 1` was neither necessary nor
     sufficient, and a measured box carried on the geometry flaps where the
     container is content-sized. One pixel of tolerance, because the board is
     drawn at whole pixels and a sub-pixel overflow can be neither seen nor
     scrolled to. */
  const [canPan, setCanPan] = useState(false);
  const measurePan = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const over = el.scrollWidth - el.clientWidth > 1 || el.scrollHeight - el.clientHeight > 1;
    setCanPan((prev) => (prev === over ? prev : over));
  }, []);
  useLayoutEffect(() => {
    measurePan();
    const el = scrollerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    // The scroller for the space, its board for the drawing: either changing
    // changes the answer, and the board changes without the scroller does.
    const ro = new ResizeObserver(measurePan);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    return () => ro.disconnect();
  }, [measurePan]);
  // Re-asked on every change that redraws the board, so the answer is never a
  // frame behind what the reader is looking at.
  useLayoutEffect(measurePan, [measurePan, view.scale, geometry.perSpread, onePage]);
  const onPanStart = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const el = scrollerRef.current;
    // Only a primary drag on a surface that has somewhere to go. A secondary
    // button is the context menu, and a board that fits has no pan.
    if (!el || e.button !== 0) return;
    if (el.scrollWidth <= el.clientWidth && el.scrollHeight <= el.clientHeight) return;
    const startX = e.clientX;
    const startY = e.clientY;
    const fromLeft = el.scrollLeft;
    const fromTop = el.scrollTop;
    let moved = false;
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      // A click that wanders three pixels is still a click. Only past that
      // does this become a drag and start suppressing selection.
      if (!moved && Math.abs(dx) + Math.abs(dy) < 3) return;
      moved = true;
      setPanning(true);
      el.scrollLeft = fromLeft - dx;
      el.scrollTop = fromTop - dy;
    };
    const up = () => {
      setPanning(false);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
    // Listened for on the WINDOW, not the element: a pointer that leaves the
    // board mid-drag must keep panning and must still release, or the reader
    // is left holding a document that follows the mouse.
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  }, []);

  /* Magnifying holds the middle of the page still.
     Zooming from the top-left corner throws whatever the reader was looking
     at off the screen, and they then have to find it again with the very
     scrollbars this change added. The centre of the viewport before the
     step is the centre after it. */
  const lastScale = useRef(view.scale);
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    const previous = lastScale.current;
    lastScale.current = view.scale;
    if (!el || previous === view.scale || previous <= 0) return;
    const ratio = view.scale / previous;
    el.scrollLeft = (el.scrollLeft + el.clientWidth / 2) * ratio - el.clientWidth / 2;
    el.scrollTop = (el.scrollTop + el.clientHeight / 2) * ratio - el.clientHeight / 2;
  }, [view.scale]);
  const [index, setIndex] = useState(0);
  const [turn, setTurn] = useState<"fwd" | "back" | null>(null);

  const spreads = bookletSpreads(pages.length, geometry.perSpread);
  const clamped = Math.min(index, Math.max(0, spreads.length - 1));
  const spread = spreads[clamped] ?? [];

  // Reflowing from one leaf to two must keep the reader on the page they were
  // reading rather than resetting them to the cover.
  useEffect(() => {
    setIndex((i) => Math.min(i, Math.max(0, spreads.length - 1)));
  }, [spreads.length]);

  const go = useCallback(
    (delta: number) => {
      setIndex((i) => {
        const next = Math.min(spreads.length - 1, Math.max(0, i + delta));
        if (next !== i) setTurn(delta > 0 ? "fwd" : "back");
        return next;
      });
    },
    [spreads.length],
  );

  useEffect(() => {
    if (!turn) return;
    const t = window.setTimeout(() => setTurn(null), 420);
    return () => window.clearTimeout(t);
  }, [turn]);

  const goToPage = (pageIndex: number) => {
    const target = spreads.findIndex((s) => s.includes(pageIndex));
    if (target >= 0) {
      setTurn(target > clamped ? "fwd" : target < clamped ? "back" : null);
      setIndex(target);
    }
  };

  const titles = spread.map((i) => pages[i]?.title).filter(Boolean).join(" · ");

  return (
    <div
      className={cn("flex flex-col", className)}
      onKeyDown={(e) => {
        /* Arrows turn the page — unless the reader is standing IN a
           magnified board, where the same keys are how anybody moves around
           a document that is bigger than its window. The board is focusable
           only while it overflows, so this can never swallow a page turn on
           a document that fits, and Previous / Next / the page chips turn
           the page from anywhere. */
        const inBoard = canPan
          && scrollerRef.current?.contains(e.target as Node)
          && e.target !== e.currentTarget;
        if (!inBoard && e.key === "ArrowRight") go(1);
        if (!inBoard && e.key === "ArrowLeft") go(-1);
        // The magnification keys everybody already knows, so the control is
        // discoverable without being the only way in.
        if (e.key === "+" || e.key === "=") setZoom((z) => nextBookletZoom(z, 1));
        if (e.key === "-" || e.key === "_") setZoom((z) => nextBookletZoom(z, -1));
        if (e.key === "0") setZoom(1);
        if (e.key === "Escape" && onClose) onClose();
      }}
      tabIndex={-1}
      role="group"
      aria-label="Digital passport"
    >
      {/* page chips, and the reading controls beside them */}
      <div className="flex flex-none flex-wrap items-center justify-center gap-x-3 gap-y-2 px-4 py-2.5">
        <div className="flex flex-wrap items-center justify-center gap-1.5">
          {pages.map((p, i) => (
            <button
              key={p.id}
              type="button"
              className={cn("passport-pagechip", p.variant === "cover" && "passport-pagechip--cover")}
              aria-current={spread.includes(i)}
              aria-label={p.variant === "cover" ? "Cover" : `Page ${i}: ${p.title}`}
              onClick={() => goToPage(i)}
            >
              {p.variant === "cover" ? "◈" : i}
            </button>
          ))}
        </div>

        <span aria-hidden className="passport-toolbar__sep" />

        {/* ── Magnification ──────────────────────────────────────────────
            The document is authored at 9.5-11px and fitted into whatever
            space there is, so on a laptop the body copy lands around 6px —
            the glyphs are distinct and nobody reads them. This changes only
            how large it is drawn: the same uniform transform the fit already
            applies, so nothing reflows and no line rewraps.

            It is drawn as its own cluster because it was not being found.
            Sitting in the same row as the page numbers, in the same chip, at
            the same weight, four unlabelled chips read as four more pages — on the
            surface where it matters most, a partner's portal where the
            booklet IS the page. Same four buttons, same accessible names,
            same behaviour: a well, a hairline and a label are emphasis, not
            a new control. */}
        <div
          className="passport-zoombar"
          role="group"
          aria-label="Passport magnification"
          data-testid="passport-zoom-controls"
        >
          <span className="passport-zoombar__label" aria-hidden>Zoom</span>
          {/* One leaf is the cheapest magnification there is — it roughly
              doubles the scale before any zoom at all — so it sits with the
              zoom rather than being a caller-only decision. */}
          <button
            type="button"
            className="passport-pagechip"
            aria-pressed={onePage}
            title={onePage ? "Show two pages side by side" : "Show one page at a time"}
            aria-label={onePage ? "Show two pages side by side" : "Show one page at a time"}
            onClick={() => setOnePage((v) => !v)}
          >
            {/* Icons, not characters. U+2750 and U+25AF are outside every
                font this product ships, so both states of this toggle drew a
                tofu box — visible in the reported screenshot as an empty
                chip. A control nobody can identify is a control nobody uses,
                which is half of why the magnification was never found. */}
            {onePage
              ? <Columns2 className="h-3.5 w-3.5" aria-hidden />
              : <RectangleVertical className="h-3.5 w-3.5" aria-hidden />}
          </button>
          <button
            type="button"
            className="passport-pagechip"
            onClick={() => setZoom((z) => nextBookletZoom(z, -1))}
            disabled={!view.canZoomOut}
            aria-label="Zoom out"
            title="Zoom out (−)"
          >
            −
          </button>
          <button
            type="button"
            className="passport-pagechip passport-mono passport-zoombar__value"
            onClick={() => setZoom(1)}
            disabled={view.zoom === 1}
            aria-label={`Magnification ${view.percent} percent. Reset to fit.`}
            title="Reset to fit (0)"
          >
            {view.percent}%
          </button>
          <button
            type="button"
            className="passport-pagechip"
            onClick={() => setZoom((z) => nextBookletZoom(z, 1))}
            disabled={!view.canZoomIn}
            aria-label="Zoom in"
            title="Zoom in (+)"
          >
            +
          </button>
        </div>
      </div>

      {/* board */}
      {/* A FLEX COLUMN, and that is the whole fix for "the zoomed passport is
          cut off and will not scroll".

          The scroller inside asked for `h-full`. A percentage height resolves
          against the containing block's height, and this box is a flex ITEM
          whose height comes from the flex algorithm rather than from a
          declared length — so Chrome resolved `height: 100%` to `auto`, the
          scroller grew to its own content (1,553px inside a 667px box), and
          `overflow: auto` had nothing left to clip. The board spilled past the
          dialog, which clips it, and the reader got a cropped document with no
          scrollbar on either axis: the horizontal bar existed, 1,553px down,
          off the bottom of the screen.

          Making this a column and giving the scroller `min-h-0 flex-1` takes
          percentage resolution out of the path entirely — the scroller's
          height is whatever flex gives it, which is exactly this box. It also
          keeps working where this box has NO bounded height (the Client
          Portal mounts the viewer on an ordinary page): there the flex item
          grows with its content, exactly as it does today, and the page
          scrolls. */}
      <div className="relative flex min-h-0 flex-1 flex-col">
        {/* The measuring probe.
            The ref used to sit on the box that HOLDS the board, which was
            correct while the board could only ever be as large as the space —
            it made the measured rect the space available, with no guessed
            padding subtracted from a padded parent.
            Magnification breaks that: a board larger than its container makes
            the holder larger too, the next measurement reads the enlarged box
            as "space available", and the fit grows to match — the leaf shrinks
            as fast as the reader enlarges it. So the probe is now a sibling
            that draws nothing and never changes size. `inset-4` is the same
            16px the scroller's `p-4` reserves, so its rect is still exactly
            the padding-free space, and content cannot feed back into the fit.
            It is absolutely positioned, so it is not a flex item and adds
            nothing to the column. */}
        <div ref={ref} aria-hidden className="pointer-events-none absolute inset-4" />
        <div
          ref={scrollerRef}
          onPointerDown={onPanStart}
          /* A scroll container that a keyboard cannot reach is a scroll
             container half the readers of this document do not have. It
             takes focus only while there is somewhere to scroll. */
          tabIndex={canPan ? 0 : -1}
          role={canPan ? "region" : undefined}
          aria-label={canPan ? "Passport board — scrollable" : undefined}
          className={cn(
            /* Always a scroll container, and always aligned to the start.
               Centring with `justify-content` is what makes an overflowing
               box unreachable — it is pinned at a negative offset no
               scrollbar can reach — so the centring is done by the board's
               own `m-auto` instead: an auto margin takes the free space when
               there is some and collapses to zero when there is not. One
               layout serves both states, which is also what makes the
               overflow measurement below trustworthy: `scrollWidth` on a
               centred box reports half the overflow. */
            "passport-pan flex min-h-0 w-full flex-1 items-start justify-start overflow-auto p-4",
            canPan
              && "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset "
                + "focus-visible:ring-[color:var(--passport-gold)] "
                + (panning ? "cursor-grabbing select-none" : "cursor-grab"),
          )}
        >
          <div
            className="passport-board relative m-auto flex-none overflow-hidden"
            style={{
              width: Math.round(view.width + BOARD_FRAME),
              height: Math.round(view.height + BOARD_FRAME),
            }}
          >
            {/* The scaled layer is ABSOLUTELY positioned, never a flex item.
                A flex item wider than its line gets centred to a NEGATIVE left
                offset, and `transform-origin: top left` then preserves that
                offset — which cropped the left-hand leaf against the board's
                overflow. Absolute positioning takes it out of flow entirely,
                so the only thing that decides where it sits is this inset. */}
            <div
              className={cn(
                "absolute origin-top-left",
                turn === "fwd" && "passport-turn-fwd",
                turn === "back" && "passport-turn-back",
              )}
              style={{
                left: BOARD_FRAME / 2,
                top: BOARD_FRAME / 2,
                width: geometry.spreadWidth,
                height: LEAF_H,
                transform: `scale(${view.scale})`,
              }}
            >
              <div className="flex items-start" style={{ gap: spread.length > 1 ? SPINE : 0 }}>
                {spread.map((pageIndex, n) => {
                  const page = pages[pageIndex];
                  if (!page) return null;
                  return (
                    <div key={page.id} className="relative flex flex-none items-start">
                      {n > 0 && <span aria-hidden="true" className="passport-board__spine" />}
                      {page.variant === "cover" ? (
                        <BookletCover page={page} />
                      ) : (
                        <BookletLeaf page={page} />
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ── turn ────────────────────────────────────────────────────────
          A GRID, not `justify-between`, and the reason is the defect it
          fixes. `.passport-action` used to force `width: 100%` — it beat the
          `w-auto` beside it on source order alone — so both buttons claimed
          the whole row and the title between them was squeezed to a
          truncated "Identity Ver…" with its page count wrapped onto three
          lines and running under the Next button.

          The declaration is gone (see `passport-tokens.css`), and the row is
          three columns rather than three flex items: the outer two are equal
          fractions, so the title column sits on the TRUE centre line however
          wide the two labels happen to be. It is sized to its content and
          never truncated — the whole point of naming the pages you are
          looking at is being able to read the name. */}
      <div className="grid flex-none grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3 border-t border-[color:var(--passport-hairline)] px-4 py-3">
        <button
          type="button"
          className="passport-action passport-action--turn justify-self-start"
          onClick={() => go(-1)}
          disabled={clamped === 0}
        >
          ← Previous
        </button>
        <div className="min-w-0 px-1 text-center">
          <div className="passport-display text-[13px] leading-snug">{titles}</div>
          <div className="passport-faint passport-mono mt-0.5 text-[10px] tracking-[0.14em]">
            {spread.includes(0) && pages[0]?.variant === "cover" && spread.length === 1
              ? "COVER"
              : bookletLabel(spread, pages.length)}
          </div>
        </div>
        <button
          type="button"
          className="passport-action passport-action--turn passport-action--primary justify-self-end"
          onClick={() => go(1)}
          disabled={clamped >= spreads.length - 1}
        >
          Next →
        </button>
      </div>
    </div>
  );
}

/* ── cover thumbnail ──────────────────────────────────────────────────── */

/**
 * A miniature of the real cover.
 *
 * It renders `BookletCover` itself, at design size, under the same uniform
 * transform the book uses for a leaf — it is NOT a second, simplified drawing
 * of the cover. That matters for the same reason the client and the officer
 * share one viewer: a hand-drawn "thumbnail version" is a copy, and a copy
 * drifts. Change the cover once — the emblem, the frame rules, the gold, the
 * type — and every surface that shows one follows, including this.
 *
 * Because it is the real artwork built from the real projection, it is
 * per-customer by construction. Nothing here is specialised to a case; pass a
 * different `view` and you get that customer's bearer, credential and state.
 *
 * ## Why nothing here measures anything
 *
 * The cover is a fixed 470×648 composition, so a miniature is a slot width and
 * a scale factor — and those two are the SAME number. Deriving them separately
 * is how a miniature ends up clipped: a first draft took the width from CSS
 * (112px on a phone) and the scale from JS, and any moment the two disagreed —
 * before the first layout effect, in a server render, on a hidden tab — the
 * board was drawn at one size inside a box of another and lost its clasp to
 * `overflow: hidden`.
 *
 * So the size is declared ONCE, as the unitless `--passport-thumb-w`, and the
 * stylesheet derives both the box (`calc(var(--passport-thumb-w) * 1px)`) and
 * the scale (`calc(var(--passport-thumb-w) / 470)`) from it. They cannot
 * disagree, there is no JS in the path at all, and a surface resizes the cover
 * by setting one custom property.
 */
export function PassportCoverThumb({
  view,
  width,
  className,
}: {
  view: PassportView;
  /**
   * Override the slot width, in CSS pixels. Omit to take the size from the
   * stylesheet, which is where it belongs for the surfaces we ship.
   */
  width?: number;
  className?: string;
}) {
  const page = useMemo(() => bookletCover(view), [view]);
  return (
    <span
      className={cn("passport-cover-thumb", className)}
      style={width ? ({ "--passport-thumb-w": width } as CSSProperties) : undefined}
    >
      {/* Hidden from assistive tech: whatever frames this miniature states the
          bearer, credential and state at full size, so announcing the cover's
          own text a second time is noise. The control that wraps it carries
          the accessible name. */}
      <span aria-hidden="true" className="passport-cover-thumb__art">
        <BookletCover page={page} />
      </span>
    </span>
  );
}
