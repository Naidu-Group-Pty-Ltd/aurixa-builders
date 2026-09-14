import * as React from 'react';
import { Search, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/input';

/**
 * The search field, defined once.
 *
 * ## Why this exists
 *
 * A search box with text in it and no way to empty it is a dead end: the
 * only exit is selecting the text and deleting it, which on a touch screen
 * is a fiddle and with a filter chip beside it reads as "the page is stuck".
 * The clear control was added to the client tracker first, by hand; 90 of
 * the app's 104 stateful search fields still had no way out. Hand-rolling it
 * 90 more times would guarantee 90 slightly different affordances, so the
 * field itself is now a component and the behaviour comes with it.
 *
 * ## What it guarantees
 *
 * - A clear (✕) control appears exactly when there is something to clear,
 *   and returns focus to the input so typing can continue immediately.
 * - **Escape clears** while the field has focus — the keyboard equivalent,
 *   which the mouse-only version never had.
 * - The control is a real `<button type="button">`: it is reachable by
 *   keyboard, it is never a submit, and it carries an accessible name
 *   derived from the field's own label so a screen reader hears which
 *   search is being cleared.
 * - The input reserves right-hand padding only while the control is shown,
 *   so an empty field is not permanently indented for a button that is not
 *   there.
 *
 * ## Layout contract
 *
 * It renders the shape the app already used — a `relative` wrapper, an
 * absolutely-positioned search icon, and the input padded clear of both —
 * so `className` still lands on the INPUT (as it did at every call site
 * before this) and `containerClassName` addresses the wrapper. Getting that
 * the wrong way round would have silently moved every `flex-1`, `w-64` and
 * `pl-9` in the codebase onto the wrong element.
 */
export interface SearchInputProps
  extends Omit<React.ComponentProps<'input'>, 'value' | 'onChange' | 'type'> {
  value: string;
  /** Called with the new text, and with '' when the field is cleared. */
  onValueChange: (value: string) => void;
  /** Classes for the wrapper. `className` stays on the input. */
  containerClassName?: string;
  /** Classes for the magnifier, e.g. to match a call site's own offsets. */
  iconClassName?: string;
  /** Hide the magnifier where the call site draws its own. */
  hideIcon?: boolean;
  /** Escape clears by default; opt out where Escape must close a dialog. */
  clearOnEscape?: boolean;
  /** Extra work on clear — refocusing is handled here already. */
  onClear?: () => void;
}

export const SearchInput = React.forwardRef<HTMLInputElement, SearchInputProps>(
  (
    {
      value,
      onValueChange,
      className,
      containerClassName,
      iconClassName,
      hideIcon = false,
      clearOnEscape = true,
      onClear,
      onKeyDown,
      placeholder = 'Search...',
      'aria-label': ariaLabel,
      ...props
    },
    forwardedRef,
  ) => {
    const innerRef = React.useRef<HTMLInputElement | null>(null);
    const setRefs = React.useCallback(
      (node: HTMLInputElement | null) => {
        innerRef.current = node;
        if (typeof forwardedRef === 'function') forwardedRef(node);
        else if (forwardedRef) forwardedRef.current = node;
      },
      [forwardedRef],
    );

    const hasValue = value.length > 0;
    // The button names the field it empties: "Clear search" alone is
    // ambiguous on a page carrying three of them.
    const label = ariaLabel || (typeof placeholder === 'string' ? placeholder : 'search');
    const clearLabel = `Clear ${label.replace(/\.{3}|…/g, '').trim().toLowerCase()}`;

    const clear = React.useCallback(() => {
      onValueChange('');
      onClear?.();
      innerRef.current?.focus();
    }, [onValueChange, onClear]);

    return (
      <div className={cn('relative', containerClassName)}>
        {!hideIcon && (
          <Search
            aria-hidden
            className={cn(
              'pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground',
              iconClassName,
            )}
          />
        )}
        <Input
          ref={setRefs}
          type="text"
          value={value}
          placeholder={placeholder}
          aria-label={ariaLabel || (typeof placeholder === 'string' ? placeholder : undefined)}
          onChange={(event) => onValueChange(event.target.value)}
          onKeyDown={(event) => {
            if (clearOnEscape && event.key === 'Escape' && value.length > 0) {
              // Stop here: an Escape that clears the field must not also
              // close the dialog the field sits in.
              event.preventDefault();
              event.stopPropagation();
              clear();
              return;
            }
            onKeyDown?.(event);
          }}
          className={cn(!hideIcon && 'pl-9', hasValue && 'pr-9', className)}
          {...props}
        />
        {hasValue && (
          <button
            type="button"
            onClick={clear}
            aria-label={clearLabel}
            title={clearLabel}
            className="absolute right-1.5 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-primary/10 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
    );
  },
);
SearchInput.displayName = 'SearchInput';
