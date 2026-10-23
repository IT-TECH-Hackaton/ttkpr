import type { Level } from "@ttkpr/api-client";
import { cn } from "@ttkpr/ui";

interface Props {
  levels: Level[];
  value: string;
  onChange: (levelId: string) => void;
}

export function LevelSwitcher({ levels, value, onChange }: Props) {
  if (levels.length < 2) return null;
  // Highest floor on top, like in a lift.
  const ordered = [...levels].reverse();
  return (
    <fieldset
      aria-label="Этаж"
      className="flex flex-col overflow-hidden rounded-2xl border border-border bg-bg shadow-lg"
    >
      {ordered.map((level) => (
        <button
          key={level.id}
          type="button"
          aria-pressed={level.id === value}
          aria-label={level.name}
          onClick={() => onChange(level.id)}
          className={cn(
            "h-12 w-12 text-base font-semibold",
            level.id === value ? "bg-accent text-accent-fg" : "text-fg",
          )}
        >
          {level.ordinal >= 0 ? level.ordinal + 1 : level.ordinal}
        </button>
      ))}
    </fieldset>
  );
}
