import * as React from "react";

export interface TextareaProps
  extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  error?: boolean;
}

export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ error = false, disabled = false, className = "", style, ...props }, ref) => {
    const borderStyle = error
      ? "border-[var(--block)] focus:border-[var(--block)] focus:ring-[var(--block)]"
      : "border-[var(--control-border)] focus:border-[var(--accent)] focus:ring-[var(--accent)]";

    const disabledStyle = disabled
      ? "opacity-45 cursor-not-allowed"
      : "";

    return (
      <textarea
        ref={ref}
        disabled={disabled}
        aria-invalid={error ? "true" : undefined}
        style={{
          borderRadius: "var(--radius-control)",
          transitionDuration: "var(--duration-micro)",
          transitionTimingFunction: "var(--ease-standard)",
          ...style,
        }}
        className={`w-full px-3 py-2 text-sm bg-[var(--surface)] text-[var(--ink)] placeholder:text-[var(--ink-muted)] border outline-none hover:border-[var(--ink-muted)]/70 focus:ring-2 focus:ring-offset-1 focus:ring-offset-[var(--canvas)] transition-[border-color,box-shadow,background-color] duration-150 ${borderStyle} ${disabledStyle} ${className}`.trim()}
        {...props}
      />
    );
  }
);

Textarea.displayName = "Textarea";
