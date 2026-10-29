import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  ServerActorResolver,
  getAuthMode,
  assertPurchaseAccess,
  UnauthorizedError,
  ForbiddenError,
} from "../../lib/workflow/auth";
import { Actor } from "../../lib/state/types";

describe("Phase 4.1 Authentication Boundary & Authorization", () => {
  const savedEnv = {
    NODE_ENV: process.env.NODE_ENV,
    AUTH_MODE: process.env.AUTH_MODE,
    ENABLE_LOCAL_DEMO_AUTH: process.env.ENABLE_LOCAL_DEMO_AUTH,
  };

  const setNodeEnv = (val: string | undefined) => {
    const env = process.env as Record<string, string | undefined>;
    if (val === undefined) {
      delete env.NODE_ENV;
    } else {
      env.NODE_ENV = val;
    }
  };

  beforeEach(() => {
    setNodeEnv(undefined);
    delete process.env.AUTH_MODE;
    delete process.env.ENABLE_LOCAL_DEMO_AUTH;
  });

  afterEach(() => {
    setNodeEnv(savedEnv.NODE_ENV);
    if (savedEnv.AUTH_MODE !== undefined) {
      process.env.AUTH_MODE = savedEnv.AUTH_MODE;
    } else {
      delete process.env.AUTH_MODE;
    }
    if (savedEnv.ENABLE_LOCAL_DEMO_AUTH !== undefined) {
      process.env.ENABLE_LOCAL_DEMO_AUTH = savedEnv.ENABLE_LOCAL_DEMO_AUTH;
    } else {
      delete process.env.ENABLE_LOCAL_DEMO_AUTH;
    }
  });

  describe("Configuration & Secure Defaults", () => {
    it("defaults to 'production' (fail-closed) when configuration is missing", () => {
      expect(getAuthMode()).toBe("production");
    });

    it("defaults to 'production' when configuration is invalid or ambiguous", () => {
      process.env.AUTH_MODE = "unknown_mode";
      expect(getAuthMode()).toBe("production");

      process.env.AUTH_MODE = "staging";
      expect(getAuthMode()).toBe("production");
    });

    it("activates 'local_demo' in non-production when explicitly configured via AUTH_MODE=local_demo", () => {
      setNodeEnv("development");
      process.env.AUTH_MODE = "local_demo";
      expect(getAuthMode()).toBe("local_demo");
    });

    it("activates 'local_demo' in non-production when explicitly configured via ENABLE_LOCAL_DEMO_AUTH=true", () => {
      setNodeEnv("development");
      process.env.ENABLE_LOCAL_DEMO_AUTH = "true";
      expect(getAuthMode()).toBe("local_demo");
    });

    it("activates 'local_demo' in non-production when both demo flags are configured", () => {
      setNodeEnv("development");
      process.env.AUTH_MODE = "local_demo";
      process.env.ENABLE_LOCAL_DEMO_AUTH = "true";
      expect(getAuthMode()).toBe("local_demo");
    });

    it("strictly fails closed in production: NODE_ENV=production never activates local_demo even with AUTH_MODE=local_demo", () => {
      setNodeEnv("production");
      process.env.AUTH_MODE = "local_demo";
      expect(getAuthMode()).toBe("production");
    });

    it("strictly fails closed in production: NODE_ENV=production never activates local_demo even with ENABLE_LOCAL_DEMO_AUTH=true", () => {
      setNodeEnv("production");
      process.env.ENABLE_LOCAL_DEMO_AUTH = "true";
      expect(getAuthMode()).toBe("production");
    });

    it("strictly fails closed in production: NODE_ENV=production never activates local_demo even with both flags set", () => {
      setNodeEnv("production");
      process.env.AUTH_MODE = "local_demo";
      process.env.ENABLE_LOCAL_DEMO_AUTH = "true";
      expect(getAuthMode()).toBe("production");
    });
  });

  describe("Actor Resolution Security Boundary", () => {
    it("strictly rejects client actor headers in production mode", async () => {
      const resolver = new ServerActorResolver("production");

      const req = new Request("http://localhost:3000/api/purchases", {
        headers: {
          "x-actor-id": "spoofed_admin_user",
          "x-actor-kind": "user",
        },
      });

      const res = await resolver.resolveActor(req);
      expect(res.ok).toBe(false);
      expect(res.authMode).toBe("production");
      expect(res.error).toBeInstanceOf(UnauthorizedError);
      expect(res.actor).toBeUndefined();
    });

    it("allows header resolution only when explicitly in local_demo mode", async () => {
      const resolver = new ServerActorResolver("local_demo");

      const req = new Request("http://localhost:3000/api/purchases", {
        headers: {
          "x-actor-id": "demo_buyer_1",
          "x-actor-kind": "user",
        },
      });

      const res = await resolver.resolveActor(req);
      expect(res.ok).toBe(true);
      expect(res.authMode).toBe("local_demo");
      expect(res.actor).toEqual({ kind: "user", userId: "demo_buyer_1" });
    });

    it("defaults to local_dev_user when headers are omitted in local_demo mode", async () => {
      const resolver = new ServerActorResolver("local_demo");
      const req = new Request("http://localhost:3000/api/purchases");

      const res = await resolver.resolveActor(req);
      expect(res.ok).toBe(true);
      expect(res.actor).toEqual({ kind: "user", userId: "local_dev_user" });
    });
  });

  describe("Server-Side Access Control (assertPurchaseAccess)", () => {
    const ownerActor: Actor = { kind: "user", userId: "authorized_owner" };
    const attackerActor: Actor = { kind: "user", userId: "unauthorized_attacker" };
    const systemActor: Actor = { kind: "system", component: "eval_engine" };

    it("permits access when actor matches purchase owner", () => {
      expect(() => assertPurchaseAccess(ownerActor, "authorized_owner", "read")).not.toThrow();
      expect(() => assertPurchaseAccess(ownerActor, "authorized_owner", "approve")).not.toThrow();
      expect(() => assertPurchaseAccess(ownerActor, "authorized_owner", "audit")).not.toThrow();
    });

    it("denies access when user actor does not match purchase owner", () => {
      expect(() => assertPurchaseAccess(attackerActor, "authorized_owner", "read")).toThrow(ForbiddenError);
      expect(() => assertPurchaseAccess(attackerActor, "authorized_owner", "approve")).toThrow(ForbiddenError);
      expect(() => assertPurchaseAccess(attackerActor, "authorized_owner", "audit")).toThrow(ForbiddenError);
    });

    it("permits system actor to evaluate but forbids system actor from approving", () => {
      expect(() => assertPurchaseAccess(systemActor, "authorized_owner", "evaluate")).not.toThrow();
      expect(() => assertPurchaseAccess(systemActor, "authorized_owner", "approve")).toThrow(ForbiddenError);
    });
  });
});
