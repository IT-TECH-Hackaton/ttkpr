import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { listChat, replyChat } from "@ttkpr/api-client";
import { Button } from "@ttkpr/ui";
import { useState } from "react";
import { unwrap } from "../lib/api";

/** Visitors' questions from the published map, with a reply box per conversation. */
export function ChatInbox({ mapId, canReply }: { mapId: string; canReply: boolean }) {
  const key = ["chat", mapId];
  const client = useQueryClient();
  const threads = useQuery({
    queryKey: key,
    queryFn: () => unwrap(listChat({ path: { map_id: mapId } })),
    refetchInterval: 15_000,
  });
  const reply = useMutation({
    mutationFn: ({ thread, text }: { thread: string; text: string }) =>
      unwrap(replyChat({ path: { map_id: mapId, thread }, body: { text } })),
    onSuccess: () => client.invalidateQueries({ queryKey: key }),
  });
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  if (!threads.data?.length) {
    return (
      <p className="text-sm text-muted">Пока вопросов нет. Гости пишут с опубликованной карты.</p>
    );
  }
  return (
    <ul className="space-y-3">
      {threads.data.map((t) => {
        const draft = drafts[t.thread] ?? "";
        const waiting = t.messages.at(-1)?.author === "visitor";
        return (
          <li key={t.thread} className="space-y-2 rounded-xl bg-surface p-3 text-sm">
            {waiting && <span className="text-xs font-semibold text-accent">Ждёт ответа</span>}
            {t.messages.map((m) => (
              <p key={m.id} className={m.author === "organizer" ? "pl-4 text-muted" : ""}>
                <b>{m.author === "organizer" ? (m.name ?? "Команда") : (m.name ?? "Гость")}:</b>{" "}
                {m.text}
              </p>
            ))}
            {canReply && (
              <form
                className="flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!draft.trim()) return;
                  reply.mutate(
                    { thread: t.thread, text: draft },
                    { onSuccess: () => setDrafts((d) => ({ ...d, [t.thread]: "" })) },
                  );
                }}
              >
                <input
                  aria-label="Ответ гостю"
                  className="min-w-0 flex-1 rounded-lg border border-border bg-bg px-2 py-1"
                  maxLength={1000}
                  placeholder="Ответ"
                  value={draft}
                  onChange={(e) => setDrafts((d) => ({ ...d, [t.thread]: e.target.value }))}
                />
                <Button type="submit" disabled={reply.isPending || !draft.trim()}>
                  Ответить
                </Button>
              </form>
            )}
          </li>
        );
      })}
    </ul>
  );
}
