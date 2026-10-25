import { FileScan, ImagePlus, Square } from "lucide-react";
import type { ReactNode } from "react";
import { useDraft } from "../../store";
import { panel } from "./Chrome";

/** An empty map: three ways to begin instead of a blank canvas. Hides once there is a plan. */
export function EmptyStart({
  onRecognize,
  onUploadPlan,
}: {
  onRecognize: () => void;
  onUploadPlan: () => void;
}) {
  const empty = useDraft((s) => !s.doc.units?.length && !s.doc.underlays?.length);
  const tool = useDraft((s) => s.tool);
  if (!empty || tool !== "select") return null;
  const option = (icon: ReactNode, title: string, text: string, onClick: () => void) => (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-3 rounded-xl p-3 text-left hover:bg-white/10"
    >
      <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-accent text-white [&>svg]:size-5">
        {icon}
      </span>
      <span>
        <span className="block font-medium">{title}</span>
        <span className="block text-sm text-white/70">{text}</span>
      </span>
    </button>
  );
  return (
    <div className="pointer-events-none absolute inset-0 z-[5] grid place-items-center p-4">
      <div className={`${panel} pointer-events-auto w-full max-w-sm space-y-1 p-3`}>
        <h2 className="px-3 pt-1 pb-2 text-lg font-semibold">С чего начнём?</h2>
        {option(
          <FileScan />,
          "Распознать план",
          "PDF или фото схемы — помещения и двери появятся сами",
          onRecognize,
        )}
        {option(
          <ImagePlus />,
          "Схема подложкой",
          "Картинка под планом, комнаты обводите поверх",
          onUploadPlan,
        )}
        {option(<Square />, "Нарисовать", "Два клика по углам — первая комната", () =>
          useDraft.getState().setTool("rect"),
        )}
      </div>
    </div>
  );
}
