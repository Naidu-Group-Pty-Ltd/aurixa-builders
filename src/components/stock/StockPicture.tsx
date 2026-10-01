import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { Image as ImageIcon, Loader2 } from 'lucide-react';

import { cn } from '@/lib/utils';
import {
  type BuilderStockImage,
  type CardPictureFit,
  cardPictureFit,
} from '@/lib/builderStock';
import {
  type HeroPlanView, heroGeometry, heroPlanFitsPicture, readHeroPlan,
} from '@/lib/marketplaceHero';

/**
 * A STOCK PROPERTY'S PICTURE. ONE TREATMENT, TWO PORTALS.
 *
 * This is the fit-and-ground logic that the Command Centre marketplace card
 * arrived at the hard way, lifted out so the Builder portal can draw the same
 * picture the same way. It was extracted rather than copied, because the
 * history below is exactly what a second copy loses.
 *
 * ## What the treatment costs to get wrong
 *
 * It began as a 160px strip with `object-cover`, which discarded 68% of a
 * portrait render and kept a band of sky. The repair was to CONTAIN every
 * picture in a 16:9 frame — nothing cropped, ever — and that bought the
 * defect that replaced it: a grey band above and below almost every card,
 * with the badge floating in it, reported as looking broken.
 *
 * Both were the same mistake: treating the frame and the fit as one
 * decision. `cardPictureFit` separates them, on measurements taken over the
 * 94 properties live on 11 September 2026 — 66 carry a 16:9 render, the modal
 * shape by a factor of six, because that is what the builders' rendering
 * software emits. Those fill the frame. Since 30 September 2026 nothing else
 * does: the owner's rule is that a card shows the property as the builder
 * supplied it, so any other shape is shown whole on the ground below rather
 * than cut to fit — see `CARD_PICTURE_MAX_VERTICAL_CROP`.
 *
 * ## Four rules
 *
 * **THE FIT IS ASKED OF THE PICTURE THAT LOADED.** The stored
 * `source_width`/`source_height` describe the PAGE for a page-crop
 * extraction rather than the crop that was kept, so the record is the wrong
 * witness. `naturalWidth` is the thing actually being drawn.
 *
 * **UNMEASURED MEANS `contain`.** Showing a picture whole is the choice that
 * cannot cut a house in half, so the unmeasured case — still loading, failed
 * to load, dimensions unreadable — takes the safe one.
 *
 * **A CONTAINED PICTURE SITS ON ITS OWN GROUND**, blurred and lifted from
 * the same `src`, so it is already decoded and costs no request. It is
 * mounted only once the picture has been measured — a blur of nothing is a
 * grey slab. And it is a `filter`, never a `backdrop-filter`: `glass.css`
 * forbids a backdrop filter on anything that repeats, and a sheet of plates
 * repeats.
 *
 * **THE TRANSPORT IS A PARAMETER, THE TREATMENT IS NOT.** A stored image is
 * fetched through a short-lived signed URL, and the two portals mint that
 * from different endpoints under different authorisation — so `resolveUrl`
 * differs and everything else is shared. Same pattern as
 * `buildCasePassportView(…, audience)`: one implementation, an audience
 * parameter, so the two cannot come to draw the same photograph differently.
 *
 * ## The Marketplace Hero Standard (1 October 2026)
 *
 * A CARD (`presentation="card"`) draws the plan the network stored for the
 * exact bytes it signed — a 16:9 frame around the property, or the
 * photograph shown whole where no frame can hold the house — and computes
 * nothing of its own (`marketplaceHero.ts`). It supersedes the "show it
 * whole" rule above for cards ONLY: a detail view or gallery keeps the
 * picture's own shape, and a card with no plan (or a plan that does not match
 * the picture that loaded) is drawn exactly as described above.
 */
/** What a resolver answers: a URL, or a URL and the plan for its bytes. */
export type StockPictureSource = string | { url: string | null; hero?: unknown } | null;

export interface StockPictureProps {
  /** The picture to draw, or `null` where the property has none. */
  image: BuilderStockImage | null;
  /**
   * How this caller mints a signed URL for a stored image. Called only for
   * an image that HAS a `storage_path`; an external URL is used directly.
   */
  resolveUrl: (imageId: string) => Promise<StockPictureSource>;
  /**
   * `card` draws the Marketplace Hero plan where the door sent one; `detail`
   * (the default) always shows the picture as supplied. Only card call sites
   * opt in, so no gallery or detail view can be re-framed by accident.
   */
  presentation?: 'card' | 'detail';
  /** Tailwind aspect class for the frame. The measured modal shape is 16:9. */
  aspectClassName?: string;
  /** Extra classes for the frame — a border treatment, a radius, a ring. */
  className?: string;
  /** Accessible name. Callers pass the property, not the file. */
  alt: string;
  /** Drawn over the picture: a provenance badge, a source link. */
  overlay?: ReactNode;
  /** Offered where there is no picture at all. */
  emptyAction?: ReactNode;
  /** Wording for the empty frame. */
  emptyLabel?: string;
}

export function StockPicture({
  image,
  resolveUrl,
  aspectClassName = 'aspect-[16/9]',
  className,
  alt,
  overlay,
  emptyAction,
  emptyLabel = 'No picture found',
  presentation = 'detail',
}: StockPictureProps) {
  const [signedUrl, setSignedUrl] = useState<string | null>(null);
  const [hero, setHero] = useState<HeroPlanView | null>(null);
  const [heroRefused, setHeroRefused] = useState(false);
  const [broken, setBroken] = useState(false);
  const [fit, setFit] = useState<CardPictureFit>('contain');

  const measure = useCallback((drawn: HTMLImageElement) => {
    setFit(cardPictureFit(drawn.naturalWidth, drawn.naturalHeight));
  }, []);

  /*
   * Measured on mount as well as on load, because a picture already in the
   * browser's cache can complete BEFORE React attaches `onLoad` and would
   * then never be measured at all — which fails to the safe box rather than
   * to a wrong one, but fails silently and only on a revisit, which is the
   * hardest kind of gap to notice. Stable, so a re-render does not detach
   * and reattach the ref on every plate on the sheet.
   */
  const measureOnMount = useCallback((drawn: HTMLImageElement | null) => {
    if (drawn?.complete && drawn.naturalWidth) measure(drawn);
  }, [measure]);

  useEffect(() => {
    let alive = true;
    setBroken(false);
    setSignedUrl(null);
    setHero(null);
    setHeroRefused(false);
    setFit('contain');
    if (!image) return () => { alive = false; };
    // Somebody else's server: loaded without a referrer, never signed.
    if (image.external_url && !image.storage_path) {
      setSignedUrl(image.external_url);
      return () => { alive = false; };
    }
    /*
     * A URL that could not be minted is a picture that cannot be shown, and
     * says so. It used to leave the spinner turning for ever where the answer
     * was null, and to reject unhandled where the lookup threw.
     */
    resolveUrl(image.id)
      .then((answer) => {
        if (!alive) return;
        const url = typeof answer === 'string' ? answer : answer?.url ?? null;
        if (url) setSignedUrl(url);
        else setBroken(true);
        if (presentation === 'card' && answer && typeof answer === 'object') {
          setHero(readHeroPlan(answer.hero));
        }
      })
      .catch(() => { if (alive) setBroken(true); });
    return () => { alive = false; };
  }, [image, resolveUrl, presentation]);

  if (!image) {
    return (
      <div
        /* Addressable, so a caller's own frame treatment can tell "no
           picture" apart from "a picture" without matching on a utility
           class. The Builder portal hatches it: an unmarked empty box reads
           as a broken image, and a hatched one reads as a drawing
           convention for nothing drawn here yet. */
        data-picture="empty"
        className={cn(
          'flex w-full items-center justify-center bg-muted/30',
          aspectClassName,
          className,
        )}
      >
        <div className="px-3 text-center">
          <ImageIcon className="mx-auto h-6 w-6 text-muted-foreground/50" aria-hidden />
          <p className="mt-1 text-[11px] text-muted-foreground">{emptyLabel}</p>
          {emptyAction}
        </div>
      </div>
    );
  }

  const planned = presentation === 'card' && hero && !heroRefused && signedUrl && !broken ? hero : null;
  if (planned) {
    const geometry = heroGeometry(planned);
    return (
      <div
        data-picture="present"
        data-hero={planned.mode}
        className={cn('relative w-full overflow-hidden bg-muted/30', aspectClassName, className)}
      >
        <div
          className="absolute overflow-hidden"
          style={{
            left: `${geometry.box.left}%`, top: `${geometry.box.top}%`,
            width: `${geometry.box.width}%`, height: `${geometry.box.height}%`,
          }}
        >
          <img
            src={signedUrl ?? undefined}
            alt={alt}
            className="absolute max-w-none object-cover"
            style={{
              left: `${geometry.image.left}%`, top: `${geometry.image.top}%`,
              width: `${geometry.image.width}%`, height: `${geometry.image.height}%`,
            }}
            loading="lazy"
            referrerPolicy="no-referrer"
            ref={(drawn) => {
              if (drawn?.complete && drawn.naturalWidth
                && !heroPlanFitsPicture(planned, drawn.naturalWidth, drawn.naturalHeight)) {
                setHeroRefused(true);
              }
            }}
            onLoad={(event) => {
              const drawn = event.currentTarget;
              // Different bytes than the plan was made over: draw as before.
              if (!heroPlanFitsPicture(planned, drawn.naturalWidth, drawn.naturalHeight)) setHeroRefused(true);
              measure(drawn);
            }}
            onError={() => setBroken(true)}
          />
        </div>
        {overlay}
      </div>
    );
  }

  const contained = Boolean(signedUrl) && !broken && fit === 'contain';

  return (
    <div
      data-picture="present"
      className={cn('relative w-full overflow-hidden bg-muted/30', aspectClassName, className)}
    >
      {contained ? (
        <>
          <img
            src={signedUrl ?? undefined}
            alt=""
            aria-hidden
            className="absolute inset-0 z-0 h-full w-full scale-125 object-cover blur-3xl saturate-150"
            loading="lazy"
            referrerPolicy="no-referrer"
          />
          {/* Light (30%): at 45% it washed the picture's own colour out into
              exactly the grey it was meant to replace. */}
          <div className="absolute inset-0 z-0 bg-background/30" aria-hidden />
        </>
      ) : null}

      {signedUrl && !broken ? (
        <img
          src={signedUrl}
          alt={alt}
          className={cn(
            'relative z-10 h-full w-full',
            fit === 'cover' ? 'object-cover' : 'object-contain',
          )}
          loading="lazy"
          referrerPolicy="no-referrer"
          ref={measureOnMount}
          onLoad={(event) => measure(event.currentTarget)}
          onError={() => setBroken(true)}
        />
      ) : (
        <div className="flex h-full items-center justify-center">
          {broken
            ? <p className="text-[11px] text-muted-foreground">Picture unavailable</p>
            : <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-hidden />}
        </div>
      )}

      {overlay}
    </div>
  );
}
