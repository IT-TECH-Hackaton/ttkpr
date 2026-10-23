import { cn } from "@ttkpr/ui";
import { ArrowUpDown, MapPin, X } from "lucide-react";
import type { End } from "../lib/routing";

interface Props {
  fromLabel: string | null;
  toLabel: string | null;
  onEdit: (end: End) => void;
  onSwap: () => void;
  onClose: () => void;
}

/** "Откуда → куда" at the top of the screen while a route is open. */
export function RouteCard({ fromLabel, toLabel, onEdit, onSwap, onClose }: Props) {
  return (
    <div className="flex items-stretch gap-1 rounded-2xl border border-border bg-bg p-1.5 shadow-lg">
      <div className="flex w-7 flex-col items-center py-4" aria-hidden>
        <span className="size-3 rounded-full border-[3px] border-green-600" />
        <span className="my-1 w-0 flex-1 border-l-2 border-dotted border-muted/50" />
        <MapPin className="size-4 text-red-600" />
      </div>
      <div className="min-w-0 flex-1 divide-y divide-border">
        <EndButton
          label="Откуда"
          value={fromLabel}
          placeholder="Выберите начало"
          onClick={() => onEdit("from")}
        />
        <EndButton
          label="Куда"
          value={toLabel}
          placeholder="Выберите место"
          onClick={() => onEdit("to")}
        />
      </div>
      <div className="flex flex-col justify-between">
        <button
          type="button"
          aria-label="Закрыть маршрут"
          onClick={onClose}
          className="grid size-11 place-items-center rounded-xl text-muted active:bg-surface"
        >
          <X className="size-5" />
        </button>
        <button
          type="button"
          aria-label="Поменять начало и конец местами"
          onClick={onSwap}
          disabled={!fromLabel && !toLabel}
          className="grid size-11 place-items-center rounded-xl text-muted active:bg-surface disabled:opacity-40"
        >
          <ArrowUpDown className="size-5" />
        </button>
      </div>
    </div>
  );
}

function EndButton({
  label,
  value,
  placeholder,
  onClick,
}: {
  label: string;
  value: string | null;
  placeholder: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex min-h-12 w-full flex-col justify-center px-2 py-1 text-left"
    >
      <span className="text-xs text-muted">{label}</span>
      <span className={cn("truncate font-medium", !value && "text-accent")}>
        {value ?? placeholder}
      </span>
    </button>
  );
}
