/**
 * Hand a picture over for ONE property.
 *
 * WHAT THIS IS NOT. This module briefly also carried "Design renders" — a
 * panel listing the house designs a builder's stock states, with an "Add
 * render" button that fanned one uploaded picture out to every lot stating
 * that design, and to every future lot as well. It is withdrawn: a matching
 * design string is not evidence that a photograph is of a particular house,
 * and no amount of manual uploading is a substitute for reading what the
 * builder already supplied. Correct blank beats a plausible wrong house.
 */
import { useCallback, useRef, useState } from 'react';
import { ImagePlus, Loader2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';
import { useSupplyBuilderStockImage } from '@/lib/builderStockQueries';

/**
 * Hand over a picture for ONE property.
 *
 * THE GUARANTEE, AND NEVER PART OF ORDINARY INGESTION. Stock images are
 * discovered from what the builder supplied in the stock list itself; this is
 * the administrative override for the one case that went wrong — a brochure
 * that turned out to hold the wrong picture, a lot whose render differs, a
 * one-off. It names ONE property and reaches no other.
 *
 * It carries LEVEL 1: the builder said "this is that property's picture", and
 * nothing was read, inferred or matched to arrive at it. So it outranks
 * anything taken out of a document, which is what makes it an override rather
 * than a suggestion.
 */
export function BuilderPropertyImageButton({
  stockItemId,
  propertyLabel,
  hasImage,
}: {
  stockItemId: string;
  propertyLabel: string;
  hasImage: boolean;
}) {
  const { toast } = useToast();
  const supply = useSupplyBuilderStockImage();
  const input = useRef<HTMLInputElement | null>(null);

  const choose = useCallback((file: File | null) => {
    if (!file) return;
    supply.mutate({ file, stockItemId }, {
      onSuccess: () => {
        toast({
          title: 'Picture saved',
          description: `${propertyLabel} now shows the picture you supplied.`,
        });
      },
      onError: (error) => {
        toast({
          title: 'That picture could not be saved',
          description: error instanceof Error ? error.message : 'Please try again shortly.',
          variant: 'destructive',
        });
      },
    });
  }, [propertyLabel, stockItemId, supply, toast]);

  return (
    <>
      <input
        ref={input}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        className="sr-only"
        onChange={(event) => {
          choose(event.target.files?.[0] ?? null);
          event.target.value = '';
        }}
      />
      <Button
        variant="ghost"
        size="sm"
        className="h-7 px-2 text-[11px]"
        disabled={supply.isPending}
        onClick={() => input.current?.click()}
        aria-label={hasImage
          ? `Replace the picture for ${propertyLabel}`
          : `Add a picture for ${propertyLabel}`}
      >
        {supply.isPending
          ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
          : <ImagePlus className="h-3 w-3" aria-hidden />}
        <span className="ml-1">{hasImage ? 'Replace' : 'Add picture'}</span>
      </Button>
    </>
  );
}
