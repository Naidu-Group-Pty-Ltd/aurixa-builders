import * as React from "react"
import * as DialogPrimitive from "@radix-ui/react-dialog"
import { X } from "lucide-react"

import { cn } from "@/lib/utils"

const Dialog = DialogPrimitive.Root

const DialogTrigger = DialogPrimitive.Trigger

const DialogPortal = DialogPrimitive.Portal

const DialogClose = DialogPrimitive.Close

const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      // Scrim (tint + backdrop blur) comes from `.luxury-dialog-overlay`.
      "luxury-dialog-overlay fixed inset-0 z-50 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
      className
    )}
    {...props}
  />
))
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName

type DialogContentProps = React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & {
  /**
   * Allows feature-level dialogs to opt into a bespoke backdrop without
   * changing the shared dialog treatment used elsewhere in the product.
   */
  overlayClassName?: string
  /** Inline shell offsets for a dialog whose portal must respect application chrome. */
  overlayStyle?: React.CSSProperties
  /**
   * Omits the shared bottom-sheet / centered positioning classes so a dialog can
   * fully own its placement (e.g. an overlay contained within the app shell). Only
   * the neutral surface + fade treatment is retained; the caller supplies all
   * position and size classes via `className`. Default dialogs are unaffected.
   */
  bareLayout?: boolean
}

/**
 * Does this call site state its own dialog width?
 *
 * ## The trap
 *
 * The default treatment below sets `sm:max-w-lg`. A caller writing
 * `className="max-w-5xl"` is writing an UNPREFIXED utility, and to
 * `tailwind-merge` those are different keys — `max-w` and `sm:max-w` do not
 * conflict, so both survive. Equal specificity then hands the decision to
 * source order, and Tailwind emits responsive variants after base utilities,
 * so from 640px up `sm:max-w-lg` wins and the author's width silently never
 * applies.
 *
 * It is silent in the worst way: the dialog looks deliberate at 512px. A
 * sweep found **135** call sites in this state — table editors, galleries,
 * template marketplaces, an email reading pane — every one of them rendering
 * at a third of the width its author asked for. Two were reported as
 * separate audit defects ("the expanded email is very narrow", "the compose
 * window is small in comparison"), which is what a systemic fault looks like
 * from the outside: unrelated complaints about unrelated screens.
 *
 * ## The rule
 *
 * A width the caller states wins. Only an UNPREFIXED `max-w-*` counts as
 * stating one — a caller writing `lg:max-w-4xl` alone has opted into the
 * default below that breakpoint deliberately, and taking it away would break
 * the one shape that was already working.
 *
 * `max-w-none` counts: it is a width, and it is what a full-bleed dialog asks
 * for.
 */
export function declaresOwnWidth(className?: string): boolean {
  if (!className) return false;
  return /(?:^|\s)max-w-/.test(className);
}

/**
 * Does this call site state how tall it may be?
 *
 * The same trap as `declaresOwnWidth`, on `max-height`. The default treatment
 * sets `sm:max-h-[85dvh]`; a caller writing `max-h-[90vh]` is writing an
 * unprefixed utility, so both survive the merge and the responsive one wins
 * from 640px up. **110** call sites are in that state.
 */
export function declaresOwnMaxHeight(className?: string): boolean {
  if (!className) return false;
  return /(?:^|\s)max-h-/.test(className);
}

/**
 * Does this call site state what happens to content that does not fit?
 *
 * This is the trap's third instance and the one that is actually *visible*:
 * the default treatment sets `sm:overflow-visible`, so a caller writing
 * `overflow-y-auto` gets it below 640px and loses it above — and a dialog
 * whose content exceeds `max-h` then paints straight out through its own
 * bottom border, with no scrollbar on either axis and no way to reach what
 * spilled. The audit reported it as "the publish report window has a content
 * overflow at the bottom"; **99** call sites state an overflow they do not
 * get.
 *
 * `overflow-hidden` counts, and honouring it is the point rather than a side
 * effect: every one of those call sites pairs it with an inner scroller (a
 * `ScrollArea`, a bounded `overflow-auto` child, a `flex-col` with a
 * `min-h-0` body), which is a shape that only works if the shell clips.
 *
 * Only an UNPREFIXED `overflow-*` counts, for the same reason as width: a
 * caller writing `sm:overflow-hidden` alone conflicts with the default on the
 * same modifier, so the merge already resolves it correctly.
 */
export function declaresOwnOverflow(className?: string): boolean {
  if (!className) return false;
  return /(?:^|\s)overflow-(?:x-|y-)?(?:auto|scroll|hidden|clip|visible)(?:\s|$)/.test(className);
}

const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  DialogContentProps
>(({ className, children, overlayClassName, overlayStyle, bareLayout = false, ...props }, ref) => (
  <DialogPortal>
    <DialogOverlay className={overlayClassName} style={overlayStyle} />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        // Neutral surface + fade shared by every dialog (bespoke and default).
        // Glass surface from `.luxury-dialog-content`; no bg/shadow utility.
        "luxury-dialog-content fixed z-50 border duration-200",
        "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
        // Default treatment: mobile (<640px) bottom sheet sliding up; ≥sm classic centered modal.
        !bareLayout && [
          "grid gap-4",
          "inset-x-0 bottom-0 top-auto w-full max-w-none rounded-t-2xl border-x-0 border-b-0 p-4 pb-[max(1rem,env(safe-area-inset-bottom))] max-h-[92dvh] overflow-y-auto",
          "data-[state=closed]:slide-out-to-bottom data-[state=open]:slide-in-from-bottom",
          "sm:inset-auto sm:left-[50%] sm:top-[50%] sm:bottom-auto sm:translate-x-[-50%] sm:translate-y-[-50%] sm:w-full sm:rounded-lg sm:border sm:p-6 sm:pb-6",
          // Each default is withheld when the caller states its own — see
          // `declaresOwnWidth`, `declaresOwnMaxHeight` and
          // `declaresOwnOverflow`. 135 dialogs asked for a width, 110 for a
          // height and 99 for an overflow, and none of the three arrived.
          !declaresOwnWidth(className) && "sm:max-w-lg",
          !declaresOwnMaxHeight(className) && "sm:max-h-[85dvh]",
          !declaresOwnOverflow(className) && "sm:overflow-visible",
          "sm:data-[state=closed]:zoom-out-95 sm:data-[state=open]:zoom-in-95 sm:data-[state=closed]:slide-out-to-left-1/2 sm:data-[state=closed]:slide-out-to-top-[48%] sm:data-[state=open]:slide-in-from-left-1/2 sm:data-[state=open]:slide-in-from-top-[48%]",
        ],
        className
      )}
      {...props}
    >
      {children}
      <DialogPrimitive.Close className="absolute right-4 top-4 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none data-[state=open]:bg-accent data-[state=open]:text-muted-foreground min-h-[44px] min-w-[44px] sm:min-h-0 sm:min-w-0 flex items-center justify-center touch-manipulation">
        <X className="h-5 w-5 sm:h-4 sm:w-4" />
        <span className="sr-only">Close</span>
      </DialogPrimitive.Close>
    </DialogPrimitive.Content>
  </DialogPortal>
))
DialogContent.displayName = DialogPrimitive.Content.displayName

const DialogHeader = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "flex flex-col space-y-1.5 text-center sm:text-left",
      className
    )}
    {...props}
  />
)
DialogHeader.displayName = "DialogHeader"

const DialogFooter = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2",
      className
    )}
    {...props}
  />
)
DialogFooter.displayName = "DialogFooter"

const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn(
      "text-lg font-semibold leading-none tracking-tight",
      className
    )}
    {...props}
  />
))
DialogTitle.displayName = DialogPrimitive.Title.displayName

const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn("text-sm text-muted-foreground", className)}
    {...props}
  />
))
DialogDescription.displayName = DialogPrimitive.Description.displayName

export {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogClose,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
}
