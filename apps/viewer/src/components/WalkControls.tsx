import { formatDistance, type RouteStep } from "@ttkpr/map-core";
import { Button } from "@ttkpr/ui";
import { ChevronLeft, ChevronRight, Pause, Play } from "lucide-react";
import { StepIcon } from "./StepIcon";

interface Props {
  index: number;
  total: number;
  next: { step: RouteStep; inM: number } | null;
  auto: boolean;
  onPrev: () => void;
  onNext: () => void;
  onToggleAuto: () => void;
  onFinish: () => void;
}

/** Bottom card while walking a route through panoramas. */
export function WalkControls({
  index,
  total,
  next,
  auto,
  onPrev,
  onNext,
  onToggleAuto,
  onFinish,
}: Props) {
  const last = index >= total - 1;
  return (
    <div className="safe-bottom pointer-events-none absolute inset-x-0 bottom-0 px-3">
      <div className="pointer-events-auto mx-auto max-w-md space-y-3 rounded-2xl bg-bg/95 p-3 text-fg shadow-2xl backdrop-blur">
        {next && (
          <div className="flex items-center gap-3" aria-live="polite">
            <StepIcon step={next.step} />
            <div className="min-w-0 flex-1">
              <p className="font-semibold leading-snug">{next.step.text}</p>
              <p className="text-sm text-muted">
                {next.inM >= 1 ? `через ${formatDistance(next.inM)}` : "здесь"}
              </p>
            </div>
          </div>
        )}
        <div
          role="progressbar"
          aria-label="Пройдено панорам"
          aria-valuemin={1}
          aria-valuemax={total}
          aria-valuenow={index + 1}
          className="h-1 overflow-hidden rounded-full bg-surface"
        >
          <div
            className="h-full rounded-full bg-accent transition-[width]"
            style={{ width: `${((index + 1) / total) * 100}%` }}
          />
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            aria-label="Предыдущая панорама"
            disabled={index === 0}
            onClick={onPrev}
          >
            <ChevronLeft className="size-5" />
          </Button>
          <Button
            variant="secondary"
            aria-label={auto ? "Пауза" : "Идти автоматически"}
            aria-pressed={auto}
            onClick={onToggleAuto}
            disabled={last}
          >
            {auto ? <Pause className="size-5" /> : <Play className="size-5" />}
          </Button>
          <span className="flex-1 whitespace-nowrap text-center text-sm text-muted">
            {index + 1} из {total}
          </span>
          {last ? (
            <Button onClick={onFinish}>Готово</Button>
          ) : (
            <Button onClick={onNext}>
              Дальше
              <ChevronRight className="size-5" aria-hidden />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
