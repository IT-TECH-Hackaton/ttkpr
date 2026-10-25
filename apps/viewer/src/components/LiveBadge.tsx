import { cn } from "@ttkpr/ui";
import { LIVE_LABELS, type LivePlace } from "../lib/live";

/** «Открыто», «Очередь · ~10 минут», «Закрыто» next to a place. */
export function LiveBadge({ place, className }: { place?: LivePlace; className?: string }) {
  if (!place) return null;
  const { label, tone } = LIVE_LABELS[place.status];
  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold",
        tone,
        className,
      )}
    >
      <span className="size-1.5 shrink-0 rounded-full bg-current" aria-hidden />
      <span className="truncate">{place.note ? `${label} · ${place.note}` : label}</span>
    </span>
  );
}
