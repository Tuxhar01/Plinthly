import { describe, expect, it } from "vitest";
import {
  getAllRules,
  getRegisteredRuleKeys,
  getRule,
} from "../../lib/policy/registry";

describe("Policy Engine - Rule Registry", () => {
  it("registers all eight required rules exactly once", () => {
    const rules = getAllRules();
    expect(rules).toHaveLength(8);

    const keys = rules.map((r) => r.key);
    const uniqueKeys = new Set(keys);
    expect(uniqueKeys.size).toBe(8);
  });

  it("registers the exact required eight standard rule keys", () => {
    const registeredKeys = getRegisteredRuleKeys();
    expect(registeredKeys).toEqual([
      "P-BUDGET",
      "P-CURRENCY",
      "P-QUANTITY",
      "P-EVIDENCE",
      "P-AVAILABILITY",
      "P-VENDOR",
      "P-FRESHNESS",
      "P-DUPLICATE",
    ]);
  });

  it("ensures rule keys and versions remain stable and explicit", () => {
    const expected = [
      { key: "P-BUDGET", version: "1.0.0" },
      { key: "P-CURRENCY", version: "1.0.0" },
      { key: "P-QUANTITY", version: "1.0.0" },
      { key: "P-EVIDENCE", version: "1.0.0" },
      { key: "P-AVAILABILITY", version: "1.0.0" },
      { key: "P-VENDOR", version: "1.0.0" },
      { key: "P-FRESHNESS", version: "1.0.0" },
      { key: "P-DUPLICATE", version: "1.0.0" },
    ];

    for (const exp of expected) {
      const rule = getRule(exp.key);
      expect(rule).toBeDefined();
      expect(rule?.key).toBe(exp.key);
      expect(rule?.version).toBe(exp.version);
    }
  });

  it("returns undefined for unknown rule keys", () => {
    expect(getRule("UNKNOWN-RULE")).toBeUndefined();
    expect(getRule("")).toBeUndefined();
  });
});
