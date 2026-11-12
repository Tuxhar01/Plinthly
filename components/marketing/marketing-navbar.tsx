"use client";

import * as React from "react";
import Link from "next/link";
import { APP_NAME, APP_TAGLINE } from "@/lib/brand";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import { ArrowRight, Menu, X } from "lucide-react";

const NAV_LINKS = [
  { href: "#problem", label: "Overview", id: "problem" },
  { href: "#product", label: "Product", id: "product" },
  { href: "#workflow", label: "How it Works", id: "workflow" },
  { href: "#assurance", label: "Assurance", id: "assurance" },
];

export function MarketingNavbar() {
  const [mobileMenuOpen, setMobileMenuOpen] = React.useState(false);
  const [scrolled, setScrolled] = React.useState(false);
  const [activeSection, setActiveSection] = React.useState<string>("");

  React.useEffect(() => {
    const handleScroll = () => {
      setScrolled(window.scrollY > 15);
    };
    window.addEventListener("scroll", handleScroll, { passive: true });
    handleScroll();
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  // IntersectionObserver to highlight current active section
  React.useEffect(() => {
    if (typeof window === "undefined" || !("IntersectionObserver" in window)) return;

    const sectionElements = NAV_LINKS.map((link) =>
      document.getElementById(link.id)
    ).filter(Boolean) as HTMLElement[];

    if (sectionElements.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            setActiveSection(entry.target.id);
          }
        });
      },
      {
        threshold: 0.25,
        rootMargin: "-20% 0px -50% 0px",
      }
    );

    sectionElements.forEach((el) => observer.observe(el));
    return () => {
      sectionElements.forEach((el) => observer.unobserve(el));
    };
  }, []);

  return (
    <header
      className={`sticky top-0 z-50 transition-all duration-300 border-b ${
        scrolled
          ? "bg-[color-mix(in_srgb,var(--surface)_88%,transparent)] backdrop-blur-md border-[var(--line)] shadow-xs"
          : "bg-[var(--surface)] border-[var(--line)]"
      }`}
    >
      <div className="max-w-[1280px] mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-4">
        {/* Brand / Logo */}
        <Link
          href="/"
          className="flex items-baseline gap-2.5 text-decoration-none group select-none"
        >
          <span
            style={{ fontFamily: "var(--font-display)" }}
            className="text-2xl font-semibold tracking-tight text-[var(--ink)] group-hover:text-[var(--accent)] transition-colors duration-200"
          >
            {APP_NAME}
          </span>
          <span className="hidden sm:inline-block text-xs font-normal text-[var(--ink-muted)] tracking-normal transition-opacity duration-200">
            {APP_TAGLINE}
          </span>
        </Link>

        {/* Desktop Navigation */}
        <nav className="hidden md:flex items-center gap-1 text-sm font-medium">
          {NAV_LINKS.map((link) => {
            const isActive = activeSection === link.id;
            return (
              <a
                key={link.id}
                href={link.href}
                className={`relative px-3 py-1.5 rounded-[var(--radius-control)] transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] ${
                  isActive
                    ? "text-[var(--ink)] font-semibold bg-[color-mix(in_srgb,var(--ink)_5%,transparent)]"
                    : "text-[var(--ink-muted)] hover:text-[var(--ink)] hover:bg-[color-mix(in_srgb,var(--ink)_3%,transparent)]"
                }`}
              >
                <span>{link.label}</span>
                {isActive && (
                  <span
                    aria-hidden="true"
                    className="absolute bottom-0 left-3 right-3 h-[2px] bg-[var(--accent)] rounded-full animate-scale-in"
                  />
                )}
              </a>
            );
          })}
        </nav>

        {/* Right Actions: Theme Toggle & Launch Workspace */}
        <div className="hidden sm:flex items-center gap-3">
          <ThemeToggle />
          <Link
            href="/workspace"
            className="group inline-flex items-center gap-2 bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-[var(--on-accent)] text-xs font-medium px-3.5 py-2 rounded-[var(--radius-control)] shadow-xs transition-all duration-200 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
          >
            <span>Launch Workspace</span>
            <ArrowRight className="w-3.5 h-3.5 group-hover:translate-x-0.5 transition-transform duration-200" aria-hidden="true" />
          </Link>
        </div>

        {/* Mobile Hamburger Button */}
        <div className="flex sm:hidden items-center gap-2">
          <ThemeToggle />
          <button
            type="button"
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
            className="p-1.5 rounded-[var(--radius-control)] border border-[var(--control-border)] text-[var(--ink)] hover:bg-[color-mix(in_srgb,var(--ink)_5%,transparent)] transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
            aria-label={mobileMenuOpen ? "Close navigation menu" : "Open navigation menu"}
            aria-expanded={mobileMenuOpen}
          >
            {mobileMenuOpen ? (
              <X className="w-5 h-5 animate-scale-in" aria-hidden="true" />
            ) : (
              <Menu className="w-5 h-5" aria-hidden="true" />
            )}
          </button>
        </div>
      </div>

      {/* Mobile Drawer Menu */}
      {mobileMenuOpen && (
        <div className="sm:hidden border-b border-[var(--line)] bg-[var(--surface)] px-4 py-4 space-y-3 animate-slide-down-fade">
          <div className="flex flex-col gap-1.5 text-sm font-medium text-[var(--ink)]">
            {NAV_LINKS.map((link) => (
              <a
                key={link.id}
                href={link.href}
                onClick={() => setMobileMenuOpen(false)}
                className={`py-2 px-2.5 rounded transition-colors duration-150 ${
                  activeSection === link.id
                    ? "bg-[color-mix(in_srgb,var(--accent)_10%,transparent)] text-[var(--accent)] font-semibold"
                    : "hover:bg-[color-mix(in_srgb,var(--ink)_5%,transparent)] text-[var(--ink)]"
                }`}
              >
                {link.label}
              </a>
            ))}
          </div>
          <div className="pt-2 border-t border-[var(--line)]">
            <Link
              href="/workspace"
              onClick={() => setMobileMenuOpen(false)}
              className="w-full inline-flex items-center justify-center gap-2 bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-[var(--on-accent)] text-sm font-medium px-4 py-2.5 rounded-[var(--radius-control)] shadow-xs transition-transform active:scale-[0.98]"
            >
              <span>Launch Workspace</span>
              <ArrowRight className="w-4 h-4" aria-hidden="true" />
            </Link>
          </div>
        </div>
      )}
    </header>
  );
}
