import { Button } from "@ttkpr/ui";
import { Send } from "lucide-react";
import { useCallback, useEffect, useId, useState } from "react";

interface Message {
  id: string;
  author: "visitor" | "organizer";
  name: string | null;
  text: string;
  createdAt: string;
}

const threadKey = (slug: string) => `ttkpr.chat.${slug}`;

function storedThread(slug: string): string | null {
  try {
    return localStorage.getItem(threadKey(slug));
  } catch {
    return null;
  }
}

/** Questions to the organizers. The conversation id stays on this device; answers are polled. */
export function ChatPanel({ slug, onClose }: { slug: string; onClose: () => void }) {
  const titleId = useId();
  const [thread, setThread] = useState(() => storedThread(slug));
  const [messages, setMessages] = useState<Message[]>([]);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const base = `/api/public/maps/${encodeURIComponent(slug)}/chat`;

  const load = useCallback(async () => {
    if (!thread) return;
    const response = await fetch(`${base}/${thread}`).catch(() => null);
    if (response?.ok) setMessages((await response.json()).messages);
  }, [base, thread]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 8000);
    return () => window.clearInterval(timer);
  }, [load]);

  const send = async () => {
    const body = text.trim();
    if (!body) return;
    setSending(true);
    setError(null);
    try {
      const response = await fetch(base, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: body, thread }),
      });
      if (!response.ok) throw new Error(String(response.status));
      const data = await response.json();
      setThread(data.thread);
      setMessages(data.messages);
      setText("");
      try {
        localStorage.setItem(threadKey(slug), data.thread);
      } catch {
        // Without storage the conversation lasts until the page is closed.
      }
    } catch {
      setError("Не отправилось — проверьте интернет и попробуйте ещё раз");
    } finally {
      setSending(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      className="fixed inset-0 z-[2147483000] grid place-items-end bg-black/40 sm:place-items-center"
      onClick={onClose}
      onKeyDown={(e) => e.key === "Escape" && onClose()}
    >
      {/* biome-ignore lint/a11y/noStaticElementInteractions: stops the backdrop click */}
      <div
        className="safe-bottom flex max-h-[85dvh] w-full flex-col gap-3 rounded-t-3xl bg-bg p-5 shadow-2xl sm:max-w-md sm:rounded-3xl"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 id={titleId} className="text-lg font-semibold">
            Вопрос организаторам
          </h2>
          <Button variant="ghost" onClick={onClose} className="-mr-2 px-3">
            Закрыть
          </Button>
        </div>
        <div className="min-h-24 flex-1 space-y-2 overflow-y-auto" aria-live="polite">
          {messages.map((m) => (
            <p
              key={m.id}
              className={
                m.author === "visitor"
                  ? "ml-8 rounded-2xl rounded-br-md bg-accent px-3 py-2 text-accent-fg"
                  : "mr-8 rounded-2xl rounded-bl-md bg-surface px-3 py-2"
              }
            >
              {m.author === "organizer" && (
                <span className="block text-xs font-semibold text-muted">
                  {m.name ?? "Организатор"}
                </span>
              )}
              {m.text}
            </p>
          ))}
        </div>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <input
            aria-label="Сообщение"
            className="min-w-0 flex-1 rounded-xl border border-border bg-bg px-3 py-2"
            maxLength={1000}
            placeholder="Ваш вопрос"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <Button type="submit" aria-label="Отправить" disabled={sending || !text.trim()}>
            <Send className="size-4" aria-hidden />
          </Button>
        </form>
      </div>
    </div>
  );
}
