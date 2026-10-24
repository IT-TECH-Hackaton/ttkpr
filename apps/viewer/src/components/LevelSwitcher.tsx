import type { Level } from "@ttkpr/api-client";
import { ChevronDown, ChevronUp } from "lucide-react";

interface Props {
  levels: Level[];
  value: string;
  onChange: (levelId: string) => void;
}

/** Floor up / down with the current floor's number beside the arrows, like a lift panel. */
export function LevelSwitcher({ levels, value, onChange }: Props) {
  if (levels.length < 2) return null;
  const index = Math.max(
    0,
    levels.findIndex((l) => l.id === value),
  );
  const current = levels[index];
  const above = levels[index + 1];
  const below = levels[index - 1];
  const number = current ? (current.ordinal >= 0 ? current.ordinal + 1 : current.ordinal) : "";
  const arrow =
    "grid h-11 w-12 place-items-center text-fg disabled:text-muted/40 enabled:active:bg-surface";
  return (
    <fieldset aria-label="Этаж" className="flex items-center gap-2">
      <span
        className="rounded-xl border border-border bg-bg px-2.5 py-1.5 text-sm font-semibold shadow-lg"
        aria-live="polite"
      >
        {number} этаж
      </span>
      <span className="flex flex-col overflow-hidden rounded-2xl border border-border bg-bg shadow-lg">
        <button
          type="button"
          aria-label="Этаж выше"
          disabled={!above}
          onClick={() => above && onChange(above.id)}
          className={arrow}
        >
          <ChevronUp className="size-6" aria-hidden />
        </button>
        <span className="h-px bg-border" aria-hidden />
        <button
          type="button"
          aria-label="Этаж ниже"
          disabled={!below}
          onClick={() => below && onChange(below.id)}
          className={arrow}
        >
          <ChevronDown className="size-6" aria-hidden />
        </button>
      </span>
    </fieldset>
  );
}
