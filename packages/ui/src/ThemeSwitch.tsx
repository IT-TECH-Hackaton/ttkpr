import { cn } from "./cn";
import { setThemePreference, THEME_LABELS, type ThemePreference, useTheme } from "./theme";

const ORDER: ThemePreference[] = ["system", "light", "dark"];

/** Segmented "Как в системе / Светлая / Тёмная"; the choice is remembered on this device. */
export function ThemeSwitch({ className }: { className?: string }) {
  const { preference } = useTheme();
  return (
    <fieldset className={cn("flex rounded-xl bg-surface p-1 text-sm", className)}>
      <legend className="sr-only">Тема оформления</legend>
      {ORDER.map((option) => (
        <button
          key={option}
          type="button"
          aria-pressed={preference === option}
          onClick={() => setThemePreference(option)}
          className={cn(
            "min-h-9 flex-1 whitespace-nowrap rounded-lg px-2 font-medium transition",
            preference === option ? "bg-bg text-fg shadow" : "text-muted",
          )}
        >
          {THEME_LABELS[option]}
        </button>
      ))}
    </fieldset>
  );
}
