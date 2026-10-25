import {
  formatDistance,
  formatDuration,
  type MapBundle,
  type Route,
  type RouteStep,
  stepDistance,
} from "@ttkpr/map-core";
import { Button, cn } from "@ttkpr/ui";
import { Accessibility, Share2, View } from "lucide-react";
import { useState } from "react";
import { StepIcon } from "./StepIcon";

interface Props {
  bundle: MapBundle;
  /** Organizer's note on a tour. */
  description?: string | null;
  route: Route | null;
  problem: string | null;
  /** Which end is still missing. */
  missing: "from" | "to" | null;
  avoidStairs: boolean;
  onToggleStairs: () => void;
  panoCount: number;
  /** Longest stretch without panoramas, meters. */
  gapM: number;
  onWalk: () => void;
  onStep: (step: RouteStep) => void;
}

/** Bottom-sheet content of an open route: time, options, walkthrough, step list. */
export function RoutePanel({
  bundle,
  description,
  route,
  problem,
  missing,
  avoidStairs,
  onToggleStairs,
  panoCount,
  gapM,
  onWalk,
  onStep,
}: Props) {
  const levelName = (id: string) => bundle.levels?.find((l) => l.id === id)?.name ?? "";
  const hasFloors = (bundle.connectors?.length ?? 0) > 0;
  const stairsToggle = hasFloors && (
    <button
      type="button"
      aria-pressed={avoidStairs}
      onClick={onToggleStairs}
      className={cn(
        "inline-flex min-h-10 shrink-0 items-center gap-1.5 rounded-full border px-3 text-sm font-medium",
        avoidStairs ? "border-accent bg-accent text-accent-fg" : "border-border bg-bg text-fg",
      )}
    >
      <Accessibility className="size-4" aria-hidden />
      Без ступенек
    </button>
  );

  if (!route) {
    return (
      <section aria-label="Маршрут" className="space-y-3">
        <div className="flex items-start gap-3">
          <p className="flex-1 leading-snug">
            {problem ??
              (missing === "from"
                ? "Выберите, откуда идти: место из списка, точку на плане или отсканируйте QR-код «Вы здесь» на площадке."
                : "Выберите, куда идти.")}
          </p>
          {problem && stairsToggle}
        </div>
      </section>
    );
  }

  const floors = [...new Set(route.legs.map((l) => levelName(l.levelId)))].join(" → ");
  return (
    <section aria-label="Маршрут" className="space-y-3">
      {description && <p className="leading-relaxed text-muted">{description}</p>}
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-2xl font-semibold leading-none">{formatDuration(route.durationS)}</p>
          <p className="mt-1 truncate text-sm text-muted">
            {formatDistance(route.distanceM)} · {floors}
          </p>
        </div>
        {stairsToggle}
      </div>
      <div className="flex gap-2">
        <Button className="min-w-0 flex-1" disabled={panoCount === 0} onClick={onWalk}>
          <View className="size-5" aria-hidden />
          {panoCount > 0 ? "Пройти по панорамам" : "На этом пути нет панорам"}
        </Button>
        <ShareRoute />
      </div>
      {panoCount > 0 && gapM > 20 && (
        <p className="text-center text-xs text-muted">Панорамы есть не на всём пути</p>
      )}
      <ol aria-label="Шаги маршрута" className="divide-y divide-border">
        {route.steps.map((step, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: steps of one route never reorder
          <li key={i}>
            <button
              type="button"
              onClick={() => onStep(step)}
              className="flex min-h-14 w-full items-center gap-3 py-1 text-left"
            >
              <StepIcon step={step} />
              <span className="min-w-0 flex-1">
                <span className="block leading-snug">{step.text}</span>
                {stepDistance(step) && (
                  <span className="block text-sm text-muted">{stepDistance(step)}</span>
                )}
              </span>
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** The route is all in the link: the phone's share sheet, or the clipboard on a computer. */
function ShareRoute() {
  const [copied, setCopied] = useState(false);
  const share = async () => {
    const url = new URL(window.location.href);
    for (const key of ["walk", "pano", "level", "preview"]) url.searchParams.delete(key);
    const link = url.toString();
    if (navigator.share) {
      await navigator.share({ title: document.title, url: link }).catch(() => undefined);
      return;
    }
    await navigator.clipboard?.writeText(link).catch(() => undefined);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };
  return (
    <Button
      variant="secondary"
      className="shrink-0 px-3"
      aria-label="Поделиться маршрутом"
      title="Поделиться маршрутом"
      onClick={() => void share()}
    >
      <Share2 className="size-5" aria-hidden />
      {copied && <span className="text-sm">Скопировано</span>}
    </Button>
  );
}
