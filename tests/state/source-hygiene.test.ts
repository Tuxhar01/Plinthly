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

describe("Source hygiene for pure state and audit modules", () => {
  const rootDir = path.resolve(__dirname, "../../");
  const stateDir = path.join(rootDir, "lib/state");
  const auditDir = path.join(rootDir, "lib/audit");

  const filesToScan = [...getFilesRecursively(stateDir), ...getFilesRecursively(auditDir)];

  it("found files to scan in lib/state and lib/audit", () => {
    expect(filesToScan.length).toBeGreaterThan(0);
  });

  for (const file of filesToScan) {
    const relPath = path.relative(rootDir, file).replace(/\\/g, "/");

    describe(`File: ${relPath}`, () => {
      const content = fs.readFileSync(file, "utf8");

      it("does not import forbidden node modules or external packages", () => {
        expect(content).not.toMatch(/from\s+['"]node:fs['"]/);
        expect(content).not.toMatch(/from\s+['"]node:net['"]/);
        expect(content).not.toMatch(/from\s+['"]node:http['"]/);
        expect(content).not.toMatch(/from\s+['"]node:https['"]/);
        expect(content).not.toMatch(/from\s+['"]node:child_process['"]/);
        expect(content).not.toMatch(/from\s+['"]@prisma\/client['"]/);
        expect(content).not.toMatch(/from\s+['"].*paypal.*['"]/i);
        expect(content).not.toMatch(/from\s+['"].*channel3.*['"]/i);
      });

      it("does not instantiate PrismaClient", () => {
        expect(content).not.toMatch(/new\s+PrismaClient/);
        expect(content).not.toContain("PrismaClient");
      });

      it("does not call impure clock or random functions (Date.now, Math.random, new Date())", () => {
        expect(content).not.toContain("Date.now()");
        expect(content).not.toContain("Math.random()");
        // Look for new Date() with empty arguments (allow new Date(arg) or Date.parse(arg))
        expect(content).not.toMatch(/new\s+Date\(\s*\)/);
      });

      it("only permits node:crypto in lib/state/snapshot.ts", () => {
        const matches = content.match(/from\s+['"]node:[^'"]+['"]/g) || [];
        for (const match of matches) {
          if (relPath === "lib/state/snapshot.ts") {
            expect(match).toContain("node:crypto");
          } else {
            // No node: imports allowed in other files
            expect(match).toBeUndefined();
          }
        }
      });
    });
  }
});
