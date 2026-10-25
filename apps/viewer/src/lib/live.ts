import { useQuery } from "@tanstack/react-query";

export type LiveStatus = "open" | "busy" | "closed";
export interface LivePlace {
  status: LiveStatus;
  note: string | null;
}

export const LIVE_LABELS: Record<LiveStatus, { label: string; tone: string }> = {
  open: {
    label: "Открыто",
    tone: "bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200",
  },
  busy: {
    label: "Очередь",
    tone: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200",
  },
  closed: { label: "Закрыто", tone: "bg-red-100 text-red-900 dark:bg-red-950 dark:text-red-200" },
};

/**
 * Organizer-set statuses of places, polled every 30 s while the tab is visible. Off the critical
 * path: the map opens without it, and a failure just leaves the badges out.
 */
export function useLive(slug: string, enabled: boolean) {
  return useQuery({
    queryKey: ["live", slug],
    queryFn: async (): Promise<Record<string, LivePlace>> => {
      const response = await fetch(`/api/public/maps/${encodeURIComponent(slug)}/live.json`);
      if (!response.ok) return {};
      return ((await response.json()) as { places: Record<string, LivePlace> }).places;
    },
    enabled,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
    retry: false,
  });
}
