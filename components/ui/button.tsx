import * as React from "react";

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "destructive";
  loading?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      variant = "primary",
      loading = false,
      disabled = false,
      type = "button",
      className = "",
      children,
      ...props
    },
    ref
  ) => {
    const baseStyles =
      "relative inline-flex items-center justify-center font-medium select-none overflow-hidden text-sm px-4 py-2 " +
      "transition-[background-color,border-color,color,box-shadow,transform] duration-150 " +
      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--canvas)] " +
      "hover:brightness-[1.02] active:scale-[0.985] ";

    const variantStyles = {
      primary:
        "bg-[var(--accent)] text-[var(--on-accent)] border border-transparent hover:bg-[var(--accent-hover)]",
      secondary:
        "bg-transparent text-[var(--ink)] border border-[var(--control-border)] hover:bg-[color-mix(in_srgb,var(--ink)_6%,transparent)]",
      destructive:
        "bg-transparent text-[var(--block)] border border-[var(--block)] hover:bg-[color-mix(in_srgb,var(--block)_6%,transparent)]",
    }[variant];

    const stateStyles = disabled
      ? "opacity-45 cursor-not-allowed pointer-events-none"
      : loading
      ? "cursor-wait pointer-events-none"
      : "cursor-pointer";

    return (
      <button
        ref={ref}
        type={type}
        disabled={disabled || loading}
        aria-busy={loading ? "true" : undefined}
        style={{
          borderRadius: "var(--radius-control)",
          transitionDuration: "var(--duration-micro)",
          transitionTimingFunction: "var(--ease-standard)",
        }}
        className={`${baseStyles} ${variantStyles} ${stateStyles} ${className}`.trim()}
        {...props}
      >
        <span className="inline-flex items-center gap-2">{children}</span>
        {loading && (
          <span
            aria-hidden="true"
            className="absolute bottom-0 left-0 right-0 h-[2px] overflow-hidden bg-[color-mix(in_srgb,var(--accent)_25%,transparent)]"
          >
            <span className="block h-full w-full bg-[var(--accent)] animate-button-sweep" />
          </span>
        )}
      </button>
    );
  }
);

Button.displayName = "Button";
