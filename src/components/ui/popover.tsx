import * as React from "react"
import * as PopoverPrimitive from "@radix-ui/react-popover"

import { cn } from "@/lib/utils"

const Popover = PopoverPrimitive.Root

const PopoverTrigger = PopoverPrimitive.Trigger

/**
 * Audit item 3 — a popover taller than the space it opens into.
 *
 * The follow-up popover on a client card is ~560px of form and calendar. It
 * opened downward from the bell, ran off the bottom of the window, and was
 * read by scrolling the PAGE — which worked well enough to look intended.
 * Filter the client list to five results and the page is no longer tall
 * enough to scroll: Radix flips the popover upward, the top of it goes off
 * the top of the window, and the title field and its label cannot be reached
 * by any means. Nothing is broken on screen — the form is simply not all
 * there.
 *
 * A popover is not allowed to borrow the page's scrollbar. Radix already
 * measures the room it has and publishes it as
 * `--radix-popover-content-available-height`; nothing here had ever read it,
 * so the content rendered at its natural height whatever the room. Bounding
 * to that measurement and scrolling INSIDE means the flip stays a flip
 * instead of becoming a truncation.
 *
 * Safe across the 71 files that draw one. A popover that already fits is
 * unchanged: `overflow-y: auto` shows no scrollbar until there is something
 * to scroll, and the height ceiling is above its natural height. Nested
 * Radix content (Select, Tooltip, another Popover) is portalled and so is
 * not clipped by the new overflow context, and no popover in the repository
 * positions a child outside its own box — checked, not assumed. The two that
 * set their own `overflow-hidden` (`DateRangePicker`, `CallLogs`) keep it,
 * because `cn` is tailwind-merge and the caller wins.
 *
 * `collisionPadding` keeps the content off the window edge, for the same
 * reason it is set on the tooltip primitive (audit items 1 and 32).
 */
const PopoverContent = React.forwardRef<
  React.ElementRef<typeof PopoverPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>
>(({ className, align = "center", sideOffset = 4, collisionPadding = 8, ...props }, ref) => (
  <PopoverPrimitive.Portal>
    <PopoverPrimitive.Content
      ref={ref}
      align={align}
      sideOffset={sideOffset}
      collisionPadding={collisionPadding}
      className={cn(
        "luxury-popover-content z-50 w-72 rounded-md border p-4 text-popover-foreground outline-none max-h-[var(--radix-popover-content-available-height)] overflow-y-auto data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2",
        className
      )}
      {...props}
    />
  </PopoverPrimitive.Portal>
))
PopoverContent.displayName = PopoverPrimitive.Content.displayName

export { Popover, PopoverTrigger, PopoverContent }
