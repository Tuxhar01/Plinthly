-- 1. Create ProcurementDraft Table
CREATE TABLE IF NOT EXISTS "ProcurementDraft" (
    "id" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "budgetCents" INTEGER,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'USD',
    "destination" JSONB,
    "lineItems" JSONB NOT NULL,
    "requirements" JSONB,
    "originalPrompt" TEXT,
    "draftHash" CHAR(64) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProcurementDraft_pkey" PRIMARY KEY ("id")
);

-- 2. Create QuantityConfirmation Table
CREATE TABLE IF NOT EXISTS "QuantityConfirmation" (
    "id" TEXT NOT NULL,
    "draftId" TEXT NOT NULL,
    "lineItemId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "confirmedQuantity" INTEGER NOT NULL,
    "originalInferredQuantity" INTEGER,
    "quantitySource" TEXT NOT NULL,
    "draftHash" CHAR(64) NOT NULL,
    "draftVersion" INTEGER NOT NULL DEFAULT 1,
    "tokenJti" TEXT NOT NULL,
    "tokenHash" CHAR(64) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "consumedPurchaseId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QuantityConfirmation_pkey" PRIMARY KEY ("id")
);

-- 3. Add Additive Nullable originatingDraftId to Purchase
ALTER TABLE "Purchase" ADD COLUMN IF NOT EXISTS "originatingDraftId" TEXT;

-- 4. Create Indexes
CREATE UNIQUE INDEX IF NOT EXISTS "QuantityConfirmation_tokenJti_key" ON "QuantityConfirmation"("tokenJti");
CREATE INDEX IF NOT EXISTS "ProcurementDraft_actorId_status_idx" ON "ProcurementDraft"("actorId", "status");
CREATE INDEX IF NOT EXISTS "ProcurementDraft_draftHash_idx" ON "ProcurementDraft"("draftHash");
CREATE INDEX IF NOT EXISTS "QuantityConfirmation_draftId_lineItemId_idx" ON "QuantityConfirmation"("draftId", "lineItemId");
CREATE INDEX IF NOT EXISTS "QuantityConfirmation_consumedAt_idx" ON "QuantityConfirmation"("consumedAt");
CREATE INDEX IF NOT EXISTS "Purchase_originatingDraftId_idx" ON "Purchase"("originatingDraftId");

-- 5. Foreign Key Constraints
ALTER TABLE "QuantityConfirmation" ADD CONSTRAINT "QuantityConfirmation_draftId_fkey" 
    FOREIGN KEY ("draftId") REFERENCES "ProcurementDraft"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "QuantityConfirmation" ADD CONSTRAINT "QuantityConfirmation_consumedPurchaseId_fkey" 
    FOREIGN KEY ("consumedPurchaseId") REFERENCES "Purchase"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Purchase" ADD CONSTRAINT "Purchase_originatingDraftId_fkey" 
    FOREIGN KEY ("originatingDraftId") REFERENCES "ProcurementDraft"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 6. Trigger for ProcurementDraft updatedAt
CREATE OR REPLACE FUNCTION update_procurement_draft_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW."updatedAt" = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_procurement_draft_updated_at ON "ProcurementDraft";
CREATE TRIGGER trigger_procurement_draft_updated_at
    BEFORE UPDATE ON "ProcurementDraft"
    FOR EACH ROW
    EXECUTE FUNCTION update_procurement_draft_updated_at();

