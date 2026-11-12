import * as React from "react";
import { APP_NAME, APP_TAGLINE } from "../../lib/brand";

export interface AppShellProps {
  children: React.ReactNode;
  headerActions?: React.ReactNode;
}

export function AppShell({ children, headerActions }: AppShellProps) {
  return (
    <div className="min-h-screen bg-[var(--canvas)] text-[var(--ink)] flex flex-col">
      <header className="border-b border-[var(--line)] bg-[var(--surface)]">
        <div className="max-w-[1120px] mx-auto px-4 py-4 flex items-center justify-between">
          <a
            href="/"
            className="group flex flex-col sm:flex-row sm:items-baseline sm:gap-3 no-underline"
            title="Return to Plinthly Homepage"
          >
            <span
              style={{
                fontFamily: "var(--font-display)",
                fontSize: "24px",
                fontWeight: 600,
                color: "var(--ink)",
              }}
              className="group-hover:opacity-85 transition-opacity"
            >
              {APP_NAME}
            </span>
            <span className="text-sm text-[var(--ink-muted)]">
              {APP_TAGLINE}
            </span>
            <span className="hidden md:inline-block px-1.5 py-0.5 rounded text-[10px] font-mono uppercase tracking-wider bg-[var(--canvas)] text-[var(--ink-muted)] border border-[var(--line)] ml-1">
              Workspace
            </span>
          </a>
          {headerActions && <div>{headerActions}</div>}
        </div>
      </header>
      <main className="flex-1 max-w-[1120px] w-full mx-auto px-4 py-8">
        {children}
      </main>
    </div>
  );
}
