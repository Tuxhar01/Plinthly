"use client";

import * as React from "react";
import { Card } from "../ui/card";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Field } from "../ui/field";
import { Banner } from "../ui/banner";
import { Textarea } from "../ui/textarea";
import {
  createPurchaseApi,
  decomposePurchaseIntentApi,
  confirmQuantityApi,
} from "../../lib/workflow/client-api";
import { PurchaseResponse } from "../../lib/workflow/types";
import { DecomposedIntent } from "../../lib/ai/types";
import { Sparkles } from "lucide-react";

export interface PurchaseRequestCardProps {
  actorId: string;
  onPurchaseCreated: (purchase: PurchaseResponse) => void;
}

function generateIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `idem_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

export function PurchaseRequestCard({
  actorId,
  onPurchaseCreated,
}: PurchaseRequestCardProps) {
  const [naturalLanguagePrompt, setNaturalLanguagePrompt] = React.useState<string>("");
  const [aiLoading, setAiLoading] = React.useState<boolean>(false);
  const [aiError, setAiError] = React.useState<string | null>(null);
  const [aiDraft, setAiDraft] = React.useState<DecomposedIntent | null>(null);

  const [procurementMode, setProcurementMode] = React.useState<"single" | "multi">("single");
  const [multiItems, setMultiItems] = React.useState<
    Array<{
      id: string;
      title: string;
      quantity: number;
      quantitySource: "explicit" | "inferred" | "unresolved" | "legacy_direct";
      quantityConfirmed: boolean;
      originalInferredQuantity: number | null;
      confirmationToken?: string;
      confirmedAt: string | null;
      confirmedBy: string | null;
      budgetDollars: string;
      requirements?: Array<{ key: string; expectedValue?: string; description?: string }>;
    }>
  >([
    {
      id: "line_1",
      title: "Dell XPS 15 Laptop (32GB RAM)",
      quantity: 1,
      quantitySource: "explicit",
      quantityConfirmed: true,
      originalInferredQuantity: null,
      confirmedAt: null,
      confirmedBy: null,
      budgetDollars: "1500.00",
    },
    {
      id: "line_2",
      title: "Dell UltraSharp 27 4K Monitor",
      quantity: 1,
      quantitySource: "explicit",
      quantityConfirmed: true,
      originalInferredQuantity: null,
      confirmedAt: null,
      confirmedBy: null,
      budgetDollars: "400.00",
    },
    {
      id: "line_3",
      title: "USB-C Dual 4K Docking Station",
      quantity: 1,
      quantitySource: "explicit",
      quantityConfirmed: true,
      originalInferredQuantity: null,
      confirmedAt: null,
      confirmedBy: null,
      budgetDollars: "150.00",
    },
  ]);

  const [budgetDollars, setBudgetDollars] = React.useState<string>("150.00");
  const [postalCode, setPostalCode] = React.useState<string>("98101");
  const [requirementsText, setRequirementsText] = React.useState<string>(
    "merchant_spec: Dell XPS 15 or equivalent\nreputation_check: Approved Merchant\nfreshness: Valid recent capture"
  );
  const [quantity, setQuantity] = React.useState<number>(1);
  const [quantitySource, setQuantitySource] = React.useState<
    "explicit" | "inferred" | "unresolved" | "legacy_direct"
  >("explicit");
  const [quantityConfirmed, setQuantityConfirmed] = React.useState<boolean>(true);
  const [originalInferredQuantity, setOriginalInferredQuantity] = React.useState<number | null>(null);
  const [singleConfirmationToken, setSingleConfirmationToken] = React.useState<string | undefined>(undefined);

  const [idempotencyKey, setIdempotencyKey] = React.useState<string>("");
  const [loading, setLoading] = React.useState<boolean>(false);
  const [clientErrors, setClientErrors] = React.useState<Record<string, string>>({});
  const [serverError, setServerError] = React.useState<string | null>(null);
  const [successMessage, setSuccessMessage] = React.useState<string | null>(null);

  const handleConfirmLineItemQuantity = async (idx: number) => {
    const item = multiItems[idx];
    if (!item) return;

    const totalBudgetCents = multiItems.reduce(
      (sum, it) => sum + Math.round((parseFloat(it.budgetDollars) || 0) * 100),
      0
    );

    const draft = {
      budgetCents: totalBudgetCents,
      currency: "USD",
      lineItems: multiItems.map((it) => ({
        id: it.id,
        title: it.title,
        budgetCents: Math.round((parseFloat(it.budgetDollars) || 0) * 100),
        requirements: it.requirements || [],
      })),
    };

    setLoading(true);
    setServerError(null);
    try {
      const res = await confirmQuantityApi(
        {
          draft,
          lineItemId: item.id,
          confirmedQuantity: item.quantity,
        },
        { actorId }
      );

      if (!res.ok) {
        setServerError(`[${res.error.code}] ${res.error.message}`);
        return;
      }

      const conf = res.data.confirmation;
      setMultiItems((prev) => {
        const updated = [...prev];
        updated[idx] = {
          ...item,
          quantityConfirmed: true,
          confirmationToken: conf.confirmationToken,
          confirmedAt: conf.confirmedAt,
          confirmedBy: conf.confirmedBy,
        };
        return updated;
      });
    } finally {
      setLoading(false);
    }
  };

  const handleConfirmSingleQuantity = async () => {
    const parsedDollars = parseFloat(budgetDollars);
    const budgetCents = Math.round((isNaN(parsedDollars) ? 0 : parsedDollars) * 100);

    const draft = {
      budgetCents,
      currency: "USD",
      requirements: requirementsText
        .split("\n")
        .map((r) => r.trim())
        .filter((r) => r.length > 0),
    };

    setLoading(true);
    setServerError(null);
    try {
      const res = await confirmQuantityApi(
        {
          draft,
          lineItemId: "single_item",
          confirmedQuantity: quantity,
        },
        { actorId }
      );

      if (!res.ok) {
        setServerError(`[${res.error.code}] ${res.error.message}`);
        return;
      }

      setSingleConfirmationToken(res.data.confirmation.confirmationToken);
      setQuantityConfirmed(true);
    } finally {
      setLoading(false);
    }
  };

  const handleDecompose = async () => {
    const trimmed = naturalLanguagePrompt.trim();
    if (!trimmed) {
      setAiError("Please enter a natural-language purchase description first.");
      return;
    }

    setAiError(null);
    setAiLoading(true);
    try {
      const result = await decomposePurchaseIntentApi(trimmed, { actorId });
      if (!result.ok) {
        setAiError(`[${result.error.code}] ${result.error.message}`);
      } else {
        const data = result.data;
        setAiDraft(data);

        // Update draft fields without inventing facts
        if (data.budgetCents !== null) {
          setBudgetDollars((data.budgetCents / 100).toFixed(2));
        }

        // Single-item quantity handling:
        if (data.quantity !== null && data.quantitySource === "explicit") {
          setQuantity(data.quantity);
          setQuantitySource("explicit");
          setQuantityConfirmed(true);
          setOriginalInferredQuantity(null);
          setSingleConfirmationToken(undefined);
        } else {
          setQuantity(1);
          setQuantitySource("inferred");
          setQuantityConfirmed(false);
          setOriginalInferredQuantity(1);
          setSingleConfirmationToken(undefined);
        }

        if (data.destination?.postalCode) {
          setPostalCode(data.destination.postalCode);
        }
        if (data.requirements && data.requirements.length > 0) {
          const formatted = data.requirements
            .map((r) => (r.expectedValue ? `${r.key}: ${r.expectedValue}` : r.key))
            .join("\n");
          setRequirementsText(formatted);
        }

        // Multi-Item mode integration:
        if (data.lineItems && data.lineItems.length > 1) {
          setProcurementMode("multi");
          setMultiItems(
            data.lineItems.map((item, idx) => {
              const isInferred =
                item.quantity === null ||
                item.quantitySource === "inferred" ||
                item.quantitySource === "unresolved";
              return {
                id: `line_${idx + 1}`,
                title: item.title.trim() || `Item ${idx + 1}`,
                quantity: item.quantity && item.quantity >= 1 ? item.quantity : 1,
                quantitySource: isInferred ? ("inferred" as const) : ("explicit" as const),
                quantityConfirmed: !isInferred, // Inferred quantities start UNCONFIRMED (false)
                originalInferredQuantity: isInferred ? (item.originalInferredQuantity ?? 1) : null,
                confirmationToken: undefined,
                confirmedAt: !isInferred ? new Date().toISOString() : null,
                confirmedBy: !isInferred ? actorId : null,
                budgetDollars:
                  item.budgetCents !== null && item.budgetCents !== undefined && item.budgetCents > 0
                    ? (item.budgetCents / 100).toFixed(2)
                    : "",
                requirements: item.requirements || [],
              };
            })
          );
        }
      }
    } finally {
      setAiLoading(false);
    }
  };

  const validate = (): boolean => {
    const errors: Record<string, string> = {};

    if (procurementMode === "multi") {
      if (multiItems.length === 0) {
        errors.multiItems = "At least one line item is required.";
      }
      for (let i = 0; i < multiItems.length; i++) {
        const item = multiItems[i];
        if (!item.title.trim()) {
          errors[`item_${i}_title`] = "Item title is required.";
        }
        const b = parseFloat(item.budgetDollars);
        if (isNaN(b) || b <= 0) {
          errors[`item_${i}_budget`] = "Valid positive budget required.";
        }
        if (item.quantity < 1 || !Number.isInteger(item.quantity)) {
          errors[`item_${i}_quantity`] = "Quantity must be an integer >= 1.";
        }
      }

      const unconfirmed = multiItems.filter(
        (item) => item.quantitySource === "inferred" && !item.quantityConfirmed
      );
      if (unconfirmed.length > 0) {
        errors.multiItems = `Cannot submit purchase: ${unconfirmed.length} line item(s) have unconfirmed inferred quantities. Please click "Confirm" or edit quantity for each item.`;
      }
    } else {
      const parsedDollars = parseFloat(budgetDollars);
      if (isNaN(parsedDollars) || parsedDollars <= 0) {
        errors.budget = "Budget must be a positive number greater than 0.";
      }

      const reqs = requirementsText
        .split("\n")
        .map((r) => r.trim())
        .filter((r) => r.length > 0);
      if (reqs.length === 0) {
        errors.requirements = "At least one requirement is required.";
      }

      if (quantity < 1 || !Number.isInteger(quantity)) {
        errors.quantity = "Quantity must be an integer of 1 or greater.";
      }

      if (quantitySource === "inferred" && !quantityConfirmed) {
        errors.quantity = 'Inferred quantity requires explicit confirmation. Please click "Confirm" or edit quantity.';
      }
    }

    const trimmedPostal = postalCode.trim();
    if (trimmedPostal && !/^\d{5}(-\d{4})?$/.test(trimmedPostal)) {
      errors.postalCode = "Enter a valid 5-digit US ZIP code (e.g. 98101).";
    }

    setClientErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setServerError(null);
    setSuccessMessage(null);

    if (!validate()) {
      return;
    }

    const effectiveKey = idempotencyKey.trim() || generateIdempotencyKey();
    if (!idempotencyKey.trim()) {
      setIdempotencyKey(effectiveKey);
    }

    const destination = postalCode.trim()
      ? {
          country: "US" as const,
          postalCode: postalCode.trim(),
          deliveryMethodPreference: "standard_ground" as const,
        }
      : undefined;

    let budgetCents: number;
    let singleRequirements: (string | { key: string; expectedValue: string })[] = [];
    let lineItemReqs: Array<{
      id: string;
      title: string;
      quantity: number;
      budgetCents: number;
      currency: "USD";
      requirements: Array<string | { key: string; expectedValue?: string; description?: string }>;
      verificationLevel: "standard";
    }> | undefined;
    let requestedQuantity: number;

    if (procurementMode === "multi") {
      budgetCents = multiItems.reduce(
        (sum, item) => sum + Math.round((parseFloat(item.budgetDollars) || 0) * 100),
        0
      );
      requestedQuantity = multiItems.reduce((sum, item) => sum + (item.quantity || 1), 0);
      lineItemReqs = multiItems.map((item) => ({
        id: item.id,
        title: item.title.trim(),
        quantity: item.quantity,
        quantitySource: item.quantitySource,
        quantityConfirmed: item.quantityConfirmed,
        originalInferredQuantity: item.originalInferredQuantity,
        confirmationToken: item.confirmationToken,
        budgetCents: Math.round((parseFloat(item.budgetDollars) || 0) * 100),
        currency: "USD" as const,
        requirements: item.requirements || [],
        verificationLevel: "standard" as const,
      }));
    } else {
      const parsedDollars = parseFloat(budgetDollars);
      budgetCents = Math.round(parsedDollars * 100);
      requestedQuantity = quantity;

      const rawReqLines = requirementsText
        .split("\n")
        .map((r) => r.trim())
        .filter((r) => r.length > 0);

      singleRequirements = rawReqLines.map((line) => {
        const colonIdx = line.indexOf(":");
        if (colonIdx > 0) {
          return {
            key: line.substring(0, colonIdx).trim(),
            expectedValue: line.substring(colonIdx + 1).trim(),
          };
        }
        return line;
      });
    }

    setLoading(true);
    try {
      const result = await createPurchaseApi(
        {
          budgetCents,
          currency: "USD",
          requirements: procurementMode === "multi" ? [] : singleRequirements,
          lineItems: lineItemReqs,
          requestedQuantity,
          quantitySource: procurementMode === "single" ? quantitySource : undefined,
          quantityConfirmed: procurementMode === "single" ? quantityConfirmed : undefined,
          originalInferredQuantity: procurementMode === "single" ? originalInferredQuantity : undefined,
          confirmationToken: procurementMode === "single" ? singleConfirmationToken : undefined,
          destination,
          confirmImmediately: true,
          idempotencyKey: effectiveKey,
        },
        {
          actorId,
          idempotencyKey: effectiveKey,
        }
      );

      if (!result.ok) {
        setServerError(`[${result.error.code}] ${result.error.message}`);
      } else {
        setSuccessMessage(`Purchase ${result.data.id} created successfully.`);
        onPurchaseCreated(result.data);
      }
    } finally {
      setLoading(false);
    }
  };

  const handleNewIdempotencyKey = () => {
    setIdempotencyKey(generateIdempotencyKey());
    setServerError(null);
    setSuccessMessage(null);
  };

  return (
    <Card heading="1. Submit Purchase Request" className="mb-6">
      <p className="text-xs text-[var(--ink-muted)] mb-4">
        Initiate a new Plinthly purchase assurance lifecycle. Server validates requirements and establishes initial draft terms.
      </p>

      {/* Gemini Natural Language Decomposition Assistant */}
      <div className="mb-6 p-4 rounded-md border border-[var(--line)] bg-[var(--surface-muted)]">
        <div className="flex items-center gap-2 mb-2">
          <Sparkles className="w-4 h-4 text-purple-600" />
          <h3 className="text-sm font-semibold text-[var(--ink-base)]">
            AI Purchase Intent Decomposition (Google Gemini)
          </h3>
        </div>
        <p className="text-xs text-[var(--ink-muted)] mb-3">
          Describe what you want to purchase in plain English. Gemini extracts structured draft requirements for your review and editing before submission.
        </p>

        <div className="flex flex-col gap-2">
          <Textarea
            id="natural-language-prompt"
            rows={2}
            value={naturalLanguagePrompt}
            onChange={(e) => setNaturalLanguagePrompt(e.target.value)}
            placeholder="e.g. I need 2 Dell XPS 15 laptops with 32GB RAM under $2,500 total for delivery by Friday"
            disabled={aiLoading || loading}
          />

          <div className="flex justify-end">
            <Button
              type="button"
              variant="secondary"
              onClick={handleDecompose}
              loading={aiLoading}
              disabled={aiLoading || loading || !naturalLanguagePrompt.trim()}
              className="text-xs"
            >
              Decompose with Gemini
            </Button>
          </div>
        </div>

        {aiError && (
          <div className="mt-3">
            <Banner variant="error">{aiError}</Banner>
          </div>
        )}

        {aiDraft && (
          <div className="mt-3 flex flex-col gap-2">
            <Banner variant="info">
              <div className="flex flex-col gap-1">
                <span className="font-semibold text-xs">
                  AI Draft Generated — Buyer Review Required:
                </span>
                <span className="text-xs">
                  Keywords: <span className="font-mono">{aiDraft.productKeywords}</span> | Model Confidence Estimate:{" "}
                  <span className="font-semibold capitalize">{aiDraft.confidenceEstimate.label}</span>{" "}
                  ({Math.round(aiDraft.confidenceEstimate.score * 100)}%, uncalibrated model estimate, not a calibrated probability).
                </span>
                {aiDraft.confidenceEstimate.notes && (
                  <span className="text-xs text-[var(--ink-muted)]">
                    Notes: {aiDraft.confidenceEstimate.notes}
                  </span>
                )}
              </div>
            </Banner>

            {aiDraft.unresolvedAmbiguities.length > 0 && (
              <Banner variant="error">
                <div className="flex flex-col gap-1 text-xs">
                  <span className="font-semibold">Unresolved Ambiguities & Missing Information:</span>
                  <ul className="list-disc pl-4 space-y-0.5">
                    {aiDraft.unresolvedAmbiguities.map((ambiguity, idx) => (
                      <li key={idx}>{ambiguity}</li>
                    ))}
                  </ul>
                  <span className="italic mt-1">
                    Please review and adjust the populated requirements below before submitting.
                  </span>
                </div>
              </Banner>
            )}
          </div>
        )}
      </div>

      {serverError && (
        <div className="mb-4">
          <Banner variant="error">{serverError}</Banner>
        </div>
      )}

      {successMessage && (
        <div className="mb-4">
          <Banner variant="success">{successMessage}</Banner>
        </div>
      )}

      {/* Mode Switcher: Single Item vs Multi-Item Cart */}
      <div className="flex items-center gap-2 mb-4 border-b border-[var(--line)] pb-3">
        <span className="text-xs font-semibold text-[var(--ink-muted)]">Procurement Mode:</span>
        <button
          type="button"
          onClick={() => setProcurementMode("single")}
          className={`text-xs px-3 py-1.5 rounded font-medium transition-colors ${
            procurementMode === "single"
              ? "bg-[var(--accent)] text-white"
              : "bg-[var(--surface-raised)] text-[var(--ink-muted)] border border-[var(--line)] hover:bg-[var(--surface-hover)]"
          }`}
        >
          Single-Item Procurement
        </button>
        <button
          type="button"
          onClick={() => setProcurementMode("multi")}
          className={`text-xs px-3 py-1.5 rounded font-medium transition-colors ${
            procurementMode === "multi"
              ? "bg-[var(--accent)] text-white"
              : "bg-[var(--surface-raised)] text-[var(--ink-muted)] border border-[var(--line)] hover:bg-[var(--surface-hover)]"
          }`}
        >
          Multi-Item Cart Aggregation
        </button>
      </div>

      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        {procurementMode === "single" ? (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <Field
                label="Total Budget (USD)"
                htmlFor="purchase-budget"
                hint="Enter dollar amount (e.g. 150.00)"
                error={clientErrors.budget}
              >
                <div className="relative">
                  <span className="absolute left-3 top-2 text-sm text-[var(--ink-muted)] select-none">
                    $
                  </span>
                  <Input
                    id="purchase-budget"
                    type="number"
                    step="0.01"
                    min="0.01"
                    value={budgetDollars}
                    onChange={(e) => setBudgetDollars(e.target.value)}
                    error={Boolean(clientErrors.budget)}
                    disabled={loading}
                    className="pl-7"
                    required
                  />
                </div>
              </Field>

              <Field
                label="Requested Quantity"
                htmlFor="purchase-quantity"
                hint={
                  quantitySource === "inferred" && !quantityConfirmed
                    ? "Inferred quantity requires explicit buyer confirmation"
                    : "Number of units"
                }
                error={clientErrors.quantity}
              >
                <div className="flex flex-col gap-1.5">
                  <div className="flex gap-2 items-center">
                    <Input
                      id="purchase-quantity"
                      type="number"
                      min="1"
                      step="1"
                      value={quantity}
                      onChange={(e) => {
                        const parsed = parseInt(e.target.value, 10);
                        const newQty = Number.isInteger(parsed) && parsed >= 1 ? parsed : 1;
                        const isRevertedToInferred =
                          originalInferredQuantity !== null && newQty === originalInferredQuantity;
                        if (isRevertedToInferred) {
                          setQuantity(newQty);
                          setQuantitySource("inferred");
                          setQuantityConfirmed(false);
                          setSingleConfirmationToken(undefined);
                        } else {
                          setQuantity(newQty);
                          setQuantitySource("explicit");
                          setQuantityConfirmed(true);
                          setSingleConfirmationToken(undefined);
                        }
                      }}
                      error={Boolean(clientErrors.quantity)}
                      disabled={loading}
                      className={
                        quantitySource === "inferred" && !quantityConfirmed
                          ? "border-amber-400 bg-amber-50/40 text-amber-950 font-medium"
                          : ""
                      }
                      required
                    />
                    {quantitySource === "inferred" && !quantityConfirmed ? (
                      <Button
                        type="button"
                        variant="secondary"
                        onClick={handleConfirmSingleQuantity}
                        disabled={loading}
                        className="text-xs py-1.5 px-3 bg-amber-100 text-amber-900 border border-amber-300 hover:bg-amber-200 whitespace-nowrap font-medium"
                      >
                        ⚠️ Confirm ({quantity})
                      </Button>
                    ) : quantitySource === "inferred" && quantityConfirmed ? (
                      <span className="text-xs text-emerald-700 font-medium whitespace-nowrap flex items-center gap-1">
                        ✓ Confirmed
                      </span>
                    ) : null}
                  </div>
                </div>
              </Field>

              <Field
                label="Destination (US ZIP)"
                htmlFor="purchase-destination"
                hint="5-digit US postal code"
                error={clientErrors.postalCode}
              >
                <Input
                  id="purchase-destination"
                  type="text"
                  placeholder="e.g. 98101"
                  value={postalCode}
                  onChange={(e) => setPostalCode(e.target.value)}
                  error={Boolean(clientErrors.postalCode)}
                  disabled={loading}
                  className="font-mono"
                />
              </Field>
            </div>

            <Field
              label="Purchase Requirements (one per line, e.g. key: value)"
              htmlFor="purchase-requirements"
              hint="Specify buyer requirements for policy verification"
              error={clientErrors.requirements}
            >
              <Textarea
                id="purchase-requirements"
                rows={3}
                value={requirementsText}
                onChange={(e) => setRequirementsText(e.target.value)}
                error={Boolean(clientErrors.requirements)}
                disabled={loading}
                required
              />
            </Field>
          </>
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Field
                label="Destination (US ZIP)"
                htmlFor="multi-purchase-destination"
                hint="5-digit US postal code for shipping quotes"
                error={clientErrors.postalCode}
              >
                <Input
                  id="multi-purchase-destination"
                  type="text"
                  placeholder="e.g. 98101"
                  value={postalCode}
                  onChange={(e) => setPostalCode(e.target.value)}
                  error={Boolean(clientErrors.postalCode)}
                  disabled={loading}
                  className="font-mono"
                />
              </Field>

              <div className="p-3 bg-[var(--surface-raised)] border border-[var(--line)] rounded-md flex flex-col justify-center">
                <span className="text-xs text-[var(--ink-muted)]">Calculated Aggregate Budget:</span>
                <span className="text-base font-bold font-mono text-[var(--ink)]">
                  $
                  {(
                    multiItems.reduce(
                      (acc, item) => acc + Math.round((parseFloat(item.budgetDollars) || 0) * 100),
                      0
                    ) / 100
                  ).toFixed(2)}{" "}
                  USD
                </span>
                <span className="text-[11px] text-[var(--ink-muted)]">
                  Across {multiItems.length} required item(s)
                </span>
              </div>
            </div>

            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <label className="text-xs font-semibold text-[var(--ink)]">
                  Procurement Line Items ({multiItems.length})
                </label>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() =>
                    setMultiItems([
                      ...multiItems,
                      {
                        id: `line_${multiItems.length + 1}`,
                        title: "",
                        quantity: 1,
                        quantitySource: "explicit",
                        quantityConfirmed: true,
                        originalInferredQuantity: null,
                        confirmedAt: new Date().toISOString(),
                        confirmedBy: actorId,
                        budgetDollars: "50.00",
                      },
                    ])
                  }
                  className="text-xs py-1 px-2.5"
                  disabled={loading}
                >
                  + Add Line Item
                </Button>
              </div>

              {clientErrors.multiItems && (
                <Banner variant="error">{clientErrors.multiItems}</Banner>
              )}

              <div className="space-y-2">
                {multiItems.map((item, idx) => (
                  <div
                    key={item.id}
                    className="p-3 bg-[var(--surface-raised)] border border-[var(--line)] rounded-md flex flex-col sm:flex-row gap-3 items-start sm:items-center"
                  >
                    <span className="font-mono text-xs text-[var(--ink-muted)] w-14">
                      {item.id}
                    </span>
                    <div className="flex-1 w-full">
                      <Input
                        type="text"
                        placeholder="Item Title (e.g. Ergonomic Office Chair)"
                        value={item.title}
                        onChange={(e) => {
                          const updated = [...multiItems];
                          const it = updated[idx];
                          const isConfInferred = it.quantitySource === "inferred" && it.quantityConfirmed;
                          updated[idx] = {
                            ...it,
                            title: e.target.value,
                            ...(isConfInferred
                              ? { quantityConfirmed: false, confirmationToken: undefined, confirmedAt: null, confirmedBy: null }
                              : {}),
                          };
                          setMultiItems(updated);
                        }}
                        disabled={loading}
                        className="text-xs"
                      />
                      {clientErrors[`item_${idx}_title`] && (
                        <span className="text-[10px] text-red-500">
                          {clientErrors[`item_${idx}_title`]}
                        </span>
                      )}
                    </div>
                    <div className="w-32 flex flex-col gap-1">
                      <Input
                        type="number"
                        min="1"
                        step="1"
                        value={item.quantity}
                        onChange={(e) => {
                          const parsed = parseInt(e.target.value, 10);
                          const newQty = Number.isInteger(parsed) && parsed >= 1 ? parsed : 1;
                          const isRevertedToInferred =
                            item.originalInferredQuantity !== null && newQty === item.originalInferredQuantity;
                          const updated = [...multiItems];
                          if (isRevertedToInferred) {
                            updated[idx] = {
                              ...item,
                              quantity: newQty,
                              quantitySource: "inferred",
                              quantityConfirmed: false,
                              confirmationToken: undefined,
                              confirmedAt: null,
                              confirmedBy: null,
                            };
                          } else {
                            updated[idx] = {
                              ...item,
                              quantity: newQty,
                              quantitySource: "explicit",
                              quantityConfirmed: true,
                              confirmationToken: undefined,
                              confirmedAt: new Date().toISOString(),
                              confirmedBy: actorId,
                            };
                          }
                          setMultiItems(updated);
                        }}
                        disabled={loading}
                        className={`text-xs ${
                          item.quantitySource === "inferred" && !item.quantityConfirmed
                            ? "border-amber-400 bg-amber-50/40 text-amber-950 font-medium"
                            : ""
                        }`}
                      />
                      {item.quantitySource === "inferred" && !item.quantityConfirmed ? (
                        <Button
                          type="button"
                          variant="secondary"
                          onClick={() => handleConfirmLineItemQuantity(idx)}
                          disabled={loading}
                          className="text-[10px] py-0.5 px-1 bg-amber-100 text-amber-900 border border-amber-300 hover:bg-amber-200 font-medium"
                        >
                          ⚠️ Confirm ({item.quantity})
                        </Button>
                      ) : item.quantitySource === "inferred" && item.quantityConfirmed ? (
                        <span className="text-[10px] text-emerald-700 font-medium flex items-center gap-1">
                          ✓ Confirmed
                        </span>
                      ) : null}
                    </div>
                    <div className="w-32 relative">
                      <span className="absolute left-2.5 top-2 text-xs text-[var(--ink-muted)]">
                        $
                      </span>
                      <Input
                        type="number"
                        step="0.01"
                        min="0.01"
                        value={item.budgetDollars}
                        onChange={(e) => {
                          const updated = [...multiItems];
                          const it = updated[idx];
                          const isConfInferred = it.quantitySource === "inferred" && it.quantityConfirmed;
                          updated[idx] = {
                            ...it,
                            budgetDollars: e.target.value,
                            ...(isConfInferred
                              ? { quantityConfirmed: false, confirmationToken: undefined, confirmedAt: null, confirmedBy: null }
                              : {}),
                          };
                          setMultiItems(updated);
                        }}
                        disabled={loading}
                        className="text-xs pl-6"
                      />
                    </div>
                    {multiItems.length > 1 && (
                      <Button
                        type="button"
                        variant="secondary"
                        onClick={() => {
                          setMultiItems(multiItems.filter((_, i) => i !== idx));
                        }}
                        disabled={loading}
                        className="text-xs py-1 px-2 text-red-600 hover:text-red-700"
                      >
                        Remove
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        <div className="border-t border-[var(--line)] pt-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div className="flex-1">
            <Field
              label="Idempotency Key (Optional / Reusable)"
              htmlFor="idempotency-key"
              hint="Retrying with the same key safely retrieves or re-applies the original request."
            >
              <div className="flex gap-2">
                <Input
                  id="idempotency-key"
                  value={idempotencyKey}
                  onChange={(e) => setIdempotencyKey(e.target.value)}
                  placeholder="Auto-generated on submit, or enter custom key"
                  disabled={loading}
                  className="font-mono text-xs"
                />
                <Button
                  type="button"
                  variant="secondary"
                  onClick={handleNewIdempotencyKey}
                  disabled={loading}
                  className="whitespace-nowrap"
                >
                  Regenerate
                </Button>
              </div>
            </Field>
          </div>

          <div className="pt-2 sm:pt-5">
            <Button
              type="submit"
              variant="primary"
              loading={loading}
              disabled={
                loading ||
                (procurementMode === "multi"
                  ? multiItems.some((i) => i.quantitySource === "inferred" && !i.quantityConfirmed)
                  : quantitySource === "inferred" && !quantityConfirmed)
              }
              className="w-full sm:w-auto"
            >
              Submit Purchase Request
            </Button>
          </div>
        </div>
      </form>
    </Card>
  );
}
