import * as React from "react";

export type BannerVariant = "error" | "success" | "info";

export interface BannerProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: BannerVariant;
  children: React.ReactNode;
}

export function Banner({
  variant = "info",
  children,
  className = "",
  style,
  ...props
}: BannerProps) {
  const role = variant === "error" ? "alert" : "status";

  const variantStyles: Record<
    BannerVariant,
    { bg: string; text: string; border: string }
  > = {
    error: {
      bg: "var(--block-tint)",
      text: "var(--block)",
      border: "var(--block)",
    },
    success: {
      bg: "var(--pass-tint)",
      text: "var(--pass)",
      border: "var(--pass)",
    },
    info: {
      bg: "var(--info-tint)",
      text: "var(--info)",
      border: "var(--info)",
    },
  };

  const currentVariant = variantStyles[variant];

  return (
    <div
      role={role}
      style={{
        backgroundColor: currentVariant.bg,
        color: currentVariant.text,
        borderLeft: `3px solid ${currentVariant.border}`,
        borderRadius: "var(--radius-control)",
        padding: "calc(var(--space-unit) * 3)", // 12px
        ...style,
      }}
      className={`text-sm animate-slide-down-fade transition-all duration-200 ${className}`.trim()}
      {...props}
    >
      {children}
    </div>
  );
}
