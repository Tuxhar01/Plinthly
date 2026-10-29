import * as React from "react";

export type StatusChipVariant =
  | "pass"
  | "caution"
  | "block"
  | "info"
  | "neutral";

export interface StatusChipProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: StatusChipVariant;
  label: string;
  icon?: React.ReactNode;
}

export function StatusChip({
  variant = "neutral",
  label,
  icon,
  className = "",
  style,
  ...props
}: StatusChipProps) {
  const variantStyles: Record<StatusChipVariant, { bg: string; text: string }> = {
    pass: { bg: "var(--pass-tint)", text: "var(--pass)" },
    caution: { bg: "var(--caution-tint)", text: "var(--caution)" },
    block: { bg: "var(--block-tint)", text: "var(--block)" },
    info: { bg: "var(--info-tint)", text: "var(--info)" },
    neutral: { bg: "var(--neutral-tint)", text: "var(--ink)" },
  };

  const currentVariant = variantStyles[variant];

  return (
    <span
      style={{
        backgroundColor: currentVariant.bg,
        color: currentVariant.text,
        borderRadius: "var(--radius-control)",
        ...style,
      }}
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium select-none ${className}`.trim()}
      {...props}
    >
      {icon && <span aria-hidden="true" className="shrink-0">{icon}</span>}
      <span>{label}</span>
    </span>
  );
}
