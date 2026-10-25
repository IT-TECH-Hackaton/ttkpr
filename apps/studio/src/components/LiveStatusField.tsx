import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { clearLiveStatus, listLive, setLiveStatus } from "@ttkpr/api-client";
import { cn } from "@ttkpr/ui";
import { unwrap } from "../lib/api";

type Status = "open" | "busy" | "closed";

const OPTIONS: { id: Status | null; label: string; tone: string }[] = [
  { id: null, label: "Нет", tone: "" },
  { id: "open", label: "Открыто", tone: "bg-emerald-600 text-white" },
  { id: "busy", label: "Очередь", tone: "bg-amber-500 text-white" },
  { id: "closed", label: "Закрыто", tone: "bg-red-600 text-white" },
];

/** The place's status right now: visitors see it within ~30 s, no republishing. */
export function LiveStatusField({ mapId, poiId }: { mapId: string; poiId: string }) {
  const key = ["live", mapId];
  const client = useQueryClient();
  const live = useQuery({
    queryKey: key,
    queryFn: () => unwrap(listLive({ path: { map_id: mapId } })),
  });
  const change = useMutation({
    mutationFn: async (status: Status | null): Promise<void> => {
      const path = { map_id: mapId, poi_id: poiId };
      if (status) await unwrap(setLiveStatus({ path, body: { status } }));
      else await unwrap(clearLiveStatus({ path }));
    },
    onSuccess: () => client.invalidateQueries({ queryKey: key }),
  });
  const current = (live.data?.places[poiId]?.status ?? null) as Status | null;
  return (
    <fieldset className="space-y-1.5">
      <legend className="text-sm font-medium">Сейчас</legend>
      <div className="grid grid-cols-4 gap-1 rounded-xl bg-surface p-1">
        {OPTIONS.map((o) => (
          <button
            key={o.label}
            type="button"
            aria-pressed={current === o.id}
            disabled={change.isPending}
            onClick={() => change.mutate(o.id)}
            className={cn(
              "min-h-9 rounded-lg text-xs font-semibold",
              current === o.id ? o.tone || "bg-bg shadow" : "text-muted",
            )}
          >
            {o.label}
          </button>
        ))}
      </div>
      {change.error && <p className="text-xs text-danger">{change.error.message}</p>}
    </fieldset>
  );
}
