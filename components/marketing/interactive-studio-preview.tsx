"use client";

import * as React from "react";
import {
  ShieldCheck,
  CheckCircle2,
  Cpu,
  Tv,
  Store,
  Hash,
  Sparkles,
  ArrowRight,
  Info,
} from "lucide-react";
import Link from "next/link";
import { AnimatedNumber } from "../ui/motion";

interface StrategyOption {
  id: "balanced" | "consolidated" | "lowest_cost";
  name: string;
  badge?: string;
  tagline: string;
  merchants: number;
  shipments: number;
  subtotal: number;
  shipping: number;
  tax: number;
  total: number;
  snapshotHash: string;
  laptopMerchant: string;
  laptopPrice: number;
  monitorMerchant: string;
  monitorPrice: number;
}

const STRATEGIES: Record<string, StrategyOption> = {
  balanced: {
    id: "balanced",
    name: "Balanced Optimal",
    badge: "Recommended",
    tagline: "Lowest landed cost with reputable Tier-1 merchants & free shipping",
    merchants: 2,
    shipments: 2,
    subtotal: 724.94,
    shipping: 0.0,
    tax: 75.03,
    total: 799.97,
    snapshotHash: "sha256:f4c935d21a8b9487c90b62e4f014e389aa71e98d821360c2941bca5",
    laptopMerchant: "B&H Photo Video",
    laptopPrice: 641.95,
    monitorMerchant: "Best Buy Business",
    monitorPrice: 82.99,
  },
  consolidated: {
    id: "consolidated",
    name: "Consolidated",
    tagline: "Minimum packages: all items from single verified distributor",
    merchants: 1,
    shipments: 1,
    subtotal: 745.0,
    shipping: 0.0,
    tax: 74.45,
    total: 819.45,
    snapshotHash: "sha256:8a1d7f4e92b3c108d5910fa49321c8b3992b4512ec72149bfa81309",
    laptopMerchant: "B&H Photo Video",
    laptopPrice: 649.0,
    monitorMerchant: "B&H Photo Video",
    monitorPrice: 96.0,
  },
  lowest_cost: {
    id: "lowest_cost",
    name: "Lowest Landed Cost",
    tagline: "Absolute lowest total including shipping fees & estimated taxes",
    merchants: 2,
    shipments: 2,
    subtotal: 712.5,
    shipping: 9.99,
    tax: 66.71,
    total: 789.2,
    snapshotHash: "sha256:3e7a91bf950824b4c7310df0498b21ca8817942ec80f5521b20a4a8",
    laptopMerchant: "Newegg Verified",
    laptopPrice: 634.5,
    monitorMerchant: "Walmart Commercial",
    monitorPrice: 78.0,
  },
};

export function InteractiveStudioPreview() {
  const [activeStrategyKey, setActiveStrategyKey] =
    React.useState<"balanced" | "consolidated" | "lowest_cost">("balanced");

  const current = STRATEGIES[activeStrategyKey];

  return (
    <div className="w-full bg-[var(--surface)] border border-[var(--control-border)] rounded-xl shadow-xl ring-1 ring-[var(--line)]/60 overflow-hidden transition-all duration-300 hover:shadow-2xl">
      {/* Studio Window Chrome */}
      <div className="bg-[color-mix(in_srgb,var(--canvas)_75%,var(--surface))] border-b border-[var(--line)] px-4 py-3 flex items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 rounded-full bg-[#E05252]/80 border border-[#E05252] transition-transform hover:scale-110" />
          <div className="w-3 h-3 rounded-full bg-[#E5A93C]/80 border border-[#E5A93C] transition-transform hover:scale-110" />
          <div className="w-3 h-3 rounded-full bg-[#3FB950]/80 border border-[#3FB950] transition-transform hover:scale-110" />
          <span className="ml-2 text-xs font-mono text-[var(--ink-muted)]">
            plinthly.procure/demo/pur_1794149129429
          </span>
        </div>

        <div className="flex items-center gap-2">
          <span className="hidden sm:inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[11px] font-medium bg-[#1F4E5A]/10 text-[var(--accent)] border border-[var(--accent)]/20 transition-colors">
            <ShieldCheck className="w-3 h-3" />
            <span>Policy Evaluation Verified</span>
          </span>
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[11px] font-medium bg-[#2E7D32]/10 text-[#2E7D32] dark:text-[#4ADE80] border border-[#2E7D32]/25 transition-colors">
            <CheckCircle2 className="w-3 h-3" />
            <span>Variance Guard (|Δ| = $0.00)</span>
          </span>
        </div>
      </div>

      {/* Demonstration Banner */}
      <div className="px-4 py-2 bg-[#E5A93C]/10 border-b border-[var(--line)] text-[#B45309] dark:text-[#FBBF24] text-xs flex flex-col sm:flex-row sm:items-center justify-between gap-2">
        <span className="flex items-center gap-2 font-medium">
          <Info className="w-4 h-4 shrink-0" />
          <span>Interactive Preview: Synthetic test fixture representing an evaluated laptop + monitor procurement.</span>
        </span>
        <span className="font-mono text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-[var(--surface)] text-[var(--ink-muted)] border border-[var(--line)] w-fit">
          Synthetic Demo Data
        </span>
      </div>

      <div className="p-4 sm:p-6 lg:p-7 space-y-6">
        {/* Natural Language Prompt & AI Decomposition Header */}
        <div className="bg-[var(--canvas)] border border-[var(--line)] rounded-lg p-4 space-y-2.5 transition-colors duration-200">
          <div className="flex items-center justify-between text-xs text-[var(--ink-muted)]">
            <span className="flex items-center gap-1.5 font-medium text-[var(--accent)]">
              <Sparkles className="w-3.5 h-3.5 animate-pulse-subtle" />
              <span>Gemini Decomposition (Sample Prompt)</span>
            </span>
            <span className="font-mono">Demo Budget Limit: $1,500.00</span>
          </div>
          <p className="text-sm font-medium text-[var(--ink)] italic">
            &ldquo;I need a good laptop for software development and a monitor for my setup. Deliver them as soon as possible.&rdquo;
          </p>
          <div className="flex flex-wrap gap-2 pt-1 text-[11px]">
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-[var(--surface)] border border-[var(--line)] text-[var(--ink)] transition-transform hover:-translate-y-0.5">
              <Cpu className="w-3 h-3 text-[var(--accent)]" /> 1× Laptop (Intel Core 5 / 16GB RAM / 512GB SSD)
            </span>
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-[var(--surface)] border border-[var(--line)] text-[var(--ink)] transition-transform hover:-translate-y-0.5">
              <Tv className="w-3 h-3 text-[var(--accent)]" /> 1× Monitor (21.5&quot;+ IPS 100Hz+)
            </span>
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-[var(--surface)] border border-[var(--line)] text-[var(--ink-muted)]">
              ZIP 98101 (Seattle, WA)
            </span>
          </div>
        </div>

        {/* Strategy Switcher */}
        <div>
          <div className="flex items-center justify-between mb-2.5">
            <span className="text-xs font-semibold uppercase tracking-wider text-[var(--ink-muted)]">
              Multi-Cart Allocation Strategy
            </span>
            <span className="text-xs text-[var(--ink-muted)]">
              Select strategy to preview simulated allocation
            </span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
            {(["balanced", "consolidated", "lowest_cost"] as const).map((key) => {
              const strat = STRATEGIES[key];
              const isSelected = activeStrategyKey === key;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => setActiveStrategyKey(key)}
                  className={`text-left p-3 rounded-lg border transition-all duration-200 relative focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] ${
                    isSelected
                      ? "border-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_8%,var(--surface))] shadow-xs scale-[1.01]"
                      : "border-[var(--line)] bg-[var(--surface)] hover:border-[var(--ink-muted)]/50 hover:bg-[var(--canvas)] hover:scale-[1.005]"
                  }`}
                >
                  <div className="flex items-center justify-between gap-1 mb-1">
                    <span className="font-medium text-xs text-[var(--ink)]">
                      {strat.name}
                    </span>
                    {strat.badge && (
                      <span className="text-[10px] font-semibold px-1.5 py-0.2 rounded bg-[var(--accent)] text-[var(--on-accent)] animate-pulse-subtle">
                        {strat.badge}
                      </span>
                    )}
                  </div>
                  <div className="text-base font-semibold text-[var(--ink)] font-mono">
                    <AnimatedNumber value={strat.total} />
                  </div>
                  <div className="text-[11px] text-[var(--ink-muted)] mt-1 flex items-center gap-2">
                    <span>{strat.merchants} {strat.merchants === 1 ? "merchant" : "merchants"}</span>
                    <span>•</span>
                    <span>{strat.shipping === 0 ? "Free ship" : `+$${strat.shipping.toFixed(2)} ship`}</span>
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Line Items & Allocation Breakdown */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
          {/* Items & Merchants (Left Col - 7 cols) */}
          <div className="lg:col-span-7 space-y-3">
            <div className="text-xs font-semibold uppercase tracking-wider text-[var(--ink-muted)]">
              Allocated Items &amp; Provenance (Illustrative)
            </div>

            {/* Laptop Item Card */}
            <div className="p-3.5 rounded-lg border border-[var(--line)] bg-[var(--surface)] space-y-2 transition-all duration-200 hover:shadow-xs">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-start gap-2.5">
                  <div className="p-2 rounded bg-[color-mix(in_srgb,var(--accent)_10%,transparent)] text-[var(--accent)] mt-0.5 transition-transform hover:scale-105">
                    <Cpu className="w-4 h-4" />
                  </div>
                  <div>
                    <h4 className="text-xs sm:text-sm font-semibold text-[var(--ink)] leading-snug">
                      Lenovo IdeaPad Slim 3 15&quot;
                    </h4>
                    <p className="text-[11px] text-[var(--ink-muted)]">
                      Core 5 120U • 16GB DDR5 • 512GB NVMe SSD • Win 11 Pro
                    </p>
                  </div>
                </div>
                <div className="text-right">
                  <div className="font-mono text-sm font-semibold text-[var(--ink)]">
                    <AnimatedNumber value={current.laptopPrice} />
                  </div>
                  <span className="text-[10px] text-[var(--ink-muted)]">Qty 1</span>
                </div>
              </div>

              <div className="pt-2 border-t border-[var(--line)]/60 flex items-center justify-between text-[11px]">
                <div className="flex items-center gap-1.5 text-[var(--ink-muted)]">
                  <Store className="w-3 h-3 text-[var(--accent)]" />
                  <span>Merchant: <strong className="text-[var(--ink)] font-medium transition-colors">{current.laptopMerchant}</strong></span>
                </div>
                <span className="text-[#2E7D32] dark:text-[#4ADE80] font-medium flex items-center gap-1">
                  <CheckCircle2 className="w-3 h-3" /> Suitability Verified
                </span>
              </div>
            </div>

            {/* Monitor Item Card */}
            <div className="p-3.5 rounded-lg border border-[var(--line)] bg-[var(--surface)] space-y-2 transition-all duration-200 hover:shadow-xs">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-start gap-2.5">
                  <div className="p-2 rounded bg-[color-mix(in_srgb,var(--accent)_10%,transparent)] text-[var(--accent)] mt-0.5 transition-transform hover:scale-105">
                    <Tv className="w-4 h-4" />
                  </div>
                  <div>
                    <h4 className="text-xs sm:text-sm font-semibold text-[var(--ink)] leading-snug">
                      MSI PRO MP223 21.5&quot; Full HD
                    </h4>
                    <p className="text-[11px] text-[var(--ink-muted)]">
                      1920×1080 • 100Hz Refresh • HDMI/VGA • Anti-Glare IPS
                    </p>
                  </div>
                </div>
                <div className="text-right">
                  <div className="font-mono text-sm font-semibold text-[var(--ink)]">
                    <AnimatedNumber value={current.monitorPrice} />
                  </div>
                  <span className="text-[10px] text-[var(--ink-muted)]">Qty 1</span>
                </div>
              </div>

              <div className="pt-2 border-t border-[var(--line)]/60 flex items-center justify-between text-[11px]">
                <div className="flex items-center gap-1.5 text-[var(--ink-muted)]">
                  <Store className="w-3 h-3 text-[var(--accent)]" />
                  <span>Merchant: <strong className="text-[var(--ink)] font-medium transition-colors">{current.monitorMerchant}</strong></span>
                </div>
                <span className="text-[#2E7D32] dark:text-[#4ADE80] font-medium flex items-center gap-1">
                  <CheckCircle2 className="w-3 h-3" /> In Stock &amp; Fast Ship
                </span>
              </div>
            </div>

            <p className="text-[10px] text-[var(--ink-muted)] pt-1">
              *Illustrative sample candidates. Live purchases query connected catalogs and evaluate current availability.
            </p>
          </div>

          {/* Landed Cost Financial Engine & Cryptographic Lock (Right Col - 5 cols) */}
          <div className="lg:col-span-5 bg-[var(--canvas)] border border-[var(--line)] rounded-lg p-4 flex flex-col justify-between space-y-4 transition-all duration-200">
            <div>
              <div className="flex items-center justify-between mb-3 pb-2 border-b border-[var(--line)]">
                <span className="text-xs font-semibold uppercase tracking-wider text-[var(--ink-muted)]">
                  Landed Cost Breakdown
                </span>
                <span className="text-[11px] font-mono text-[var(--accent)]">
                  WA Tax (10.35%)
                </span>
              </div>

              <div className="space-y-2 text-xs">
                <div className="flex justify-between text-[var(--ink-muted)]">
                  <span>Cart Subtotal (2 items)</span>
                  <span className="font-mono text-[var(--ink)]">
                    <AnimatedNumber value={current.subtotal} />
                  </span>
                </div>

                <div className="flex justify-between text-[var(--ink-muted)]">
                  <span>Shipping &amp; Handling</span>
                  <span className="font-mono text-[var(--ink)]">
                    {current.shipping === 0 ? (
                      <span className="text-[#2E7D32] dark:text-[#4ADE80] font-medium transition-colors">
                        $0.00 (Free)
                      </span>
                    ) : (
                      <AnimatedNumber value={current.shipping} />
                    )}
                  </span>
                </div>

                <div className="flex justify-between text-[var(--ink-muted)]">
                  <span>State &amp; Municipal Sales Tax</span>
                  <span className="font-mono text-[var(--ink)]">
                    <AnimatedNumber value={current.tax} />
                  </span>
                </div>

                <div className="pt-2.5 mt-2.5 border-t border-[var(--line)] flex justify-between items-baseline">
                  <div>
                    <span className="text-sm font-semibold text-[var(--ink)]">
                      Landed Total
                    </span>
                    <p className="text-[10px] text-[var(--ink-muted)]">
                      Calculated prior to payment authorization
                    </p>
                  </div>
                  <span className="font-mono text-xl font-bold text-[var(--accent)]">
                    <AnimatedNumber value={current.total} />
                  </span>
                </div>
              </div>
            </div>

            {/* Cryptographic Snapshot & Sandbox CTA */}
            <div className="space-y-3 pt-3 border-t border-[var(--line)]">
              <div className="p-2.5 rounded bg-[var(--surface)] border border-[var(--line)] space-y-1 transition-colors">
                <div className="flex items-center justify-between text-[10px] text-[var(--ink-muted)]">
                  <span className="flex items-center gap-1 font-mono">
                    <Hash className="w-3 h-3 text-[var(--accent)]" />
                    <span>CANONICAL SNAPSHOT DIGEST</span>
                  </span>
                  <span className="text-[9px] font-mono">SHA-256</span>
                </div>
                <div className="font-mono text-[10px] text-[var(--ink-muted)] truncate select-all transition-opacity duration-200">
                  {current.snapshotHash}
                </div>
              </div>

              <Link
                href="/workspace"
                className="group w-full inline-flex items-center justify-center gap-2 bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-[var(--on-accent)] text-xs font-medium py-2.5 px-4 rounded-[var(--radius-control)] shadow-xs transition-all duration-200 active:scale-[0.98]"
              >
                <span>Open Full Session in Workspace</span>
                <ArrowRight className="w-3.5 h-3.5 group-hover:translate-x-0.5 transition-transform duration-200" />
              </Link>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
