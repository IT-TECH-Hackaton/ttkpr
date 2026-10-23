import type { RouteStep } from "@ttkpr/map-core";
import { cn } from "@ttkpr/ui";
import {
  ArrowDown,
  ArrowUp,
  CornerUpLeft,
  CornerUpRight,
  DoorOpen,
  Flag,
  type LucideIcon,
  MapPin,
  MoveUp,
  Undo2,
} from "lucide-react";

function iconFor(step: RouteStep): { Icon: LucideIcon; tone: string } {
  switch (step.kind) {
    case "start":
      return {
        Icon: MoveUp,
        tone: "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300",
      };
    case "door":
      return { Icon: DoorOpen, tone: "bg-surface text-fg" };
    case "turn":
      return {
        Icon: step.text.includes("Развернитесь")
          ? Undo2
          : step.text.includes("налево")
            ? CornerUpLeft
            : CornerUpRight,
        tone: "bg-surface text-fg",
      };
    case "floor":
      return {
        Icon: step.text.startsWith("Поднимитесь") ? ArrowUp : ArrowDown,
        tone: "bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300",
      };
    case "stop":
      return {
        Icon: MapPin,
        tone: "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
      };
    case "arrive":
      return { Icon: Flag, tone: "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300" };
    default:
      return { Icon: MoveUp, tone: "bg-surface text-fg" };
  }
}

export function StepIcon({ step, className }: { step: RouteStep; className?: string }) {
  const { Icon, tone } = iconFor(step);
  return (
    <span
      aria-hidden
      className={cn("grid size-9 shrink-0 place-items-center rounded-full", tone, className)}
    >
      <Icon className="size-5" />
    </span>
  );
}
