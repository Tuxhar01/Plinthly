import * as React from "react";

export interface FieldProps {
  label: string;
  htmlFor: string;
  hint?: string;
  error?: string;
  children: React.ReactNode;
  className?: string;
}

export function Field({
  label,
  htmlFor,
  hint,
  error,
  children,
  className = "",
}: FieldProps) {
  const hintId = hint ? `${htmlFor}-hint` : undefined;
  const errorId = error ? `${htmlFor}-error` : undefined;

  return (
    <div className={`flex flex-col gap-1.5 ${className}`.trim()}>
      <label
        htmlFor={htmlFor}
        className="text-sm font-medium text-[var(--ink)]"
      >
        {label}
      </label>
      {children}
      {hint && !error && (
        <p id={hintId} className="text-xs text-[var(--ink-muted)]">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} role="alert" className="text-xs text-[var(--block)]">
          {error}
        </p>
      )}
    </div>
  );
}
