import { useSyncExternalStore } from "react";

/** Live result of a CSS media query (false where matchMedia is unavailable). */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

/** Tablets in landscape and desktops: a side panel instead of the bottom sheet. */
export const WIDE_QUERY = "(min-width: 900px)";
