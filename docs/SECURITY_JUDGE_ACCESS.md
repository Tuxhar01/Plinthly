# Plinthly Security Architecture: Judge Access Threat Model & Invariants

## 1. Overview & Objectives

Plinthly is an autonomous procurement agent with strict purchase assurance safeguards. In local development (`AUTH_MODE=local_demo`), actor headers (`x-actor-id`, `x-actor-kind`) are supported for loopback testing. In production (`NODE_ENV=production`), arbitrary client-supplied actor headers must fail closed to protect system integrity.

During the PayPal AI Hackathon evaluation, official judges and evaluators require access to the deployed application to review live end-to-end workflows (requirement decomposition, AG Grid candidate evaluation, deterministic policy execution, and PayPal order authorization). 

This document defines the **Judge Access Threat Model** and specifies the secure, tamper-proof authentication and authorization architecture.

---

## 2. Threat Analysis & Vulnerability Vectors

| Threat Vector | Attack Scenario | Consequence if Unmitigated | Plinthly Mitigation |
| :--- | :--- | :--- | :--- |
| **T-1: Client Header Forgery** | Attacker sends `x-actor-id: admin` or `x-actor-id: target_user` on an open public endpoint. | Unauthorized access to another user's purchase requests or audit logs. | In `NODE_ENV=production`, `ServerActorResolver` strictly ignores untrusted `x-actor-*` headers. |
| **T-2: Cross-Judge Purchase Tampering** | Judge A creates a purchase draft; Judge B or an external visitor evaluates, alters, or approves Judge A's purchase. | State corruption, approval invalidation race conditions, or unverified orders. | Strict tenant isolation via `assertPurchaseAccess`: purchases are permanently owned by `judge_<sessionId>`, and cross-user operations throw `ForbiddenError` (HTTP 403). |
| **T-3: System Actor Privilege Escalation** | An AI agent or background script attempts to self-approve a purchase. | Autonomous agent commits organizational funds without human oversight. | `assertPurchaseAccess` strictly forbids `kind: "system"` actors from approving purchases (`ForbiddenError`). Only human users can approve. |
| **T-4: Brute Force & Credential Guessing** | An attacker scans endpoints trying trivial passcodes to gain evaluator access. | Unauthorized access to staging resources. | Timing-safe token comparison (`crypto.timingSafeEqual`) against `JUDGE_ACCESS_SECRET` (recommended >= 32 characters), combined with API rate limiting. |
| **T-5: Financial Invariant Compromise** | An attacker or compromised workflow triggers a payment capture or unauthorized charge. | Financial loss or violation of hackathon safety constraints. | Gate 1 safeguard (`gate1.mjs`), absence of capture endpoints, and hardcoded `intent=AUTHORIZE`. |

---

## 3. Secure Judge-Access Architecture

### Authentication Mechanism
1. **Secret Configuration:** The deployment environment defines `JUDGE_ACCESS_SECRET`.
2. **Credential Transmission:** Evaluators supply credentials through:
   - `Authorization: Bearer <JUDGE_ACCESS_SECRET>`
   - `x-judge-access-token: <JUDGE_ACCESS_SECRET>`
3. **Session Partitioning:** Evaluators may provide an optional `x-judge-session-id` (alphanumeric, max 64 characters) to maintain their own isolated workspace:
   `userId = "judge_" + (sanitizedSessionId || "evaluator")`
4. **Verification Flow:**
   - Secrets are compared using `crypto.timingSafeEqual` over SHA-256 digests to prevent timing attacks.
   - If `JUDGE_ACCESS_SECRET` is not configured, or if the supplied credential does not match, the resolver fails closed with `401 Unauthorized`.
   - Client-supplied `x-actor-id` or `x-actor-kind` headers are strictly rejected in production.

### Invariant Guarantees
* **Fail-Closed Production Default:** Unauthenticated public requests receive HTTP 401.
* **Deterministic Ownership:** Every purchase record is assigned `ownerUserId`.
* **Zero Capture Policy:** Orders are created with PayPal `intent=AUTHORIZE`. No payment capture endpoints exist.
