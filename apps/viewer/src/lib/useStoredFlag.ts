import { useCallback, useState } from "react";

/** An on/off preference remembered on this device (private mode or blocked storage: not kept). */
export function useStoredFlag(key: string, fallback: boolean): [boolean, (value: boolean) => void] {
  const [value, setValue] = useState(() => {
    try {
      const stored = localStorage.getItem(key);
      return stored === null ? fallback : stored === "1";
    } catch {
      return fallback;
    }
  });
  const update = useCallback(
    (next: boolean) => {
      setValue(next);
      try {
        localStorage.setItem(key, next ? "1" : "0");
      } catch {
        // Storage unavailable: the choice lasts until the page is closed.
      }
    },
    [key],
  );
  return [value, update];
}
