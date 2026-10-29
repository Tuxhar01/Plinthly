import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

describe("Workflow Source Hygiene & Scope Boundary Invariants", () => {
  const workflowDir = path.resolve(__dirname, "../../lib/workflow");
  const apiDir = path.resolve(__dirname, "../../app/api/purchases");

  function getFilesRecursively(dir: string): string[] {
    if (!fs.existsSync(dir)) return [];
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...getFilesRecursively(fullPath));
      } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
        files.push(fullPath);
      }
    }
    return files;
  }

  const allWorkflowFiles = [
    ...getFilesRecursively(workflowDir),
    ...getFilesRecursively(apiDir),
  ];

  it("ensures files exist to test", () => {
    expect(allWorkflowFiles.length).toBeGreaterThanOrEqual(5);
  });

  it("strictly forbids PayPal SDK or payment execution dependencies in Phase 4 code", () => {
    const forbiddenImports = [
      "@paypal",
      "paypal-rest-sdk",
      "/orders/capture",
      "checkout-sdk",
    ];

    for (const filePath of allWorkflowFiles) {
      const content = fs.readFileSync(filePath, "utf-8");
      for (const forbidden of forbiddenImports) {
        expect(content.toLowerCase()).not.toContain(forbidden.toLowerCase());
      }
    }
  });

  it("strictly forbids AI/LLM SDK dependencies in Phase 4 code", () => {
    const forbiddenAI = [
      "openai",
      "anthropic",
      "langchain",
      "@google/generative-ai",
      "@google/genai",
    ];

    for (const filePath of allWorkflowFiles) {
      const content = fs.readFileSync(filePath, "utf-8");
      for (const ai of forbiddenAI) {
        expect(content.toLowerCase()).not.toContain(ai.toLowerCase());
      }
    }
  });

  it("strictly forbids live web scraping or puppeteer in Phase 4 code", () => {
    const forbiddenScraping = ["puppeteer", "playwright", "cheerio", "selenium"];

    for (const filePath of allWorkflowFiles) {
      const content = fs.readFileSync(filePath, "utf-8");
      for (const scraper of forbiddenScraping) {
        expect(content.toLowerCase()).not.toContain(scraper.toLowerCase());
      }
    }
  });

  it("strictly forbids hardcoded secrets or credentials in Phase 4 code", () => {
    const forbiddenPatterns = [
      /sk-[a-zA-Z0-9]{20,}/,
      /ghp_[a-zA-Z0-9]{20,}/,
      /password\s*=\s*['"][^'"]+['"]/i,
      /secret\s*=\s*['"][^'"]+['"]/i,
    ];

    for (const filePath of allWorkflowFiles) {
      const content = fs.readFileSync(filePath, "utf-8");
      for (const pattern of forbiddenPatterns) {
        expect(pattern.test(content)).toBe(false);
      }
    }
  });
});
