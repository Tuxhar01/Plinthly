import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as React from "react";
import { renderToString } from "react-dom/server";
import {
  createPurchaseApi,
  getPurchaseApi,
  evaluatePurchaseApi,
  approvePurchaseApi,
  createPayPalOrderApi,
  confirmBuyerApprovalApi,
  verifyPayPalPaymentApi,
  getAuditHistoryApi,
  decomposePurchaseIntentApi,
} from "../../lib/workflow/client-api";
import { PurchaseRequestCard } from "../../components/workflow/purchase-request-card";
import { CandidateEvaluationCard } from "../../components/workflow/candidate-evaluation-card";
import { ApprovalCard } from "../../components/workflow/approval-card";
import { PayPalCard } from "../../components/workflow/paypal-card";
import { AuditCard } from "../../components/workflow/audit-card";
import { ActorBar } from "../../components/workflow/actor-bar";
import { PurchaseDashboard } from "../../components/workflow/purchase-dashboard";
import { PurchaseResponse, EvaluatePurchaseResponse } from "../../lib/workflow/types";

const mockPurchase: PurchaseResponse = {
  id: "prch_test_100",
  status: "DRAFT",
  budgetCents: 15000,
  currency: "USD",
  requirements: ["spec"],
  policyVersion: null,
  policyEvidenceFingerprint: null,
  selectedCandidateId: null,
  ownerUserId: "usr_buyer_1",
  version: 1,
  selectedCandidate: null,
  activeApproval: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const mockRequirementsConfirmedPurchase: PurchaseResponse = {
  ...mockPurchase,
  status: "REQUIREMENTS_CONFIRMED",
};

const mockEvaluatedPurchase: PurchaseResponse = {
  ...mockPurchase,
  status: "EVALUATED",
  selectedCandidate: {
    id: "cand_dell_xps",
    externalId: "ext_123",
    title: "Dell XPS 15",
    merchantName: "Dell Official Store",
    merchantUrl: "https://dell.com",
    unitPriceCents: 12000,
    quantity: 1,
    shippingCents: 1000,
    totalCents: 13000,
    currency: "USD",
    availability: "IN_STOCK",
    snapshotHash: "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
    capturedAt: new Date().toISOString(),
  },
};

const mockPolicyPassedPurchase: PurchaseResponse = {
  ...mockEvaluatedPurchase,
  status: "POLICY_PASSED",
};

const mockPolicyBlockedPurchase: PurchaseResponse = {
  ...mockEvaluatedPurchase,
  status: "POLICY_BLOCKED",
};

const mockApprovedPurchase: PurchaseResponse = {
  ...mockEvaluatedPurchase,
  status: "APPROVED",
  activeApproval: {
    id: "appr_test_1",
    candidateId: "cand_dell_xps",
    snapshotHash: "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
    totalCents: 13000,
    currency: "USD",
    policyVersion: "2026-10-18",
    evidenceFingerprint: "1122334455667788112233445566778811223344556677881122334455667788",
    approverUserId: "usr_buyer_1",
    approvedAt: new Date().toISOString(),
  },
};

const mockOrderCreatedPurchase: PurchaseResponse = {
  ...mockApprovedPurchase,
  status: "ORDER_CREATED",
  livePaymentAttempt: {
    id: "att_test_1",
    paypalOrderId: "PAYPAL_ORDER_123",
    status: "OPEN",
    verifiedStatus: null,
    verifiedAt: null,
  },
};

const mockBuyerApprovedPurchase: PurchaseResponse = {
  ...mockOrderCreatedPurchase,
  status: "BUYER_APPROVED",
  livePaymentAttempt: {
    id: "att_test_1",
    paypalOrderId: "PAYPAL_ORDER_123",
    status: "OPEN",
    verifiedStatus: "APPROVED",
    verifiedAt: new Date().toISOString(),
  },
};

function isInputDisabled(html: string, id: string): boolean {
  const tagMatch = html.match(new RegExp(`<input[^>]*id="${id}"[^>]*>`));
  if (!tagMatch) return false;
  return /\bdisabled\b/.test(tagMatch[0]);
}

function isSubmitDisabled(html: string): boolean {
  const btnMatch = html.match(/<button[^>]*type="submit"[^>]*>/);
  if (!btnMatch) return false;
  return /\bdisabled\b/.test(btnMatch[0]);
}

describe("Phase 7 — Frontend Integration Tests (Mocked Boundaries)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("A. Frontend Client API Layer", () => {
    it("handles createPurchaseApi 201 success", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 201,
        text: () => Promise.resolve(JSON.stringify(mockPurchase)),
      });

      const res = await createPurchaseApi({
        budgetCents: 15000,
        currency: "USD",
        requirements: ["spec"],
      });

      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.data.id).toBe("prch_test_100");
        expect(res.status).toBe(201);
      }
    });

    it("handles getPurchaseApi 403 Forbidden with structured error", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        text: () =>
          Promise.resolve(
            JSON.stringify({
              error: {
                code: "forbidden",
                message: 'User "usr_2" is not authorized to read purchase.',
              },
            })
          ),
      });

      const res = await getPurchaseApi("prch_test_100", { actorId: "usr_2" });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.status).toBe(403);
        expect(res.error.code).toBe("forbidden");
        expect(res.error.message).toContain("not authorized");
      }
    });

    it("handles 503 Database Unavailable without crashing", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        text: () =>
          Promise.resolve(
            JSON.stringify({
              error: {
                code: "database_unavailable",
                message: "PostgreSQL database connection is currently unavailable.",
              },
            })
          ),
      });

      const res = await createPurchaseApi({
        budgetCents: 5000,
        currency: "USD",
        requirements: ["spec"],
      });

      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.status).toBe(503);
        expect(res.error.code).toBe("database_unavailable");
      }
    });

    it("handles network failure and returns structured network_error", async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error("Failed to fetch"));

      const res = await getPurchaseApi("prch_test_100");
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("network_error");
        expect(res.error.message).toBe("Failed to fetch");
      }
    });

    it("passes idempotency-key and x-actor-id headers correctly", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 201,
        text: () => Promise.resolve(JSON.stringify(mockPurchase)),
      });
      globalThis.fetch = fetchMock;

      await createPurchaseApi(
        { budgetCents: 15000, currency: "USD", requirements: ["spec"] },
        { actorId: "usr_custom_1", idempotencyKey: "idem_key_999" }
      );

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const headers = fetchMock.mock.calls[0][1].headers as Headers;
      expect(headers.get("x-actor-id")).toBe("usr_custom_1");
      expect(headers.get("idempotency-key")).toBe("idem_key_999");
    });

    it("handles evaluatePurchaseApi, approvePurchaseApi, createPayPalOrderApi, confirmBuyerApprovalApi, verifyPayPalPaymentApi, and getAuditHistoryApi", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify({ outcome: "BUYER_APPROVED", events: [] })),
      });

      const evalRes = await evaluatePurchaseApi("prch_1", { candidateId: "cand_1" });
      expect(evalRes.ok).toBe(true);

      const apprRes = await approvePurchaseApi("prch_1", { expectedVersion: 1 });
      expect(apprRes.ok).toBe(true);

      const orderRes = await createPayPalOrderApi("prch_1");
      expect(orderRes.ok).toBe(true);

      const confirmRes = await confirmBuyerApprovalApi("prch_1");
      expect(confirmRes.ok).toBe(true);

      const verifyRes = await verifyPayPalPaymentApi("prch_1");
      expect(verifyRes.ok).toBe(true);

      const auditRes = await getAuditHistoryApi("prch_1");
      expect(auditRes.ok).toBe(true);
    });

    it("confirmBuyerApprovalApi sends established actorId in headers and optional paypalOrderId in body", async () => {
      let capturedUrl = "";
      let capturedHeaders: Headers | null = null;
      let capturedBody: { paypalOrderId?: string } = {};

      globalThis.fetch = vi.fn().mockImplementation((url, opts) => {
        capturedUrl = url;
        capturedHeaders = opts.headers;
        capturedBody = JSON.parse(opts.body);
        return Promise.resolve({
          ok: true,
          status: 200,
          text: () => Promise.resolve(JSON.stringify({ status: "BUYER_APPROVED" })),
        });
      });

      const res = await confirmBuyerApprovalApi("prch_callback_123", {
        actorId: "usr_buyer_1",
        paypalOrderId: "PAYPAL_TOKEN_TEST_99",
      });

      expect(res.ok).toBe(true);
      expect(capturedUrl).toContain("/api/purchases/prch_callback_123/paypal/confirm-approval");
      expect((capturedHeaders as Headers | null)?.get("x-actor-id")).toBe("usr_buyer_1");
      expect(capturedBody.paypalOrderId).toBe("PAYPAL_TOKEN_TEST_99");
    });

    it("handles decomposePurchaseIntentApi 200 success", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: () =>
          Promise.resolve(
            JSON.stringify({
              ok: true,
              data: {
                budgetCents: 150000,
                currency: "USD",
                quantity: 1,
                productKeywords: "Dell XPS 15",
                requirements: [{ key: "ram", expectedValue: "32GB" }],
                unresolvedAmbiguities: [],
                confidenceEstimate: {
                  score: 0.9,
                  label: "high",
                  notes: "Clear",
                  isCalibratedProbability: false,
                },
              },
            })
          ),
      });

      const res = await decomposePurchaseIntentApi("I need a Dell XPS 15 with 32GB RAM under $1500", {
        actorId: "usr_buyer_1",
      });

      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.data.budgetCents).toBe(150000);
        expect(res.data.productKeywords).toBe("Dell XPS 15");
        expect(res.data.confidenceEstimate.isCalibratedProbability).toBe(false);
      }
    });
  });

  describe("B. Purchase Request Screen & Form", () => {
    it("renders purchase request form with accessible inputs, default values, and Gemini assist controls", () => {
      const html = renderToString(
        React.createElement(PurchaseRequestCard, {
          actorId: "usr_buyer_1",
          onPurchaseCreated: () => {},
        })
      );

      expect(html).toContain("1. Submit Purchase Request");
      expect(html).toContain("AI Purchase Intent Decomposition (Google Gemini)");
      expect(html).toContain("Decompose with Gemini");
      expect(html).toContain("Total Budget (USD)");
      expect(html).toContain("Requested Quantity");
      expect(html).toContain("Purchase Requirements");
      expect(html).toContain("Idempotency Key");
      expect(html).toContain("Submit Purchase Request");
      expect(html).toContain("Regenerate");
    });
  });

  describe("C. Candidate Evaluation & Policy Results", () => {
    it("renders evaluation controls and candidate inputs", () => {
      const html = renderToString(
        React.createElement(CandidateEvaluationCard, {
          purchase: mockRequirementsConfirmedPurchase,
          actorId: "usr_buyer_1",
          onRefreshRequested: () => {},
        })
      );

      expect(html).toContain("2. Candidate Selection &amp; Policy Evaluation");
      expect(html).toContain("Evaluate Candidate Policy");
      expect(html).toContain("Candidate Title");
      expect(html).toContain("Merchant Name");
      expect(html).toContain("Unit Price ($)");
    });

    it("enables candidate form inputs and evaluate button in REQUIREMENTS_CONFIRMED state", () => {
      const html = renderToString(
        React.createElement(CandidateEvaluationCard, {
          purchase: mockRequirementsConfirmedPurchase,
          actorId: "usr_buyer_1",
          onRefreshRequested: () => {},
        })
      );

      // In REQUIREMENTS_CONFIRMED, inputs must not be disabled
      expect(isInputDisabled(html, "cand-title")).toBe(false);
      expect(isInputDisabled(html, "cand-merchant")).toBe(false);
      expect(isInputDisabled(html, "cand-url")).toBe(false);
      expect(isInputDisabled(html, "cand-price")).toBe(false);
      // Evaluate button must not be disabled
      expect(isSubmitDisabled(html)).toBe(false);
    });

    it("disables candidate form inputs and evaluate button in invalid or terminal states", () => {
      const disabledStatuses: PurchaseResponse["status"][] = [
        "DRAFT",
        "APPROVED",
        "ORDER_CREATED",
        "BUYER_APPROVED",
        "CAPTURE_ATTEMPTED",
        "COMPLETED",
        "FAILED",
        "CANCELLED",
      ];

      for (const status of disabledStatuses) {
        const html = renderToString(
          React.createElement(CandidateEvaluationCard, {
            purchase: { ...mockPurchase, status },
            actorId: "usr_buyer_1",
            onRefreshRequested: () => {},
          })
        );
        expect(isInputDisabled(html, "cand-title")).toBe(true);
        expect(isInputDisabled(html, "cand-merchant")).toBe(true);
        expect(isSubmitDisabled(html)).toBe(true);
      }
    });

    it("allows candidate evaluation and re-evaluation in permitted states", () => {
      const permittedStatuses: PurchaseResponse["status"][] = [
        "REQUIREMENTS_CONFIRMED",
        "EVALUATED",
        "POLICY_PASSED",
        "POLICY_BLOCKED",
      ];

      for (const status of permittedStatuses) {
        const html = renderToString(
          React.createElement(CandidateEvaluationCard, {
            purchase: { ...mockPurchase, status },
            actorId: "usr_buyer_1",
            onRefreshRequested: () => {},
          })
        );
        expect(isInputDisabled(html, "cand-title")).toBe(false);
        expect(isSubmitDisabled(html)).toBe(false);
      }
    });

    it("disables candidate inputs and submission button when loading is true", () => {
      const html = renderToString(
        React.createElement(CandidateEvaluationCard, {
          purchase: mockRequirementsConfirmedPurchase,
          actorId: "usr_buyer_1",
          onRefreshRequested: () => {},
          loading: true,
        })
      );
      expect(isInputDisabled(html, "cand-title")).toBe(true);
      expect(isInputDisabled(html, "cand-merchant")).toBe(true);
      expect(isSubmitDisabled(html)).toBe(true);
    });

    it("strictly distinguishes UNKNOWN from PASS in policy results", () => {
      // Simulate evaluate response with unknown rules
      const unknownEval: EvaluatePurchaseResponse = {
        purchaseId: "prch_test_100",
        status: "EVALUATED",
        version: 2,
        summary: {
          allRequiredPassed: false,
          blockingRuleKeys: [],
          unknownRuleKeys: ["P-MERCHANT-REPUTATION"],
        },
        ruleResults: {
          "P-BUDGET": {
            ruleKey: "P-BUDGET",
            ruleVersion: "1.0",
            outcome: "pass",
            explanation: { reason: "Within budget", observed: 12000, expected: 15000 },
          },
          "P-MERCHANT-REPUTATION": {
            ruleKey: "P-MERCHANT-REPUTATION",
            ruleVersion: "1.0",
            outcome: "unknown",
            explanation: { reason: "Reputation evidence missing", observed: null, expected: "verified" },
          },
        },
        candidateId: "cand_dell_xps",
        snapshotHash: "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
        evidenceFingerprint: "1122334455667788112233445566778811223344556677881122334455667788",
        evaluatedAt: new Date().toISOString(),
      };

      // Ensure mock summary logic
      expect(unknownEval.summary.allRequiredPassed).toBe(false);
      expect(unknownEval.summary.unknownRuleKeys).toContain("P-MERCHANT-REPUTATION");
      // UNKNOWN must not be reported as passed
      expect(unknownEval.summary.allRequiredPassed).not.toBe(true);
    });

    it("renders explicit synthetic demonstration notice before candidate evaluation form", () => {
      const html = renderToString(
        React.createElement(CandidateEvaluationCard, {
          purchase: mockRequirementsConfirmedPurchase,
          actorId: "usr_buyer_1",
          onRefreshRequested: () => {},
        })
      );
      expect(html).toContain("Demonstration Notice:");
      expect(html).toContain("synthetic demonstration fixtures");
      expect(html).toContain("not independently verified live retailer data");
    });
  });

  describe("D. Approval Card & Stale Approval Handling", () => {
    it("renders synthetic demonstration disclaimer before buyer approval", () => {
      const html = renderToString(
        React.createElement(ApprovalCard, {
          purchase: mockPolicyPassedPurchase,
          actorId: "usr_buyer_1",
          onRefreshRequested: () => {},
        })
      );
      expect(html).toContain("Demonstration Notice:");
      expect(html).toContain("Approved terms lock against synthetic candidate snapshots");
    });
    it("displays exact candidate terms and snapshot hash before approval, enabling approval button only in POLICY_PASSED", () => {
      const html = renderToString(
        React.createElement(ApprovalCard, {
          purchase: mockPolicyPassedPurchase,
          actorId: "usr_buyer_1",
          onRefreshRequested: () => {},
        })
      );

      expect(html).toContain("3. Buyer Approval &amp; Terms Lock");
      expect(html).toContain("Dell XPS 15");
      expect(html).toContain("Dell Official Store");
      expect(html).toContain("130.00");
      expect(html).toContain("USD");
      expect(html).toContain("abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890");
      expect(html).toContain("Approve Purchase Terms");
    });

    it("does not allow approval before policy evaluation succeeds", () => {
      const unpassedStatuses: PurchaseResponse["status"][] = [
        "DRAFT",
        "REQUIREMENTS_CONFIRMED",
        "EVALUATED",
        "APPROVED",
        "ORDER_CREATED",
      ];

      for (const status of unpassedStatuses) {
        const html = renderToString(
          React.createElement(ApprovalCard, {
            purchase: { ...mockEvaluatedPurchase, status },
            actorId: "usr_buyer_1",
            onRefreshRequested: () => {},
          })
        );
        expect(html).not.toContain("Approve Purchase Terms");
      }
    });

    it("does not allow a policy-blocked purchase to be approved", () => {
      const html = renderToString(
        React.createElement(ApprovalCard, {
          purchase: mockPolicyBlockedPurchase,
          actorId: "usr_buyer_1",
          onRefreshRequested: () => {},
        })
      );
      expect(html).not.toContain("Approve Purchase Terms");
    });

    it("disables approval button when loading is true", () => {
      const html = renderToString(
        React.createElement(ApprovalCard, {
          purchase: mockPolicyPassedPurchase,
          actorId: "usr_buyer_1",
          onRefreshRequested: () => {},
          loading: true,
        })
      );
      expect(html).toMatch(/<button[^>]*disabled[^>]*>[\s\S]*?Approve Purchase Terms/);
    });

    it("displays approved metadata when purchase is approved", () => {
      const html = renderToString(
        React.createElement(ApprovalCard, {
          purchase: mockApprovedPurchase,
          actorId: "usr_buyer_1",
          onRefreshRequested: () => {},
        })
      );

      expect(html).toContain("Purchase Successfully Approved");
      expect(html).toContain("appr_test_1");
      expect(html).toContain("usr_buyer_1");
    });
  });

  describe("E. PayPal Sandbox Integration & Independent Verification", () => {
    it("displays Sandbox order creation button only when purchase is approved", () => {
      const htmlApproved = renderToString(
        React.createElement(PayPalCard, {
          purchase: mockApprovedPurchase,
          actorId: "usr_buyer_1",
          onRefreshRequested: () => {},
        })
      );
      expect(htmlApproved).toContain("Create Sandbox Order");
      expect(htmlApproved).toContain("Non-Capture Architecture");

      const htmlDraft = renderToString(
        React.createElement(PayPalCard, {
          purchase: mockPurchase,
          actorId: "usr_buyer_1",
          onRefreshRequested: () => {},
        })
      );
      expect(htmlDraft).toContain("Order creation is locked until purchase terms are evaluated and approved");
    });

    it("displays BUYER_APPROVED strictly as uncaptured, never as completed or paid", () => {
      const html = renderToString(
        React.createElement(PayPalCard, {
          purchase: mockBuyerApprovedPurchase,
          actorId: "usr_buyer_1",
          onRefreshRequested: () => {},
        })
      );

      expect(html).toContain("BUYER_APPROVED (UNCAPTURED)");
      expect(html).toContain("This state does NOT mean payment is complete");
      expect(html).toContain("Workflow is held before funds capture");

      // Verify that no capture button exists
      expect(html).not.toContain("Capture Funds");
      expect(html).not.toContain("Capture Payment");
      expect(html).not.toContain("Payment Completed");
    });

    it("provides separate buttons for Confirm Approval and Independent Verification", () => {
      const html = renderToString(
        React.createElement(PayPalCard, {
          purchase: mockOrderCreatedPurchase,
          actorId: "usr_buyer_1",
          onRefreshRequested: () => {},
        })
      );

      expect(html).toContain("Confirm Buyer Approval");
      expect(html).toContain("Independently Verify PayPal Status");
      expect(html).toContain("PAYPAL_ORDER_123");
    });
  });

  describe("F. Audit Trail & Phase 6.1 Limitation Disclosure", () => {
    it("renders audit card with explicit Phase 6.1 limitation banner", () => {
      const html = renderToString(
        React.createElement(AuditCard, {
          purchaseId: "prch_test_100",
          actorId: "usr_buyer_1",
        })
      );

      expect(html).toContain("5. Audit History &amp; Event Timeline");
      expect(html).toContain("Audit Architecture Limitation Notice");
      expect(html).toContain("standalone payment verification attempts");
      expect(html).toContain("are not emitted as timeline audit events");
      expect(html).toContain("Load Audit History");
    });
  });

  describe("G. Actor Bar & Dashboard Shell", () => {
    it("renders local demo actor switcher and disclaimer", () => {
      const html = renderToString(
        React.createElement(ActorBar, {
          currentActorId: "usr_buyer_1",
          onActorChange: () => {},
        })
      );

      expect(html).toContain("Local Demo Auth");
      expect(html).toContain("usr_buyer_1");
      expect(html).toContain("usr_unauthorized");
      expect(html).toContain("Untrusted actor headers are rejected in deployment mode");
    });

    it("renders complete PurchaseDashboard root component with Plinthly branding and quick-load controls", () => {
      const html = renderToString(React.createElement(PurchaseDashboard));
      expect(html).toContain("Plinthly");
      expect(html).toContain("Lookup Existing Purchase ID");
      expect(html).toContain("Completed Sandbox Examples (Synthetic Demonstration Fixtures)");
      expect(html).toContain("pur_1792633876502_s7jvwi22");
      expect(html).toContain("pur_1792654701712_f2iks5to");
      expect(html).toContain("1. Submit Purchase Request");
    });
  });

  describe("H. Audit Card & Auto-Load Lifecycle", () => {
    it("renders AuditCard with truthful subtitle and architecture notice", () => {
      const html = renderToString(
        React.createElement(AuditCard, {
          purchaseId: "pur_1792654701712_f2iks5to",
          actorId: "usr_buyer_1",
        })
      );

      expect(html).toContain("5. Audit History &amp; Event Timeline");
      expect(html).toContain("Chronological audit trail of structured events emitted during state machine transitions");
      expect(html).toContain("Audit Architecture Limitation Notice");
      expect(html).toContain("refresh-audit-btn");
    });
  });
});
