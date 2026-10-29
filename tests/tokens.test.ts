import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const REQUIRED_TOKENS = [
  "canvas",
  "surface",
  "surface-raised",
  "ink",
  "ink-muted",
  "line",
  "control-border",
  "accent",
  "accent-hover",
  "on-accent",
  "pass",
  "caution",
  "block",
  "info",
  "pass-tint",
  "caution-tint",
  "block-tint",
  "info-tint",
  "neutral-tint",
];

const LIGHT_REFERENCES: [string, string, number][] = [
  ["ink", "canvas", 15.89],
  ["ink", "surface", 17.79],
  ["ink", "surface-raised", 17.05],
  ["ink-muted", "canvas", 5.40],
  ["ink-muted", "surface", 6.05],
  ["ink-muted", "surface-raised", 5.79],
  ["accent", "canvas", 8.17],
  ["accent", "surface", 9.15],
  ["on-accent", "accent", 8.17],
  ["on-accent", "accent-hover", 10.59],
  ["pass", "canvas", 5.71],
  ["pass", "surface", 6.39],
  ["caution", "canvas", 5.28],
  ["caution", "surface", 5.91],
  ["block", "canvas", 6.62],
  ["block", "surface", 7.41],
  ["info", "canvas", 6.12],
  ["info", "surface", 6.85],
  ["ink", "pass-tint", 15.06],
  ["ink", "caution-tint", 15.05],
  ["ink", "block-tint", 14.13],
  ["ink", "info-tint", 14.66],
  ["ink", "neutral-tint", 14.67],
  ["pass", "pass-tint", 5.41],
  ["caution", "caution-tint", 5.00],
  ["block", "block-tint", 5.89],
  ["info", "info-tint", 5.64],
  ["accent", "canvas", 8.17],
  ["accent", "surface", 9.15],
  ["control-border", "canvas", 3.45],
  ["control-border", "surface", 3.86],
];

const DARK_REFERENCES: [string, string, number][] = [
  ["ink", "canvas", 15.61],
  ["ink", "surface", 14.39],
  ["ink", "surface-raised", 13.48],
  ["ink-muted", "canvas", 7.21],
  ["ink-muted", "surface", 6.65],
  ["ink-muted", "surface-raised", 6.23],
  ["accent", "canvas", 8.41],
  ["accent", "surface", 7.75],
  ["on-accent", "accent", 8.41],
  ["on-accent", "accent-hover", 10.53],
  ["pass", "canvas", 9.02],
  ["pass", "surface", 8.32],
  ["caution", "canvas", 9.56],
  ["caution", "surface", 8.82],
  ["block", "canvas", 7.49],
  ["block", "surface", 6.91],
  ["info", "canvas", 8.65],
  ["info", "surface", 7.97],
  ["ink", "pass-tint", 12.46],
  ["ink", "caution-tint", 12.78],
  ["ink", "block-tint", 13.35],
  ["ink", "info-tint", 12.99],
  ["ink", "neutral-tint", 12.49],
  ["pass", "pass-tint", 7.20],
  ["caution", "caution-tint", 7.83],
  ["block", "block-tint", 6.41],
  ["info", "info-tint", 7.20],
  ["accent", "canvas", 8.41],
  ["accent", "surface", 7.75],
  ["control-border", "canvas", 4.77],
  ["control-border", "surface", 4.40],
];

function parseHex(hex: string): [number, number, number] {
  if (!/^#[0-9A-Fa-f]{6}$/.test(hex)) {
    throw new Error(`Invalid hex colour format: "${hex}". Only 6-digit hex with leading # accepted.`);
  }
  const num = parseInt(hex.slice(1), 16);
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
}

function channelLuminance(channel: number): number {
  const v = channel / 255;
  return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

function relativeLuminance(hex: string): number {
  const [r, g, b] = parseHex(hex);
  return 0.2126 * channelLuminance(r) + 0.7152 * channelLuminance(g) + 0.0722 * channelLuminance(b);
}

function contrastRatio(hex1: string, hex2: string): number {
  const l1 = relativeLuminance(hex1);
  const l2 = relativeLuminance(hex2);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

function blendHex(fgHex: string, bgHex: string, fgAlpha: number): string {
  const [r1, g1, b1] = parseHex(fgHex);
  const [r2, g2, b2] = parseHex(bgHex);
  const r = Math.round(fgAlpha * r1 + (1 - fgAlpha) * r2);
  const g = Math.round(fgAlpha * g1 + (1 - fgAlpha) * g2);
  const b = Math.round(fgAlpha * b1 + (1 - fgAlpha) * b2);
  const toHex = (n: number) => n.toString(16).padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function parseTokenBlock(cssContent: string, selectorPattern: RegExp): Map<string, string> {
  const match = cssContent.match(selectorPattern);
  if (!match || !match[1]) {
    throw new Error(`Could not find block matching pattern: ${selectorPattern}`);
  }
  const blockContent = match[1];
  const tokenMap = new Map<string, string>();
  const lineRegex = /--([a-z0-9-]+)\s*:\s*(#[0-9A-Fa-f]{6})\s*;/g;
  let lineMatch;
  while ((lineMatch = lineRegex.exec(blockContent)) !== null) {
    const [, name, hex] = lineMatch;
    tokenMap.set(name, hex.toUpperCase());
  }

  // Verify all required tokens are present
  for (const token of REQUIRED_TOKENS) {
    if (!tokenMap.has(token)) {
      throw new Error(`Missing required token: --${token}`);
    }
    const val = tokenMap.get(token)!;
    parseHex(val); // will throw if invalid format
  }

  return tokenMap;
}

describe("WCAG Design Token Contrast Verification", () => {
  const cssPath = path.resolve(__dirname, "../app/globals.css");
  const cssContent = fs.readFileSync(cssPath, "utf-8");

  const lightTokens = parseTokenBlock(cssContent, /:root\s*\{([^}]+)\}/);
  const darkTokens = parseTokenBlock(cssContent, /:root\[data-theme="dark"\]\s*\{([^}]+)\}/);

  const testTheme = (
    themeName: "light" | "dark",
    tokens: Map<string, string>,
    references: [string, string, number][]
  ) => {
    describe(`${themeName} theme`, () => {
      it("meets WCAG 4.5:1 text contrast threshold", () => {
        const textPairs: [string, string][] = [
          ["ink", "canvas"],
          ["ink", "surface"],
          ["ink", "surface-raised"],
          ["ink-muted", "canvas"],
          ["ink-muted", "surface"],
          ["ink-muted", "surface-raised"],
          ["accent", "canvas"],
          ["accent", "surface"],
          ["pass", "canvas"],
          ["pass", "surface"],
          ["caution", "canvas"],
          ["caution", "surface"],
          ["block", "canvas"],
          ["block", "surface"],
          ["info", "canvas"],
          ["info", "surface"],
          ["on-accent", "accent"],
          ["on-accent", "accent-hover"],
          ["ink", "pass-tint"],
          ["ink", "caution-tint"],
          ["ink", "block-tint"],
          ["ink", "info-tint"],
          ["ink", "neutral-tint"],
          ["pass", "pass-tint"],
          ["caution", "caution-tint"],
          ["block", "block-tint"],
          ["info", "info-tint"],
        ];

        for (const [fg, bg] of textPairs) {
          const ratio = contrastRatio(tokens.get(fg)!, tokens.get(bg)!);
          console.log(`[${themeName}] Text: ${fg} on ${bg} => ${ratio.toFixed(2)}:1 (threshold 4.50:1)`);
          expect(ratio).toBeGreaterThanOrEqual(4.5);
        }
      });

      it("meets WCAG 3.0:1 non-text contrast threshold", () => {
        const nonTextPairs: [string, string][] = [
          ["accent", "canvas"], // Focus ring
          ["accent", "surface"],
          ["control-border", "canvas"],
          ["control-border", "surface"],
        ];

        for (const [fg, bg] of nonTextPairs) {
          const ratio = contrastRatio(tokens.get(fg)!, tokens.get(bg)!);
          console.log(`[${themeName}] Non-text: ${fg} on ${bg} => ${ratio.toFixed(2)}:1 (threshold 3.00:1)`);
          expect(ratio).toBeGreaterThanOrEqual(3.0);
        }
      });

      it("matches Section 13 reference ratios within ±0.05 tolerance", () => {
        for (const [fg, bg, refRatio] of references) {
          const ratio = contrastRatio(tokens.get(fg)!, tokens.get(bg)!);
          const diff = Math.abs(ratio - refRatio);
          console.log(
            `[${themeName}] Reference check: ${fg} on ${bg} => measured: ${ratio.toFixed(2)}, ref: ${refRatio.toFixed(2)}, diff: ${diff.toFixed(3)}`
          );
          expect(diff).toBeLessThanOrEqual(0.05);
        }
      });

      it("reports informational disabled control contrast ratios", () => {
        const surfaces = ["canvas", "surface", "surface-raised"];
        for (const s of surfaces) {
          const disabledHex = blendHex(tokens.get("ink-muted")!, tokens.get(s)!, 0.45);
          const ratio = contrastRatio(disabledHex, tokens.get(s)!);
          console.log(`[${themeName}] Informational: disabled control (ink-muted@45%) on ${s} => ${ratio.toFixed(2)}:1`);
        }
      });
    });
  };

  testTheme("light", lightTokens, LIGHT_REFERENCES);
  testTheme("dark", darkTokens, DARK_REFERENCES);
});
