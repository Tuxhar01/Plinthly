import { Metadata } from "next";
import { Suspense } from "react";
import Link from "next/link";
import { APP_NAME, APP_TAGLINE } from "@/lib/brand";
import { MarketingNavbar } from "@/components/marketing/marketing-navbar";
import { InteractiveStudioPreview } from "@/components/marketing/interactive-studio-preview";
import { WorkflowStepper } from "@/components/marketing/workflow-stepper";
import { MarketingFooter } from "@/components/marketing/marketing-footer";
import { LegacyRedirect } from "@/components/marketing/legacy-redirect";
import { ScrollReveal } from "@/components/ui/motion";
import {
  ShieldCheck,
  CheckCircle2,
  ArrowRight,
  Sparkles,
  Lock,
  Layers,
  CreditCard,
  AlertTriangle,
  Cpu,
  FileCheck2,
  Zap,
  Store,
  DollarSign,
  Scale,
} from "lucide-react";

export const metadata: Metadata = {
  title: "Plinthly — Every purchase. Proven.",
  description:
    "Enterprise purchase assurance platform. Decomposes natural language requests with Gemini 2.5, verifies multi-merchant allocation policies deterministically, and reconciles multi-cart settlements through PayPal Orders v2 with deterministic landed cost verification.",
};

export default function HomePage() {
  return (
    <div className="min-h-screen bg-[var(--canvas)] text-[var(--ink)] flex flex-col selection:bg-[var(--accent)] selection:text-[var(--on-accent)]">
      {/* Seamless backward-compatibility client redirect for legacy ?purchaseId= or ?aggregateId= links */}
      <Suspense fallback={null}>
        <LegacyRedirect />
      </Suspense>

      {/* Top Navigation */}
      <MarketingNavbar />

      <main className="flex-1">
        {/* ========================================================= */}
        {/* HERO SECTION */}
        {/* ========================================================= */}
        <section className="relative pt-12 pb-16 sm:pt-20 sm:pb-24 border-b border-[var(--line)] overflow-hidden">
          {/* Subtle Ambient Background Gradient */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 -z-10 flex items-center justify-center opacity-40 dark:opacity-20 animate-pulse-subtle"
          >
            <div className="w-[600px] h-[600px] rounded-full bg-[radial-gradient(circle_at_center,var(--accent)_0%,transparent_70%)] blur-[100px]" />
          </div>

          <div className="max-w-[1280px] mx-auto px-4 sm:px-6">
            <div className="max-w-3xl mx-auto text-center space-y-6">
              {/* Trust Badge Eyebrow */}
              <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-medium bg-[color-mix(in_srgb,var(--accent)_12%,var(--surface))] border border-[var(--accent)]/30 text-[var(--accent)] shadow-2xs animate-fade-in-down duration-300">
                <ShieldCheck className="w-3.5 h-3.5" />
                <span>Deterministic Enterprise Purchase Assurance</span>
              </div>

              {/* Main Headline */}
              <h1
                style={{ fontFamily: "var(--font-display)" }}
                className="text-4xl sm:text-6xl lg:text-7xl font-semibold tracking-tight text-[var(--ink)] leading-[1.08] animate-fade-in-up duration-500"
              >
                Every purchase. <span className="italic text-[var(--accent)]">Proven.</span>
              </h1>

              {/* Lead Subtitle */}
              <p
                style={{ animationDelay: "120ms" }}
                className="text-base sm:text-lg text-[var(--ink-muted)] leading-relaxed max-w-2xl mx-auto animate-fade-in-up"
              >
                Autonomous AI purchasing agents can misestimate prices, overlook shipping fees, and select obsolete hardware. Plinthly enforces deterministic specification proofs, cryptographic snapshot locking, and pre-capture PayPal reconciliation.
              </p>

              {/* Primary Call-to-Actions */}
              <div
                style={{ animationDelay: "220ms" }}
                className="pt-2 flex flex-col sm:flex-row items-center justify-center gap-3 sm:gap-4 animate-fade-in-up"
              >
                <Link
                  href="/workspace"
                  className="group w-full sm:w-auto inline-flex items-center justify-center gap-2 bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-[var(--on-accent)] font-medium text-sm px-6 py-3 rounded-[var(--radius-control)] shadow-sm transition-all duration-200 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                >
                  <span>Launch Procurement Workspace</span>
                  <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform duration-200" />
                </Link>

                <a
                  href="#product"
                  className="w-full sm:w-auto inline-flex items-center justify-center gap-2 bg-[var(--surface)] hover:bg-[var(--canvas)] border border-[var(--control-border)] text-[var(--ink)] font-medium text-sm px-6 py-3 rounded-[var(--radius-control)] shadow-2xs transition-all duration-200 active:scale-[0.98]"
                >
                  <span>Explore Interactive Studio</span>
                </a>
              </div>
            </div>

            {/* Metrics & Assurance Proof Bar */}
            <div
              style={{ animationDelay: "320ms" }}
              className="mt-14 sm:mt-18 pt-8 border-t border-[var(--line)] grid grid-cols-2 lg:grid-cols-4 gap-6 sm:gap-8 animate-fade-in-up"
            >
              <div className="space-y-1 p-3 rounded-lg hover:bg-[color-mix(in_srgb,var(--ink)_2%,transparent)] transition-colors duration-150">
                <div className="font-mono text-2xl sm:text-3xl font-bold text-[var(--ink)]">
                  |Δ| = $0.00
                </div>
                <div className="text-xs font-medium text-[var(--ink)]">
                  Pre-Capture Variance Guard
                </div>
                <p className="text-[11px] text-[var(--ink-muted)]">
                  Enforces exact penny settlement bounds before payment capture
                </p>
              </div>

              <div className="space-y-1 p-3 rounded-lg hover:bg-[color-mix(in_srgb,var(--ink)_2%,transparent)] transition-colors duration-150">
                <div className="font-mono text-2xl sm:text-3xl font-bold text-[var(--ink)]">
                  100%
                </div>
                <div className="text-xs font-medium text-[var(--ink)]">
                  Deterministic Policy Proofs
                </div>
                <p className="text-[11px] text-[var(--ink-muted)]">
                  CPU, RAM, and OS compatibility verification
                </p>
              </div>

              <div className="space-y-1 p-3 rounded-lg hover:bg-[color-mix(in_srgb,var(--ink)_2%,transparent)] transition-colors duration-150">
                <div className="font-mono text-2xl sm:text-3xl font-bold text-[var(--ink)]">
                  SHA-256
                </div>
                <div className="text-xs font-medium text-[var(--ink)]">
                  Cryptographic Snapshot Digests
                </div>
                <p className="text-[11px] text-[var(--ink-muted)]">
                  PostgreSQL transactional state machine enforcement
                </p>
              </div>

              <div className="space-y-1 p-3 rounded-lg hover:bg-[color-mix(in_srgb,var(--ink)_2%,transparent)] transition-colors duration-150">
                <div className="font-mono text-2xl sm:text-3xl font-bold text-[var(--ink)]">
                  Orders v2
                </div>
                <div className="text-xs font-medium text-[var(--ink)]">
                  Multi-Merchant PayPal Rails
                </div>
                <p className="text-[11px] text-[var(--ink-muted)]">
                  Multi-capture settlement with idempotent webhooks
                </p>
              </div>
            </div>

            {/* Merchant Ecosystem Ticker */}
            <div
              style={{ animationDelay: "420ms" }}
              className="mt-10 pt-6 border-t border-[var(--line)] flex flex-col sm:flex-row items-center justify-between gap-4 text-xs text-[var(--ink-muted)] animate-fade-in-up"
            >
              <span className="font-medium uppercase tracking-wider text-[11px]">
                Multi-Merchant Inventory Bridges
              </span>
              <div className="flex flex-wrap items-center gap-4 sm:gap-8 font-medium">
                <span className="flex items-center gap-1.5 hover:text-[var(--ink)] hover:translate-x-0.5 transition-all duration-150">
                  <Store className="w-3.5 h-3.5 text-[var(--accent)]" /> Best Buy Business
                </span>
                <span className="flex items-center gap-1.5 hover:text-[var(--ink)] hover:translate-x-0.5 transition-all duration-150">
                  <Store className="w-3.5 h-3.5 text-[var(--accent)]" /> B&amp;H Photo Video
                </span>
                <span className="flex items-center gap-1.5 hover:text-[var(--ink)] hover:translate-x-0.5 transition-all duration-150">
                  <Store className="w-3.5 h-3.5 text-[var(--accent)]" /> Newegg Commercial
                </span>
                <span className="flex items-center gap-1.5 hover:text-[var(--ink)] hover:translate-x-0.5 transition-all duration-150">
                  <Store className="w-3.5 h-3.5 text-[var(--accent)]" /> Walmart Business
                </span>
                <span className="flex items-center gap-1.5 hover:text-[var(--ink)] hover:translate-x-0.5 transition-all duration-150">
                  <Store className="w-3.5 h-3.5 text-[var(--accent)]" /> Amazon Business
                </span>
              </div>
            </div>
            <div className="text-center sm:text-right pt-1">
              <span className="text-[10px] text-[var(--ink-muted)]">
                *Merchant channels referenced for illustrative catalog demonstration.
              </span>
            </div>
          </div>
        </section>

        {/* ========================================================= */}
        {/* PROBLEM VS. SOLUTION SECTION (#problem) */}
        {/* ========================================================= */}
        <section id="problem" className="py-16 sm:py-24 border-b border-[var(--line)] bg-[var(--surface)]">
          <div className="max-w-[1280px] mx-auto px-4 sm:px-6 space-y-12 sm:space-y-16">
            <ScrollReveal direction="up">
              <div className="max-w-2xl space-y-3">
                <div className="text-xs font-mono font-semibold uppercase tracking-wider text-[var(--accent)]">
                  The Autonomous Procurement Gap
                </div>
                <h2
                  style={{ fontFamily: "var(--font-display)" }}
                  className="text-3xl sm:text-4xl font-semibold text-[var(--ink)] tracking-tight"
                >
                  Why naive AI purchasing breaks down in real enterprise operations.
                </h2>
                <p className="text-sm sm:text-base text-[var(--ink-muted)] leading-relaxed">
                  When companies connect generative AI directly to corporate payment credentials, three systemic failure modes emerge. Plinthly solves each with deterministic software verification.
                </p>
              </div>
            </ScrollReveal>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-6 sm:gap-8">
              {/* Pillar 1 */}
              <ScrollReveal direction="up" staggerIndex={0}>
                <div className="bg-[var(--canvas)] border border-[var(--line)] rounded-xl p-6 space-y-4 flex flex-col justify-between h-full transition-all duration-200 hover:-translate-y-1 hover:shadow-md">
                  <div className="space-y-3">
                    <div className="p-2.5 rounded-lg w-fit bg-[#E05252]/10 text-[#E05252] transition-transform hover:scale-110">
                      <DollarSign className="w-5 h-5" />
                    </div>
                    <h3 className="text-base font-semibold text-[var(--ink)]">
                      Unquoted Shipping &amp; Tax Surprises
                    </h3>
                    <p className="text-xs text-[var(--ink-muted)] leading-relaxed">
                      <strong>The Flaw:</strong> Typical agents scrape sticker prices, omitting merchant shipping tiers and destination sales tax until final checkout, causing budget overruns.
                    </p>
                  </div>

                  <div className="pt-3 border-t border-[var(--line)] space-y-1.5">
                    <div className="flex items-center gap-1.5 text-xs font-medium text-[var(--accent)]">
                      <CheckCircle2 className="w-3.5 h-3.5 text-[#2E7D32]" />
                      <span>Plinthly Landed Cost Engine</span>
                    </div>
                    <p className="text-[11px] text-[var(--ink-muted)]">
                      Simulates jurisdictional sales tax and free-freight bundle thresholds upfront. Purchases with unquoted freight are blocked from approval.
                    </p>
                  </div>
                </div>
              </ScrollReveal>

              {/* Pillar 2 */}
              <ScrollReveal direction="up" staggerIndex={1}>
                <div className="bg-[var(--canvas)] border border-[var(--line)] rounded-xl p-6 space-y-4 flex flex-col justify-between h-full transition-all duration-200 hover:-translate-y-1 hover:shadow-md">
                  <div className="space-y-3">
                    <div className="p-2.5 rounded-lg w-fit bg-[#E5A93C]/10 text-[#E5A93C] transition-transform hover:scale-110">
                      <Cpu className="w-5 h-5" />
                    </div>
                    <h3 className="text-base font-semibold text-[var(--ink)]">
                      Hardware Drift &amp; Obsolete Stock
                    </h3>
                    <p className="text-xs text-[var(--ink-muted)] leading-relaxed">
                      <strong>The Flaw:</strong> Language models optimize blindly for lowest unit price, selecting obsolete refurbished units that fail modern IT standards.
                    </p>
                  </div>

                  <div className="pt-3 border-t border-[var(--line)] space-y-1.5">
                    <div className="flex items-center gap-1.5 text-xs font-medium text-[var(--accent)]">
                      <CheckCircle2 className="w-3.5 h-3.5 text-[#2E7D32]" />
                      <span>Deterministic Spec Auditing</span>
                    </div>
                    <p className="text-[11px] text-[var(--ink-muted)]">
                      Evaluates CPU microarchitecture, RAM limits, SSD protocols, and vendor warranty status before recommending any candidate.
                    </p>
                  </div>
                </div>
              </ScrollReveal>

              {/* Pillar 3 */}
              <ScrollReveal direction="up" staggerIndex={2}>
                <div className="bg-[var(--canvas)] border border-[var(--line)] rounded-xl p-6 space-y-4 flex flex-col justify-between h-full transition-all duration-200 hover:-translate-y-1 hover:shadow-md">
                  <div className="space-y-3">
                    <div className="p-2.5 rounded-lg w-fit bg-[#1F4E5A]/10 text-[var(--accent)] transition-transform hover:scale-110">
                      <Lock className="w-5 h-5" />
                    </div>
                    <h3 className="text-base font-semibold text-[var(--ink)]">
                      Cart Drift &amp; Price Volatility
                    </h3>
                    <p className="text-xs text-[var(--ink-muted)] leading-relaxed">
                      <strong>The Flaw:</strong> Unchecked price increases occur between buyer approval and execution, causing unapproved charges to hit company cards.
                    </p>
                  </div>

                  <div className="pt-3 border-t border-[var(--line)] space-y-1.5">
                    <div className="flex items-center gap-1.5 text-xs font-medium text-[var(--accent)]">
                      <CheckCircle2 className="w-3.5 h-3.5 text-[#2E7D32]" />
                      <span>SHA-256 Snapshot Locking</span>
                    </div>
                    <p className="text-[11px] text-[var(--ink-muted)]">
                      Approval records a SHA-256 cryptographic hash of the approved bundle. Pre-capture checks abort if merchant prices or shipping fees exceed approved limits.
                    </p>
                  </div>
                </div>
              </ScrollReveal>
            </div>
          </div>
        </section>

        {/* ========================================================= */}
        {/* INTERACTIVE PRODUCT SHOWCASE SECTION (#product) */}
        {/* ========================================================= */}
        <section
          id="product"
          className="relative py-18 sm:py-28 border-b border-[var(--line)] bg-[color-mix(in_srgb,var(--surface)_40%,var(--canvas))] overflow-hidden"
        >
          {/* Subtle Ambient Background Highlight for Showcase Prominence */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 -z-10 flex items-center justify-center opacity-30 dark:opacity-15 animate-pulse-subtle"
          >
            <div className="w-[800px] h-[800px] rounded-full bg-[radial-gradient(circle_at_center,var(--accent)_0%,transparent_70%)] blur-[120px]" />
          </div>

          <div className="max-w-[1280px] mx-auto px-4 sm:px-6 space-y-8 sm:space-y-12">
            <ScrollReveal direction="up">
              <div className="max-w-2xl space-y-3">
                <div className="text-xs font-mono font-semibold uppercase tracking-wider text-[var(--accent)]">
                  Live Interface Showcase
                </div>
                <h2
                  style={{ fontFamily: "var(--font-display)" }}
                  className="text-3xl sm:text-4xl font-semibold text-[var(--ink)] tracking-tight"
                >
                  The Multi-Item Procurement Studio.
                </h2>
                <p className="text-sm sm:text-base text-[var(--ink-muted)] leading-relaxed">
                  Test the interactive demonstration preview below. Toggle between Pareto-optimal strategies to see simulated merchant inventory reconciliation, shipping threshold calculation, and cryptographic snapshot locking.
                </p>
              </div>
            </ScrollReveal>

            {/* Interactive Component */}
            <ScrollReveal direction="fade" delayMs={100}>
              <InteractiveStudioPreview />
            </ScrollReveal>
          </div>
        </section>

        {/* ========================================================= */}
        {/* 5-STAGE WORKFLOW SECTION (#workflow) */}
        {/* ========================================================= */}
        <section id="workflow" className="py-16 sm:py-24 border-b border-[var(--line)] bg-[var(--surface)]">
          <div className="max-w-[1280px] mx-auto px-4 sm:px-6 space-y-10 sm:space-y-14">
            <ScrollReveal direction="up">
              <div className="max-w-2xl space-y-3">
                <div className="text-xs font-mono font-semibold uppercase tracking-wider text-[var(--accent)]">
                  How It Works
                </div>
                <h2
                  style={{ fontFamily: "var(--font-display)" }}
                  className="text-3xl sm:text-4xl font-semibold text-[var(--ink)] tracking-tight"
                >
                  The 5-Stage Purchase Assurance Pipeline.
                </h2>
                <p className="text-sm sm:text-base text-[var(--ink-muted)] leading-relaxed">
                  Every enterprise purchase transitions through a transactional relational state machine guaranteed by PostgreSQL triggers and PayPal Orders v2 APIs.
                </p>
              </div>
            </ScrollReveal>

            {/* Interactive Stepper */}
            <ScrollReveal direction="fade" delayMs={100}>
              <WorkflowStepper />
            </ScrollReveal>
          </div>
        </section>

        {/* ========================================================= */}
        {/* ASSURANCE & PAYPAL INTEGRATION SECTION (#assurance) */}
        {/* ========================================================= */}
        <section id="assurance" className="py-16 sm:py-24 border-b border-[var(--line)]">
          <div className="max-w-[1280px] mx-auto px-4 sm:px-6 space-y-12 sm:space-y-16">
            <ScrollReveal direction="up">
              <div className="max-w-2xl space-y-3">
                <div className="text-xs font-mono font-semibold uppercase tracking-wider text-[var(--accent)]">
                  Enterprise Assurance Architecture
                </div>
                <h2
                  style={{ fontFamily: "var(--font-display)" }}
                  className="text-3xl sm:text-4xl font-semibold text-[var(--ink)] tracking-tight"
                >
                  Built for mission-critical procurement controls.
                </h2>
                <p className="text-sm sm:text-base text-[var(--ink-muted)] leading-relaxed">
                  Plinthly bridges AI convenience with corporate financial governance. Every transition is backed by relational database constraints, audit logs, and verified payment rails.
                </p>
              </div>
            </ScrollReveal>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-6 sm:gap-8">
              {/* Feature 1 */}
              <ScrollReveal direction="up" staggerIndex={0}>
                <div className="p-6 rounded-xl border border-[var(--line)] bg-[var(--surface)] space-y-3 h-full transition-all duration-200 hover:-translate-y-1 hover:shadow-md">
                  <div className="p-2.5 rounded-lg w-fit bg-[var(--accent)]/10 text-[var(--accent)] transition-transform hover:scale-110">
                    <Scale className="w-5 h-5" />
                  </div>
                  <h3 className="text-base font-semibold text-[var(--ink)]">
                    Pre-Capture Landed Cost Guard (|Δ| ≤ tolerance)
                  </h3>
                  <p className="text-xs text-[var(--ink-muted)] leading-relaxed">
                    Before a PayPal capture is committed, Plinthly verifies that the sum of captured merchant carts adheres strictly to buyer-approved landed costs. Any unauthorized price creep causes an automatic pre-capture abort.
                  </p>
                </div>
              </ScrollReveal>

              {/* Feature 2 */}
              <ScrollReveal direction="up" staggerIndex={1}>
                <div className="p-6 rounded-xl border border-[var(--line)] bg-[var(--surface)] space-y-3 h-full transition-all duration-200 hover:-translate-y-1 hover:shadow-md">
                  <div className="p-2.5 rounded-lg w-fit bg-[var(--accent)]/10 text-[var(--accent)] transition-transform hover:scale-110">
                    <CreditCard className="w-5 h-5" />
                  </div>
                  <h3 className="text-base font-semibold text-[var(--ink)]">
                    PayPal Orders v2 REST Client
                  </h3>
                  <p className="text-xs text-[var(--ink-muted)] leading-relaxed">
                    Native multi-cart execution with automated OAuth token lifecycle renewal. Supports multi-merchant authorization, capture, and partial refund tracking with full idempotency keys.
                  </p>
                </div>
              </ScrollReveal>

              {/* Feature 3 */}
              <ScrollReveal direction="up" staggerIndex={2}>
                <div className="p-6 rounded-xl border border-[var(--line)] bg-[var(--surface)] space-y-3 h-full transition-all duration-200 hover:-translate-y-1 hover:shadow-md">
                  <div className="p-2.5 rounded-lg w-fit bg-[var(--accent)]/10 text-[var(--accent)] transition-transform hover:scale-110">
                    <FileCheck2 className="w-5 h-5" />
                  </div>
                  <h3 className="text-base font-semibold text-[var(--ink)]">
                    Audit-Proof Relational Ledger
                  </h3>
                  <p className="text-xs text-[var(--ink-muted)] leading-relaxed">
                    Every AI suggestion, human confirmation, specification score, and webhook callback is recorded in append-only audit tables, giving compliance officers clear records for every corporate dollar spent.
                  </p>
                </div>
              </ScrollReveal>
            </div>
          </div>
        </section>

        {/* ========================================================= */}
        {/* FINAL WORKSPACE CTA BANNER */}
        {/* ========================================================= */}
        <section className="py-16 sm:py-24 bg-[color-mix(in_srgb,var(--accent)_6%,var(--surface))] border-b border-[var(--line)]">
          <ScrollReveal direction="up">
            <div className="max-w-[1280px] mx-auto px-4 sm:px-6 text-center space-y-6">
              <h2
                style={{ fontFamily: "var(--font-display)" }}
                className="text-3xl sm:text-5xl font-semibold text-[var(--ink)] tracking-tight"
              >
                Ready to eliminate procurement variance?
              </h2>
              <p className="text-sm sm:text-base text-[var(--ink-muted)] max-w-xl mx-auto leading-relaxed">
                Launch the live Plinthly workspace now. Test natural language multi-item requests, inspect verified strategy allocations, or load synthetic demonstration fixtures.
              </p>
              <div className="pt-2">
                <Link
                  href="/workspace"
                  className="group inline-flex items-center gap-2 bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-[var(--on-accent)] font-medium text-sm px-6 py-3.5 rounded-[var(--radius-control)] shadow-md transition-all duration-200 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                >
                  <span>Launch Procurement Workspace</span>
                  <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform duration-200" />
                </Link>
              </div>
            </div>
          </ScrollReveal>
        </section>
      </main>

      {/* Global Marketing Footer */}
      <MarketingFooter />
    </div>
  );
}
