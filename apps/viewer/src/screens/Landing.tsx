import { Link } from "@tanstack/react-router";

export function Landing() {
  return (
    <main className="safe-top safe-bottom mx-auto flex min-h-full max-w-md flex-col justify-center gap-6 px-4">
      <div className="space-y-2">
        <h1 className="text-3xl font-semibold">Карта пространства</h1>
        <p className="text-muted">
          План здания, панорамы помещений и маршрут до нужного места — прямо в браузере телефона.
        </p>
      </div>
      <Link
        to="/m/$slug"
        params={{ slug: "demo" }}
        className="inline-flex min-h-12 items-center justify-center rounded-xl bg-accent px-4 font-medium text-accent-fg"
      >
        Открыть демо-карту
      </Link>
    </main>
  );
}
