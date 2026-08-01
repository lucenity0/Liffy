import { useEffect, useState } from "react";

/**
 * Trails `value` by `delay` ms, so a control can stay responsive while the
 * thing it drives does not fire on every keystroke.
 *
 * The reviews list needs this for the PR number box: typing "203" is three
 * renders, and without a delay it is also three requests — for PR 2, PR 20
 * and PR 203 — of which only the last is a question anyone asked.
 *
 * The timer resets on every change and is cleared on unmount, so a fast typist
 * causes exactly one settle and a component that leaves mid-type causes none.
 */
export function useDebouncedValue<T>(value: T, delay = 300): T {
  const [settled, setSettled] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);

  return settled;
}
