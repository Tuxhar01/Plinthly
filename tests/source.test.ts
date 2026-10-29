import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

describe("Source code constraints and hygiene checks", () => {
  const rootDir = path.resolve(__dirname, "..");

  it("1. Controls must not use the decorative token", () => {
    const inputPath = path.join(rootDir, "components/ui/input.tsx");
    const textareaPath = path.join(rootDir, "components/ui/textarea.tsx");

    const inputContent = fs.readFileSync(inputPath, "utf-8");
    const textareaContent = fs.readFileSync(textareaPath, "utf-8");

    expect(inputContent).not.toContain("var(--line)");
    expect(inputContent).toContain("var(--control-border)");

    expect(textareaContent).not.toContain("var(--line)");
    expect(textareaContent).toContain("var(--control-border)");
  });

  it("2. No hex colour outside the token file", () => {
    const hexRegex = /#[0-9A-Fa-f]{3,8}\b/g;
    const violations: { file: string; line: number; match: string }[] = [];

    const dirsToScan = ["components", "app", "lib"];

    function scanDir(dir: string) {
      const fullPath = path.join(rootDir, dir);
      if (!fs.existsSync(fullPath)) return;
      const entries = fs.readdirSync(fullPath, { withFileTypes: true });

      for (const entry of entries) {
        const entryPath = path.join(fullPath, entry.name);
        if (entry.isDirectory()) {
          scanDir(path.join(dir, entry.name));
        } else if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))) {
          const content = fs.readFileSync(entryPath, "utf-8");
          const lines = content.split("\n");
          lines.forEach((line, idx) => {
            const matches = line.match(hexRegex);
            if (matches) {
              matches.forEach((m) => {
                violations.push({
                  file: path.relative(rootDir, entryPath),
                  line: idx + 1,
                  match: m,
                });
              });
            }
          });
        }
      }
    }

    for (const d of dirsToScan) {
      scanDir(d);
    }

    if (violations.length > 0) {
      const summary = violations
        .map((v) => `${v.file}:${v.line} matched hex ${v.match}`)
        .join("\n");
      expect.fail(`Found hardcoded hex colours outside token file:\n${summary}`);
    }
    expect(violations.length).toBe(0);
  });

  it("3. No SQLite in Prisma schema", () => {
    const schemaPath = path.join(rootDir, "prisma/schema.prisma");
    const schemaContent = fs.readFileSync(schemaPath, "utf-8");

    expect(schemaContent).toContain('provider = "postgresql"');
    expect(schemaContent.toLowerCase()).not.toContain("sqlite");
  });

  it("4. No hardcoded database password in docker-compose.yml", () => {
    const composePath = path.join(rootDir, "docker-compose.yml");
    const composeContent = fs.readFileSync(composePath, "utf-8");

    expect(composeContent).toContain("${POSTGRES_PASSWORD}");
    // Ensure no hardcoded password assignments like POSTGRES_PASSWORD: mypass or POSTGRES_PASSWORD=mypass
    const hardcodedPassMatch = composeContent.match(/POSTGRES_PASSWORD[:=]\s*(?!(\$\{POSTGRES_PASSWORD\}|\s*$))\S+/);
    expect(hardcodedPassMatch).toBeNull();
  });
});
