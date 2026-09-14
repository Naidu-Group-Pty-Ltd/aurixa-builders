import * as React from "react"
import * as TooltipPrimitive from "@radix-ui/react-tooltip"

import { cn } from "@/lib/utils"

const TooltipProvider = TooltipPrimitive.Provider

const Tooltip = TooltipPrimitive.Root

const TooltipTrigger = TooltipPrimitive.Trigger

/**
 * Tooltip content is rendered through a Portal.
 *
 * Without it the content is laid out inline beside its trigger, so any
 * ancestor that clips — a ScrollArea viewport, a Card with `overflow-hidden`,
 * the calendar tool rail — slices the tooltip in half. Radix still *positions*
 * it correctly, which is why the symptom reads as "the text runs outside the
 * frame" rather than as a tooltip that never opened. `glass.css` has always
 * styled `.luxury-tooltip-content` as a portalled overlay; this makes the
 * component agree with the stylesheet.
 *
 * `collisionPadding` keeps the content off the viewport edge so a tooltip on a
 * first- or last-column trigger flips rather than butting against the frame.
 */
const TooltipContent = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, sideOffset = 4, collisionPadding = 8, ...props }, ref) => (
  <TooltipPrimitive.Portal>
    <TooltipPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      collisionPadding={collisionPadding}
      className={cn(
        "luxury-tooltip-content z-50 max-w-[min(24rem,calc(100vw-2rem))] overflow-hidden rounded-md border px-3 py-1.5 text-sm text-popover-foreground animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2",
        className
      )}
      {...props}
    />
  </TooltipPrimitive.Portal>
))
TooltipContent.displayName = TooltipPrimitive.Content.displayName

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider }
