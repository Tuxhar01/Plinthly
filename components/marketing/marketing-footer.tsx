import * as React from "react";
import Link from "next/link";
import { APP_NAME, APP_TAGLINE } from "@/lib/brand";
import { ShieldCheck, CheckCircle2, ArrowUpRight } from "lucide-react";

export function MarketingFooter() {
  return (
    <footer className="border-t border-[var(--line)] bg-[var(--surface)] text-[var(--ink-muted)] text-xs">
      <div className="max-w-[1280px] mx-auto px-4 sm:px-6 py-12 lg:py-16">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-8 lg:gap-12">
          {/* Brand & Purpose (2 cols on lg) */}
          <div className="lg:col-span-2 space-y-4">
            <Link
              href="/"
              className="inline-flex items-baseline gap-2 text-decoration-none group select-none"
            >
              <span
                style={{ fontFamily: "var(--font-display)" }}
                className="text-2xl font-semibold tracking-tight text-[var(--ink)] group-hover:text-[var(--accent)] transition-colors"
              >
                {APP_NAME}
              </span>
              <span className="text-xs font-normal text-[var(--ink-muted)]">
                {APP_TAGLINE}
              </span>
            </Link>

            <p className="text-sm leading-relaxed max-w-sm text-[var(--ink-muted)]">
              Enterprise purchase assurance. Replacing unconstrained agentic procurement with deterministic policy verification, cryptographic snapshot locking, and atomic PayPal settlement.
            </p>

            <div className="pt-2 flex flex-wrap gap-2">
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-[11px] font-medium bg-[#1F4E5A]/10 text-[var(--accent)] border border-[var(--accent)]/20">
                <ShieldCheck className="w-3.5 h-3.5" />
                <span>Stage 3 Verified Architecture</span>
              </span>
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-[11px] font-medium bg-[#2E7D32]/10 text-[#2E7D32] dark:text-[#4ADE80] border border-[#2E7D32]/25">
                <CheckCircle2 className="w-3.5 h-3.5" />
                <span>Deterministic Variance Guard</span>
              </span>
            </div>
          </div>

          {/* Navigation Column 1: Platform */}
          <div className="space-y-3">
            <h4 className="font-semibold text-xs uppercase tracking-wider text-[var(--ink)]">
              Platform
            </h4>
            <ul className="space-y-2">
              <li>
                <Link
                  href="/workspace"
                  className="hover:text-[var(--ink)] transition-colors inline-flex items-center gap-1"
                >
                  <span>Procurement Workspace</span>
                  <ArrowUpRight className="w-3 h-3 text-[var(--ink-muted)]" />
                </Link>
              </li>
              <li>
                <a href="#product" className="hover:text-[var(--ink)] transition-colors">
                  Interactive Studio
                </a>
              </li>
              <li>
                <a href="#workflow" className="hover:text-[var(--ink)] transition-colors">
                  5-Stage Workflow
                </a>
              </li>
              <li>
                <a href="#assurance" className="hover:text-[var(--ink)] transition-colors">
                  Assurance Engine
                </a>
              </li>
            </ul>
          </div>

          {/* Navigation Column 2: Technology */}
          <div className="space-y-3">
            <h4 className="font-semibold text-xs uppercase tracking-wider text-[var(--ink)]">
              Technology
            </h4>
            <ul className="space-y-2">
              <li>
                <span className="text-[var(--ink)] font-medium">Gemini 2.5 Flash</span>
                <p className="text-[11px]">Intent decomposition</p>
              </li>
              <li>
                <span className="text-[var(--ink)] font-medium">Channel3 Bridge</span>
                <p className="text-[11px]">Multi-merchant inventory</p>
              </li>
              <li>
                <span className="text-[var(--ink)] font-medium">PostgreSQL State Machine</span>
                <p className="text-[11px]">SHA-256 snapshot ledgers</p>
              </li>
              <li>
                <span className="text-[var(--ink)] font-medium">PayPal Orders v2</span>
                <p className="text-[11px]">Multi-cart capture settlement</p>
              </li>
            </ul>
          </div>

          {/* Navigation Column 3: Trust & Security */}
          <div className="space-y-3">
            <h4 className="font-semibold text-xs uppercase tracking-wider text-[var(--ink)]">
              Trust & Governance
            </h4>
            <ul className="space-y-2">
              <li className="flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-[#2E7D32]" />
                <span>Pre-Capture Price Guard</span>
              </li>
              <li className="flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-[#2E7D32]" />
                <span>Deterministic Hardware Auditing</span>
              </li>
              <li className="flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-[#2E7D32]" />
                <span>Idempotent Webhook Reconciler</span>
              </li>
              <li className="flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-[#2E7D32]" />
                <span>PayPal Sandbox Verified</span>
              </li>
            </ul>
          </div>
        </div>

        {/* Bottom Sub-footer */}
        <div className="mt-12 pt-6 border-t border-[var(--line)] flex flex-col sm:flex-row items-center justify-between gap-4 text-[11px]">
          <p>© 2026 Plinthly. Every purchase. Proven. All rights reserved.</p>
          <div className="flex items-center gap-6">
            <Link href="/workspace" className="hover:text-[var(--ink)] transition-colors">
              Launch Workspace
            </Link>
            <a href="#product" className="hover:text-[var(--ink)] transition-colors">
              Product Overview
            </a>
            <span className="font-mono text-[10px] text-[var(--ink-muted)]">
              Build v3.5-release
            </span>
          </div>
        </div>
      </div>
    </footer>
  );
}
