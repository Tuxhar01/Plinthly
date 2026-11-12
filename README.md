# 🛒 Plinthly
### Every purchase. Proven.

**Evidence-based procurement assurance for AI-powered purchasing.**

Built for the **PayPal AI Hackathon 2026**.

---

## 💡 1. The Problem

Buying products through automated procurement systems sounds simple: describe what you need, compare options, and make a purchase.

In practice, several challenges make this process unreliable:

- **Hidden costs:** Product prices rarely tell the whole story. Shipping fees and taxes can significantly increase the final cost.
- **Unreliable information:** Product specifications, stock availability, and seller details may be incomplete or inaccurate.
- **Uncontrolled purchases:** AI agents should not spend money without clear approval and financial safeguards.

**Plinthly** was built to address these challenges.

It is an AI-assisted procurement assurance platform that helps buyers evaluate products, compare purchasing strategies, verify costs, and approve purchases before payment.

## 🏗️ 2. How Plinthly Works

Plinthly separates AI-powered understanding from financial decision-making.

Google Gemini interprets natural-language purchase requests and converts them into structured requirements. A deterministic assurance engine then evaluates products, costs, and purchasing policies.

The AI assists with understanding the request; it does not independently approve purchases or authorize payments.

### System Architecture

```text
Natural-Language Purchase Request
              |
              v
        Google Gemini
      Intent Decomposition
              |
              v
     Procurement Engine
   Product & Seller Evaluation
   Multi-Merchant Comparison
   Shipping & Tax Validation
              |
              v
        Buyer Approval
    SHA-256 Snapshot Binding
              |
              v
         PayPal Sandbox
    Authorization & Capture
              |
              v
      Audit & Reconciliation
```

## ⚙️ 3. Key Features

### 🤖 AI Purchase Intent Decomposition
Uses Google Gemini to extract product requirements, quantities, budgets, and other details from natural-language requests.

### 🛍️ Multi-Merchant Product Discovery
Evaluates product options across supported merchant catalog sources and compares their suitability.

### 📊 Procurement Strategy Comparison
Supports four purchasing strategies:

- Consolidated Purchasing
- Lowest Landed Cost
- Balanced Optimal Allocation
- Verified Direct Retailer

### 💰 Landed-Cost Verification
Evaluates merchandise prices, discounts, shipping, and applicable taxes before approval. Unknown costs remain unknown rather than being treated as zero.

### 🔐 Human Approval & Snapshot Integrity
Uses SHA-256 snapshot digests to bind buyer approval to the evaluated purchase details. Changes to an approved offer can trigger further verification.

### 💳 PayPal Sandbox Integration
Integrates PayPal Orders v2 for sandbox order creation, buyer approval, capture, and refund workflows, with idempotency and payment reconciliation safeguards.

### 🧾 Audit Trail
Maintains persistent records of procurement decisions, approvals, and payment-related events.

## 🧰 4. Technology Stack

| Component | Technology |
|---|---|
| Frontend | Next.js, React, TypeScript |
| Backend | Next.js API Routes |
| Database | PostgreSQL |
| ORM | Prisma |
| AI | Google Gemini |
| Product Discovery | Channel3 |
| Payments | PayPal Orders v2 |
| Cryptography | SHA-256 |
| Testing | Vitest |
| Deployment | Vercel |

## 🚀 5. Running the Project Locally

### Prerequisites
- Node.js
- npm
- PostgreSQL
- Git

### Installation

```bash
git clone <your-repository-url>
cd plinthly
npm install
```

### Environment Configuration

Create a `.env.local` file in the project root.

Configure the database connection and API credentials required for your selected evaluation mode. Never commit API keys, passwords, or other secrets to the repository.

### Start the Development Server

```bash
npm run dev
```

Open **http://localhost:3000** in your browser.

## 🧪 6. Evaluation Modes

Plinthly supports two distinct evaluation paths.

### 🟢 Mode A: Local Demo Mode

Designed to let judges explore the procurement workflow without requiring external payment credentials.

- Uses synthetic product and merchant fixtures.
- Supports local procurement evaluation.
- Uses simulated payment execution.
- Clearly identifies simulated transactions.
- Does not claim that PayPal processed a payment.

### 🔵 Mode B: PayPal Sandbox Mode

Connects to the PayPal Developer Sandbox.

- Uses server-side PayPal credentials.
- Creates PayPal Orders v2 orders.
- Supports buyer approval through the Sandbox checkout experience.
- Supports payment capture and refund workflows.
- Reconciles payment results against server-side records.

*Sandbox transactions are test transactions, not real-money purchases.*

## ✅ 7. Testing & Verification

The project includes tests for procurement logic, payment workflows, database operations, and cryptographic verification.

Run the following commands:

```bash
# Run the test suite
npm test

# TypeScript validation
npx tsc --noEmit

# Validate Prisma schema
npx prisma validate

# Build the application
npm run build

# Verify database baseline
node scripts/verify-baseline.js
```

**Recorded regression baseline:** 114 test files, 1,568 passing tests.

## 🧠 8. Challenges & Learnings

Building Plinthly involved more than connecting an AI model to a shopping interface.

Some of the most challenging parts were handling incomplete shipping and tax information, preventing unsuitable product recommendations, maintaining consistent purchase snapshots, and designing reliable payment workflows.

One important lesson was that an AI-generated recommendation should never automatically become a financial decision. Procurement requires evidence, validation, and explicit buyer approval.

## 🔭 9. What's Next?

There is still plenty of room to improve Plinthly.

Future development includes:

- Expanding merchant and product coverage.
- Improving access to reliable shipping and tax quotations.
- Strengthening production authentication.
- Improving procurement analytics.
- Refining the buyer approval and checkout experience.

The long-term goal is to make Plinthly a dependable assurance layer for AI-assisted purchasing, where every recommendation, approval, and payment can be traced to supporting evidence.

## 📚 10. Project Documentation

Additional technical documentation is available in the repository:

| Document | Description |
|---|---|
| `PAYPAL_SANDBOX_E2E_EVIDENCE.md` | PayPal Sandbox integration evidence |
| `JUDGE_DEMO_RUNBOOK.md` | Demonstration instructions |
| `HACKATHON_OFFICIAL_COMPLIANCE_MATRIX.md` | Hackathon requirements and compliance |
| `TECHNICAL_ARCHITECTURE_OVERVIEW.md` | Technical architecture |
| `FEATURE_AND_CAPABILITY_DISCLOSURE.md` | Feature boundaries and operational details |
| `PITCH_NARRATIVE.md` | Product positioning and problem statement |

## 📄 11. License

This project is licensed under the **MIT License**.

Copyright © 2026 Tushar Kumar.
