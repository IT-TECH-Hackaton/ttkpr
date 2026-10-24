import { useState } from "react";
import { fetchIconSvg, fetchSvgUrl, iconPreviewUrl, ROOM_ICON_PRESETS } from "../lib/iconSearch";
import { useDraft } from "../store";

const field =
  "w-full rounded-xl border border-border bg-bg px-3 py-2 outline-none focus:border-accent";

export function RoomIconField({ unitId }: { unitId: string }) {
  const icon = useDraft((s) => s.doc.units?.find((u) => u.id === unitId)?.icon);
  const iconSvg = useDraft((s) => s.doc.units?.find((u) => u.id === unitId)?.iconSvg);
  const [url, setUrl] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
  const preset = ROOM_ICON_PRESETS.find((item) => item.id === icon);

  const apply = (id: string, svg: string) => {
    useDraft.getState().updateUnit(unitId, { icon: id, iconSvg: svg });
    setStatus("idle");
    setUrl("");
  };

  const choose = (id: string) => {
    setStatus("loading");
    void fetchIconSvg(id)
      .then((svg) => apply(id, svg))
      .catch(() => setStatus("error"));
  };

  const paste = () => {
    const raw = url.trim();
    if (!raw) return;
    setStatus("loading");
    void fetchSvgUrl(raw)
      .then(({ id, svg }) => apply(id, svg))
      .catch(() => setStatus("error"));
  };

  const preview = iconSvg ? `data:image/svg+xml,${encodeURIComponent(iconSvg)}` : null;

  return (
    <div className="space-y-2">
      <span className="block text-sm text-muted">Иконка</span>
      {icon && preview && (
        <div className="flex items-center gap-2">
          <span className="grid size-9 shrink-0 place-items-center rounded-full bg-blue-700">
            <img src={preview} alt="" className="size-5" />
          </span>
          <span className="min-w-0 flex-1 truncate text-sm">{preset?.label ?? "Своя"}</span>
          <button
            type="button"
            className="text-sm text-danger"
            onClick={() => useDraft.getState().updateUnit(unitId, { icon: null, iconSvg: null })}
          >
            Убрать
          </button>
        </div>
      )}
      <label htmlFor="unit-icon-url" className="block text-sm text-muted">
        Ссылка на SVG
      </label>
      <div className="flex gap-2">
        <input
          id="unit-icon-url"
          className={field}
          value={url}
          placeholder="https://api.iconify.design/mdi/security.svg"
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              paste();
            }
          }}
        />
        <button
          type="button"
          className="shrink-0 rounded-xl bg-surface px-3 text-sm"
          disabled={status === "loading" || !url.trim()}
          onClick={paste}
        >
          Вставить
        </button>
      </div>
      <p className="text-xs text-muted">
        {status === "loading"
          ? "Загружаем…"
          : status === "error"
            ? "Нужна https-ссылка на SVG, например с Iconify."
            : "Свой знак — ссылкой. Ниже готовые."}
      </p>
      <div className="grid grid-cols-4 gap-1.5">
        {ROOM_ICON_PRESETS.map((item) => (
          <button
            key={item.id}
            type="button"
            aria-label={item.label}
            aria-pressed={item.id === icon}
            disabled={status === "loading"}
            onClick={() => choose(item.id)}
            className={`flex flex-col items-center gap-1 rounded-xl bg-white px-1 py-1.5 text-[10px] leading-tight text-slate-900 ${
              item.id === icon ? "ring-2 ring-accent" : ""
            }`}
          >
            <img src={iconPreviewUrl(item.id)} alt="" className="size-6" />
            {item.label}
          </button>
        ))}
      </div>
    </div>
  );
}
