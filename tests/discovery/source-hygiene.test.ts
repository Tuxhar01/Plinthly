import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function getFilesRecursively(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...getFilesRecursively(fullPath));
    } else if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".js"))) {
      files.push(fullPath);
    }
  }
  return files;
}

describe("Source hygiene for pure discovery module", () => {
  const rootDir = path.resolve(__dirname, "../../");
  const discoveryDir = path.join(rootDir, "lib/discovery");

  const filesToScan = getFilesRecursively(discoveryDir);

  it("found files to scan in lib/discovery", () => {
    expect(filesToScan.length).toBeGreaterThan(0);
  });

  for (const file of filesToScan) {
    const relPath = path.relative(rootDir, file).replace(/\\/g, "/");

    describe(`File: ${relPath}`, () => {
      const content = fs.readFileSync(file, "utf8");

      it("does not import forbidden node modules or external scraper/AI packages", () => {
        expect(content).not.toMatch(/from\s+['"]node:net['"]/);
        expect(content).not.toMatch(/from\s+['"]node:http['"]/);
        expect(content).not.toMatch(/from\s+['"]node:https['"]/);
        expect(content).not.toMatch(/from\s+['"]node:child_process['"]/);
        expect(content).not.toMatch(/from\s+['"]@prisma\/client['"]/);
        expect(content).not.toMatch(/from\s+['"].*paypal.*['"]/i);
        expect(content).not.toMatch(/from\s+['"].*puppeteer.*['"]/i);
        expect(content).not.toMatch(/from\s+['"].*playwright.*['"]/i);
        expect(content).not.toMatch(/from\s+['"].*cheerio.*['"]/i);
        expect(content).not.toMatch(/from\s+['"].*openai.*['"]/i);
        expect(content).not.toMatch(/from\s+['"].*anthropic.*['"]/i);
      });

      it("does not instantiate PrismaClient", () => {
        expect(content).not.toMatch(/new\s+PrismaClient/);
        expect(content).not.toContain("PrismaClient");
      });

      it("does not perform unconstrained network fetching", () => {
        expect(content).not.toMatch(/\bfetch\s*\(/);
        expect(content).not.toMatch(/\baxios\b/);
      });
    });
  }
});
