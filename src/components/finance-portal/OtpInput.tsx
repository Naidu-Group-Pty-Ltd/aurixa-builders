import { useRef, useCallback, KeyboardEvent, ClipboardEvent } from 'react';
import { cn } from '@/lib/utils';

interface OtpInputProps {
  value: string;
  onChange: (value: string) => void;
  length?: number;
  disabled?: boolean;
}

export function OtpInput({ value, onChange, length = 6, disabled = false }: OtpInputProps) {
  const inputsRef = useRef<(HTMLInputElement | null)[]>([]);
  const digits = value.padEnd(length, '').split('').slice(0, length);

  const focusInput = (index: number) => {
    const clamped = Math.max(0, Math.min(index, length - 1));
    inputsRef.current[clamped]?.focus();
  };

  /**
   * The code has no holes: a digit typed into a box beyond the filled length
   * lands in the first empty box, and the caret follows it there.
   *
   * The previous version wrote the digit at the box's own index into a
   * space-padded array and then stripped the spaces, so typing into box 3 of an
   * empty field put that digit in box 1 while the caret moved to box 4 — the
   * value and what the user could see disagreed from that point on.
   */
  const handleChange = useCallback((index: number, char: string) => {
    const digit = char.replace(/\D/g, '').slice(0, 1);
    if (!digit) return;

    const target = Math.min(index, value.length);
    const arr = value.split('');
    arr[target] = digit;
    onChange(arr.join('').slice(0, length));

    focusInput(target + 1);
  }, [value, length, onChange]);

  const handleKeyDown = useCallback((index: number, e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace') {
      e.preventDefault();
      const arr = value.split('');
      if (arr[index]) {
        arr.splice(index, 1);
        onChange(arr.join(''));
      } else if (index > 0) {
        const previous = Math.min(index - 1, arr.length - 1);
        if (previous >= 0) {
          arr.splice(previous, 1);
          onChange(arr.join(''));
        }
        focusInput(previous < 0 ? 0 : previous);
      }
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      focusInput(index - 1);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      focusInput(index + 1);
    }
  }, [value, length, onChange]);

  const handlePaste = useCallback((e: ClipboardEvent<HTMLInputElement>) => {
    e.preventDefault();
    const pasted = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, length);
    if (pasted) {
      onChange(pasted);
      focusInput(Math.min(pasted.length, length - 1));
    }
  }, [length, onChange]);

  return (
    <div
      className="flex items-center justify-center gap-2"
      role="group"
      aria-label={`${length}-digit verification code`}
    >
      {Array.from({ length }, (_, i) => (
        <input
          key={i}
          ref={el => { inputsRef.current[i] = el; }}
          type="text"
          inputMode="numeric"
          autoComplete={i === 0 ? 'one-time-code' : 'off'}
          maxLength={1}
          value={digits[i]?.trim() || ''}
          disabled={disabled}
          aria-label={`Digit ${i + 1} of ${length}`}
          className={cn(
            'w-11 h-13 text-center text-xl font-mono font-semibold rounded-xl border border-border bg-background',
            'focus:outline-none focus:ring-2 focus:ring-primary focus:border-primary',
            'transition-all duration-150',
            'disabled:opacity-50 disabled:cursor-not-allowed',
            digits[i]?.trim() ? 'border-primary/40' : ''
          )}
          onChange={e => handleChange(i, e.target.value)}
          onKeyDown={e => handleKeyDown(i, e)}
          onPaste={handlePaste}
          onFocus={e => e.target.select()}
        />
      ))}
    </div>
  );
}
