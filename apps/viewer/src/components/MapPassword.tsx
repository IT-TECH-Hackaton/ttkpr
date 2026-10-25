import { Button } from "@ttkpr/ui";
import { LockKeyhole } from "lucide-react";
import { useState } from "react";

/** A password map: one field, then the map opens (a cookie keeps it open on this device). */
export function MapPassword({ slug, onUnlocked }: { slug: string; onUnlocked: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/public/maps/${encodeURIComponent(slug)}/unlock`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (response.status === 204) return onUnlocked();
      setError(response.status === 429 ? "Слишком много попыток, подождите" : "Неверный пароль");
    } catch {
      setError("Нет связи с сервером");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="grid h-full place-items-center px-6"
      onSubmit={(e) => {
        e.preventDefault();
        if (password) void submit();
      }}
    >
      <div className="w-full max-w-xs space-y-4 text-center">
        <div className="mx-auto grid size-14 place-items-center rounded-2xl bg-accent text-accent-fg">
          <LockKeyhole className="size-7" aria-hidden />
        </div>
        <h1 className="text-xl font-semibold">Карта закрыта паролем</h1>
        <input
          type="password"
          aria-label="Пароль"
          autoComplete="current-password"
          placeholder="Пароль от организатора"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full rounded-xl border border-border bg-bg px-3 py-3"
        />
        {error && <p className="text-sm text-danger">{error}</p>}
        <Button type="submit" className="w-full" disabled={busy || !password}>
          Открыть карту
        </Button>
      </div>
    </form>
  );
}
