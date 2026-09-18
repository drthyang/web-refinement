import { useEffect, useRef } from "react";

/**
 * Run `onChange` when `value` (by identity) differs from the previous render's
 * — but NOT on mount. The plain `useEffect(fn, [value])` idiom fires once on
 * mount too, which wipes state a page seeded from a saved project before the
 * user sees it; "reset when the structure changes" means exactly that.
 * `onChange` is read at fire time, so it may close over fresh state.
 */
export function useOnChange<T>(value: T, onChange: () => void): void {
  const last = useRef(value);
  useEffect(() => {
    if (last.current === value) return;
    last.current = value;
    onChange();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onChange is read at fire time by design
  }, [value]);
}
