-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "PurchaseStatus" AS ENUM ('DRAFT', 'REQUIREMENTS_CONFIRMED', 'EVALUATED', 'POLICY_BLOCKED', 'POLICY_PASSED', 'APPROVED', 'ORDER_CREATED', 'BUYER_APPROVED', 'CAPTURE_ATTEMPTED', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CandidateSource" AS ENUM ('channel3', 'seeded');

-- CreateEnum
CREATE TYPE "EvidenceStatus" AS ENUM ('supports', 'contradicts', 'missing');

-- CreateEnum
CREATE TYPE "PolicyOutcome" AS ENUM ('pass', 'block', 'unknown');

-- CreateEnum
CREATE TYPE "PaymentAttemptStatus" AS ENUM ('OPEN', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AuditEventType" AS ENUM ('proposed', 'requirements_confirmed', 'evaluated', 'policy_blocked', 'policy_passed', 'approved', 'approval_invalidated', 'order_created', 'buyer_approved', 'capture_attempted', 'completed', 'failed', 'cancelled');

-- CreateTable
CREATE TABLE "Purchase" (
    "id" TEXT NOT NULL,
    "status" "PurchaseStatus" NOT NULL,
    "requirements" JSONB NOT NULL,
    "budgetCents" INTEGER NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "policyVersion" TEXT,
    "policyEvidenceFingerprint" CHAR(64),
    "selectedCandidateId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Purchase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Candidate" (
    "id" TEXT NOT NULL,
    "purchaseId" TEXT NOT NULL,
    "source" "CandidateSource" NOT NULL,
    "externalId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "merchantName" TEXT NOT NULL,
    "merchantUrl" TEXT NOT NULL,
    "unitPriceCents" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL,
    "shippingCents" INTEGER NOT NULL,
    "totalCents" INTEGER NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "availability" TEXT NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL,
    "snapshotHash" CHAR(64) NOT NULL,

    CONSTRAINT "Candidate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EvidenceItem" (
    "id" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "requirementKey" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "sourceUrl" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL,
    "status" "EvidenceStatus" NOT NULL,

    CONSTRAINT "EvidenceItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PolicyResult" (
    "id" TEXT NOT NULL,
    "purchaseId" TEXT NOT NULL,
    "policyVersion" TEXT NOT NULL,
    "ruleKey" TEXT NOT NULL,
    "outcome" "PolicyOutcome" NOT NULL,
    "detail" TEXT,
    "evaluatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PolicyResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Approval" (
    "id" TEXT NOT NULL,
    "purchaseId" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "snapshotHash" CHAR(64) NOT NULL,
    "totalCents" INTEGER NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "policyVersion" TEXT NOT NULL,
    "evidenceFingerprint" CHAR(64) NOT NULL,
    "approverUserId" TEXT NOT NULL,
    "approvedAt" TIMESTAMP(3) NOT NULL,
    "invalidatedAt" TIMESTAMP(3),
    "invalidationReason" TEXT,

    CONSTRAINT "Approval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentAttempt" (
    "id" TEXT NOT NULL,
    "purchaseId" TEXT NOT NULL,
    "approvalId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "paypalOrderId" TEXT,
    "status" "PaymentAttemptStatus" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "verifiedStatus" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "failureReason" TEXT,

    CONSTRAINT "PaymentAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" TEXT NOT NULL,
    "purchaseId" TEXT NOT NULL,
    "type" "AuditEventType" NOT NULL,
    "actor" JSONB NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Candidate_purchaseId_idx" ON "Candidate"("purchaseId");

-- CreateIndex
CREATE UNIQUE INDEX "Candidate_id_purchaseId_key" ON "Candidate"("id", "purchaseId");

-- CreateIndex
CREATE INDEX "EvidenceItem_candidateId_idx" ON "EvidenceItem"("candidateId");

-- CreateIndex
CREATE INDEX "PolicyResult_purchaseId_policyVersion_idx" ON "PolicyResult"("purchaseId", "policyVersion");

-- CreateIndex
CREATE INDEX "Approval_purchaseId_idx" ON "Approval"("purchaseId");

-- CreateIndex
CREATE UNIQUE INDEX "Approval_id_purchaseId_key" ON "Approval"("id", "purchaseId");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentAttempt_idempotencyKey_key" ON "PaymentAttempt"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentAttempt_paypalOrderId_key" ON "PaymentAttempt"("paypalOrderId");

-- CreateIndex
CREATE INDEX "PaymentAttempt_purchaseId_idx" ON "PaymentAttempt"("purchaseId");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentAttempt_id_purchaseId_key" ON "PaymentAttempt"("id", "purchaseId");

-- CreateIndex
CREATE INDEX "AuditEvent_purchaseId_createdAt_idx" ON "AuditEvent"("purchaseId", "createdAt");

-- AddForeignKey
ALTER TABLE "Purchase" ADD CONSTRAINT "Purchase_selectedCandidateId_id_fkey" FOREIGN KEY ("selectedCandidateId", "id") REFERENCES "Candidate"("id", "purchaseId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Candidate" ADD CONSTRAINT "Candidate_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "Purchase"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvidenceItem" ADD CONSTRAINT "EvidenceItem_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "Candidate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PolicyResult" ADD CONSTRAINT "PolicyResult_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "Purchase"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "Purchase"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_candidateId_purchaseId_fkey" FOREIGN KEY ("candidateId", "purchaseId") REFERENCES "Candidate"("id", "purchaseId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentAttempt" ADD CONSTRAINT "PaymentAttempt_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "Purchase"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentAttempt" ADD CONSTRAINT "PaymentAttempt_approvalId_purchaseId_fkey" FOREIGN KEY ("approvalId", "purchaseId") REFERENCES "Approval"("id", "purchaseId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "Purchase"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Partial unique indexes added per section 12
CREATE UNIQUE INDEX "approval_one_effective_per_purchase" ON "Approval" ("purchaseId") WHERE "invalidatedAt" IS NULL;
CREATE UNIQUE INDEX "payment_attempt_one_live_per_purchase" ON "PaymentAttempt" ("purchaseId") WHERE "status" = 'OPEN';
