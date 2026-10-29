"use client";

import * as React from "react";
import { Button } from "./button";

export type Theme = "system" | "light" | "dark";

function applyThemeToDom(targetTheme: Theme) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (targetTheme === "system") {
    root.removeAttribute("data-theme");
  } else {
    root.setAttribute("data-theme", targetTheme);
  }
}

function getInitialTheme(): Theme {
  if (typeof window === "undefined") return "system";
  try {
    const stored = localStorage.getItem("plinthly_theme");
    if (stored === "light" || stored === "dark" || stored === "system") {
      return stored;
    }
  } catch {
    // Ignore localStorage errors
  }
  return "system";
}

const emptySubscribe = () => () => {};

export function ThemeToggle() {
  const isClient = React.useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false
  );
  const [theme, setTheme] = React.useState<Theme>(getInitialTheme);

  React.useEffect(() => {
    applyThemeToDom(theme);
  }, [theme]);

  const cycleTheme = () => {
    const sequence: Theme[] = ["system", "dark", "light"];
    const currentIndex = sequence.indexOf(theme);
    const nextTheme = sequence[(currentIndex + 1) % sequence.length];
    setTheme(nextTheme);
    try {
      localStorage.setItem("plinthly_theme", nextTheme);
    } catch {
      // Ignore localStorage errors
    }
  };

  const label =
    !isClient || theme === "system"
      ? "Theme: System"
      : theme === "dark"
      ? "Theme: Dark"
      : "Theme: Light";

  return (
    <div className="flex items-center gap-1">
      <Button
        id="theme-toggle-btn"
        variant="secondary"
        onClick={cycleTheme}
        className="text-xs py-1 px-2.5 whitespace-nowrap"
        aria-label={`Current theme: ${theme}. Click to change theme.`}
        title="Cycle theme (System / Dark / Light)"
      >
        {label}
      </Button>
    </div>
  );
}
