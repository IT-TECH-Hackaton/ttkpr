import { Button } from "@ttkpr/ui";
import { CircleAlert, OctagonX } from "lucide-react";
import { useId } from "react";
import type { PublishIssue } from "../../lib/publishCheck";
import { useDraft } from "../../store";

/** Shown by «Опубликовать» when something is missing; each line takes you to the problem. */
export function PublishChecklist({
  issues,
  onClose,
  onPublish,
}: {
  issues: PublishIssue[];
  onClose: () => void;
  onPublish: () => void;
}) {
  const titleId = useId();
  const blocked = issues.some((i) => i.blocking);
  const show = (issue: PublishIssue) => {
    const s = useDraft.getState();
    if (issue.levelId) s.setLevel(issue.levelId);
    if (issue.id) {
      s.setTool("select");
      s.select(issue.id);
    }
    onClose();
  };
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      className="fixed inset-0 z-[65] grid place-items-end bg-black/40 p-0 sm:place-items-center sm:p-4"
      onClick={onClose}
      onKeyDown={(e) => e.key === "Escape" && onClose()}
    >
      {/* biome-ignore lint/a11y/noStaticElementInteractions: stops the backdrop click */}
      <div
        className="safe-bottom max-h-[85dvh] w-full space-y-4 overflow-y-auto rounded-t-3xl bg-bg p-5 shadow-2xl sm:max-w-md sm:rounded-3xl"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <h2 id={titleId} className="text-lg font-semibold">
          {blocked ? "Публиковать пока нечего" : "Перед публикацией"}
        </h2>
        <ul className="divide-y divide-border">
          {issues.map((issue) => (
            <li key={`${issue.text}-${issue.id ?? issue.levelId ?? ""}`}>
              <button
                type="button"
                onClick={() => show(issue)}
                className="flex min-h-12 w-full items-center gap-3 py-2 text-left"
              >
                {issue.blocking ? (
                  <OctagonX className="size-5 shrink-0 text-danger" aria-hidden />
                ) : (
                  <CircleAlert className="size-5 shrink-0 text-amber-500" aria-hidden />
                )}
                <span className="flex-1 text-sm">{issue.text}</span>
                {(issue.id || issue.levelId) && (
                  <span className="shrink-0 text-sm font-medium text-accent">Показать</span>
                )}
              </button>
            </li>
          ))}
        </ul>
        <div className="flex gap-2">
          <Button variant="secondary" className="flex-1" onClick={onClose}>
            Исправить
          </Button>
          {!blocked && (
            <Button
              className="flex-1"
              onClick={() => {
                onClose();
                onPublish();
              }}
            >
              Опубликовать всё равно
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
