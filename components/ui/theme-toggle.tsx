"use client";

import * as React from "react";
import { Sun, Moon, Laptop, Check, ChevronDown } from "lucide-react";

export type Theme = "system" | "light" | "dark";

const THEME_OPTIONS: Array<{
  value: Theme;
  label: string;
  icon: React.ElementType;
}> = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Laptop },
];

function applyThemeToDom(targetTheme: Theme) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (targetTheme === "system") {
    root.removeAttribute("data-theme");
  } else {
    root.setAttribute("data-theme", targetTheme);
  }
}

export function ThemeToggle() {
  const [theme, setTheme] = React.useState<Theme>("system");
  const [mounted, setMounted] = React.useState<boolean>(false);
  const [isOpen, setIsOpen] = React.useState<boolean>(false);
  const dropdownRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    setMounted(true);
    try {
      const stored = localStorage.getItem("plinthly_theme");
      if (stored === "light" || stored === "dark" || stored === "system") {
        setTheme(stored as Theme);
        applyThemeToDom(stored as Theme);
      }
    } catch {
      // Ignore localStorage access errors
    }
  }, []);

  // Close dropdown on outside click or escape
  React.useEffect(() => {
    if (!isOpen) return;

    const handlePointerDown = (e: MouseEvent | TouchEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setIsOpen(false);
      }
    };

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("touchstart", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("touchstart", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen]);

  const selectTheme = (newTheme: Theme) => {
    setTheme(newTheme);
    applyThemeToDom(newTheme);
    setIsOpen(false);
    try {
      localStorage.setItem("plinthly_theme", newTheme);
    } catch {
      // Ignore localStorage access errors
    }
  };

  const currentTheme = mounted ? theme : "system";
  const activeOption = THEME_OPTIONS.find((opt) => opt.value === currentTheme) || THEME_OPTIONS[2];
  const CurrentIcon = activeOption.icon;

  return (
    <div ref={dropdownRef} className="relative inline-block text-left">
      <button
        id="theme-toggle-btn"
        type="button"
        onClick={() => setIsOpen((prev) => !prev)}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-label={`Current theme: ${activeOption.label}. Click to select theme.`}
        className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-[var(--radius-control)] border border-[var(--control-border)] bg-[var(--surface)] text-[var(--ink)] hover:bg-[color-mix(in_srgb,var(--ink)_5%,transparent)] transition-all duration-150 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] cursor-pointer select-none"
      >
        <CurrentIcon className="w-3.5 h-3.5 text-[var(--accent)] shrink-0" aria-hidden="true" />
        <span className="hidden sm:inline-block">{activeOption.label}</span>
        <ChevronDown
          className={`w-3 h-3 text-[var(--ink-muted)] transition-transform duration-150 ${
            isOpen ? "rotate-180" : ""
          }`}
          aria-hidden="true"
        />
      </button>

      {isOpen && (
        <div
          role="listbox"
          aria-label="Theme options"
          className="absolute right-0 mt-1.5 w-32 rounded-[var(--radius-control)] border border-[var(--line)] bg-[var(--surface)] text-[var(--ink)] shadow-md py-1 z-50 animate-scale-in duration-150 focus:outline-none"
        >
          {THEME_OPTIONS.map((option) => {
            const isSelected = option.value === currentTheme;
            const Icon = option.icon;
            return (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-selected={isSelected}
                onClick={() => selectTheme(option.value)}
                className={`w-full flex items-center justify-between px-3 py-1.5 text-xs transition-colors duration-150 text-left cursor-pointer ${
                  isSelected
                    ? "bg-[color-mix(in_srgb,var(--accent)_10%,transparent)] text-[var(--accent)] font-semibold"
                    : "hover:bg-[color-mix(in_srgb,var(--ink)_5%,transparent)] text-[var(--ink)]"
                }`}
              >
                <div className="flex items-center gap-2">
                  <Icon className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                  <span>{option.label}</span>
                </div>
                {isSelected && (
                  <Check className="w-3 h-3 text-[var(--accent)] shrink-0" aria-hidden="true" />
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
