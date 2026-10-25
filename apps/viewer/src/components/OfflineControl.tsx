import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { plural } from "@ttkpr/map-core";
import { Button } from "@ttkpr/ui";
import { useState } from "react";
import { formatBytes, getSavedMap, removeSavedMap, saveMapOffline } from "../lib/offline";
import { useOnline } from "../lib/useOnline";

interface Props {
  slug: string;
  /** Version currently published (from the manifest that opened this map). */
  version: number | undefined;
}

export function OfflineControl({ slug, version }: Props) {
  const queryClient = useQueryClient();
  const online = useOnline();
  const [progress, setProgress] = useState(0);
  const saved = useQuery({
    queryKey: ["saved", slug],
    queryFn: async () => (await getSavedMap(slug)) ?? null,
    networkMode: "always",
  });
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["saved"] });
  };
  const save = useMutation({
    mutationFn: () => saveMapOffline(slug, setProgress),
    onSettled: () => {
      setProgress(0);
      refresh();
    },
    networkMode: "always",
  });
  const remove = useMutation({
    mutationFn: () => removeSavedMap(slug),
    onSettled: refresh,
    networkMode: "always",
  });

  if (!("caches" in window)) return null;
  const record = saved.data;
  const outdated = record && version !== undefined && record.version < version;

  if (save.isPending) {
    return (
      <div className="space-y-2 rounded-2xl bg-surface p-3" aria-live="polite">
        <p className="text-sm font-medium">
          Сохраняем карту и панорамы… {Math.round(progress * 100)}%
        </p>
        <div className="h-2 overflow-hidden rounded-full bg-border">
          <div
            className="h-full bg-accent transition-all"
            style={{ width: `${progress * 100}%` }}
          />
        </div>
      </div>
    );
  }

  if (!record) {
    return (
      <div className="space-y-1">
        <Button
          variant="secondary"
          className="w-full"
          disabled={!online}
          onClick={() => save.mutate()}
        >
          Сохранить карту офлайн
        </Button>
        {!online && <p className="text-xs text-muted">Нет сети</p>}
        {save.error && <p className="text-sm text-danger">Не удалось сохранить</p>}
      </div>
    );
  }

  return (
    <div className="space-y-2 rounded-2xl bg-surface p-3">
      <p className="text-sm">
        Сохранена · {formatBytes(record.bytes)}
        {record.panoramas > 0 &&
          ` · ${plural(record.panoramas, ["панорама", "панорамы", "панорам"])}`}
      </p>
      <div className="flex gap-2">
        {outdated && (
          <Button
            className="min-h-9 flex-1 text-sm"
            disabled={!online}
            onClick={() => save.mutate()}
          >
            Обновить до новой версии
          </Button>
        )}
        <Button
          variant="ghost"
          className="min-h-9 text-sm text-danger"
          onClick={() => remove.mutate()}
        >
          Удалить с устройства
        </Button>
      </div>
    </div>
  );
}
