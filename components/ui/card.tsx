import * as React from "react";

export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  heading?: string;
}

export function Card({ heading, children, className = "", style, ...props }: CardProps) {
  return (
    <div
      style={{
        backgroundColor: "var(--surface)",
        borderColor: "var(--line)",
        borderRadius: "var(--radius-card)",
        padding: "calc(var(--space-unit) * 4)", // 16px
        ...style,
      }}
      className={`border text-[var(--ink)] transition-colors duration-200 ${className}`.trim()}
      {...props}
    >
      {heading && (
        <h2 className="text-xl font-semibold mb-3 font-[family-name:var(--font-display)]">
          {heading}
        </h2>
      )}
      {children}
    </div>
  );
}
