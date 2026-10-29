import * as React from "react";

export type SkeletonProps = React.HTMLAttributes<HTMLDivElement>;

export function Skeleton({ className = "", style, ...props }: SkeletonProps) {
  return (
    <div
      aria-hidden="true"
      style={{
        backgroundColor: "var(--neutral-tint)",
        borderRadius: "var(--radius-control)",
        ...style,
      }}
      className={`animate-skeleton-pulse ${className}`.trim()}
      {...props}
    />
  );
}
