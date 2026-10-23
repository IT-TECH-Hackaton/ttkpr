import type { ButtonHTMLAttributes } from "react";
import { cn } from "./cn";

export { cn } from "./cn";
export { ThemeSwitch } from "./ThemeSwitch";
export * from "./theme";

type Variant = "primary" | "secondary" | "ghost";

const VARIANTS: Record<Variant, string> = {
  primary: "bg-accent text-accent-fg",
  secondary: "bg-surface text-fg border border-border",
  ghost: "bg-transparent text-fg",
};

export function Button({
  variant = "primary",
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      type="button"
      className={cn(
        "inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-4 font-medium",
        "transition active:scale-[0.98] disabled:opacity-50",
        VARIANTS[variant],
        className,
      )}
      {...props}
    />
  );
}
