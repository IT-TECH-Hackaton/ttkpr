import { cn } from "@ttkpr/ui";
import {
  type CSSProperties,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

interface Props {
  trigger: (props: { open: boolean; toggle: () => void }) => ReactNode;
  children: (close: () => void) => ReactNode;
  align?: "left" | "right";
  side?: "bottom" | "top";
  className?: string;
}

/**
 * Small dropdown: closes on outside click and Escape. The menu is portalled to <body> and placed
 * next to its button: the bottom toolbar scrolls sideways and is blurred, which would clip a menu
 * inside it (on a phone it could not be tapped at all).
 */
export function Popover({ trigger, children, align = "left", side = "bottom", className }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<CSSProperties>({});
  useLayoutEffect(() => {
    if (!open || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    const gap = 8;
    setPlace({
      position: "fixed",
      ...(side === "bottom"
        ? { top: r.bottom + gap }
        : { bottom: window.innerHeight - r.top + gap }),
      ...(align === "right"
        ? { right: Math.max(8, window.innerWidth - r.right) }
        : { left: Math.max(8, Math.min(r.left, window.innerWidth - 232)) }),
    });
  }, [open, align, side]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!ref.current?.contains(target) && !menu.current?.contains(target)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div ref={ref} className="relative">
      {trigger({ open, toggle: () => setOpen((v) => !v) })}
      {open &&
        createPortal(
          <div
            ref={menu}
            style={place}
            className={cn(
              "pointer-events-auto z-[60] max-h-[70dvh] min-w-56 overflow-y-auto rounded-2xl border border-border bg-bg p-1.5 text-fg shadow-xl",
              className,
            )}
          >
            {children(() => setOpen(false))}
          </div>,
          document.body,
        )}
    </div>
  );
}

export function MenuItem({
  icon,
  children,
  onClick,
  danger,
  disabled,
  hint,
}: {
  icon?: ReactNode;
  children: ReactNode;
  onClick?: () => void;
  danger?: boolean;
  disabled?: boolean;
  hint?: string;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex min-h-10 w-full items-center gap-3 rounded-xl px-3 text-left text-sm hover:bg-surface disabled:opacity-40",
        danger && "text-danger",
      )}
    >
      {icon && <span className="text-muted [&>svg]:size-4">{icon}</span>}
      <span className="flex-1">{children}</span>
      {hint && <kbd className="text-xs text-muted">{hint}</kbd>}
    </button>
  );
}

export const MenuDivider = () => <div className="my-1 h-px bg-border" />;
