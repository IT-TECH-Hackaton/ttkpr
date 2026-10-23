import { Link } from "@tanstack/react-router";
import { cn } from "@ttkpr/ui";
import { MapPinned } from "lucide-react";
import type { ReactNode } from "react";
import { UserMenu } from "./UserMenu";

/** Header and page frame for everything except the full-screen editor. */
export function AppShell({
  children,
  actions,
  wide,
}: {
  children: ReactNode;
  actions?: ReactNode;
  wide?: boolean;
}) {
  return (
    <div className="min-h-full bg-surface">
      <header className="sticky top-0 z-30 border-b border-border bg-bg/90 backdrop-blur print:hidden">
        <div
          className={cn(
            "mx-auto flex h-16 items-center gap-4 px-4",
            wide ? "max-w-6xl" : "max-w-4xl",
          )}
        >
          <Link to="/" className="flex items-center gap-2 font-semibold">
            <span className="grid size-9 place-items-center rounded-xl bg-accent text-accent-fg">
              <MapPinned className="size-5" />
            </span>
            <span className="hidden sm:inline">Карта пространства</span>
          </Link>
          <nav className="flex flex-1 items-center gap-1 text-sm">
            <Link
              to="/"
              className="rounded-lg px-3 py-2 text-muted hover:text-fg"
              activeProps={{ className: "rounded-lg px-3 py-2 font-medium text-fg" }}
              activeOptions={{ exact: true }}
            >
              Мои карты
            </Link>
          </nav>
          {actions}
          <UserMenu />
        </div>
      </header>
      <main className={cn("mx-auto px-4 py-8", wide ? "max-w-6xl" : "max-w-4xl")}>{children}</main>
    </div>
  );
}
