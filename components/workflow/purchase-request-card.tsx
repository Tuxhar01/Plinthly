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

export interface FormMultiItem {
  id: string;
  title: string;
  quantity: number | null;
  quantitySource: "explicit" | "inferred" | "unresolved" | "legacy_direct" | "manual_override";
  quantityConfirmed: boolean;
  originalInferredQuantity: number | null;
  confirmationToken?: string;
  confirmedAt?: string | null;
  confirmedBy?: string | null;
  budgetDollars: string;
  requirements?: Array<{ key: string; expectedValue?: string; description?: string }>;
}

export function mapLineItemsFromDraft(
  items: Array<{
    id?: string;
    title: string;
    quantity?: number | null;
    quantitySource?: "explicit" | "inferred" | "unresolved" | "legacy_direct" | "manual_override";
    originalInferredQuantity?: number | null;
    budgetCents?: number | null;
    requirements?: Array<{ key: string; expectedValue?: string; description?: string }>;
  }>,
  actorId: string
): FormMultiItem[] {
  return items.map((item, idx) => {
    const hasExplicitCount =
      typeof item.quantity === "number" &&
      item.quantity >= 1 &&
      item.quantitySource === "explicit";

    return {
      id: item.id || `line_${idx + 1}`,
      title: item.title.trim() || `Item ${idx + 1}`,
      // Rule 4: Never invent quantities. Unspecified quantities remain null and unconfirmed.
      quantity: hasExplicitCount ? (item.quantity as number) : null,
      quantitySource: hasExplicitCount ? ("explicit" as const) : ("unresolved" as const),
      quantityConfirmed: hasExplicitCount,
      originalInferredQuantity:
        item.originalInferredQuantity ?? (item.quantitySource === "inferred" ? 1 : null),
      confirmationToken: undefined,
      confirmedAt: hasExplicitCount ? new Date().toISOString() : null,
      confirmedBy: hasExplicitCount ? actorId : null,
      budgetDollars:
        item.budgetCents !== null && item.budgetCents !== undefined && item.budgetCents > 0
          ? (item.budgetCents / 100).toFixed(2)
          : "",
      requirements: item.requirements || [],
    };
  });
}

export function PurchaseRequestCard({
  actorId,
  onPurchaseCreated,
}: PurchaseRequestCardProps) {
  const [naturalLanguagePrompt, setNaturalLanguagePrompt] = React.useState<string>("");
  const [aiLoading, setAiLoading] = React.useState<boolean>(false);
  const [aiError, setAiError] = React.useState<string | null>(null);
  const [aiDraft, setAiDraft] = React.useState<DecomposedIntent | null>(null);
  const activeRequestIdRef = React.useRef<number>(0);

  const [procurementMode, setProcurementMode] = React.useState<"single" | "multi">("single");
  const [multiItems, setMultiItems] = React.useState<FormMultiItem[]>([]);

  const [budgetDollars, setBudgetDollars] = React.useState<string>("");
  const [postalCode, setPostalCode] = React.useState<string>("");
  const [requirementsText, setRequirementsText] = React.useState<string>("");
  const [quantity, setQuantity] = React.useState<number | null>(null);
  const [quantitySource, setQuantitySource] = React.useState<
    "explicit" | "inferred" | "unresolved" | "legacy_direct" | "manual_override"
  >("unresolved");
  const [quantityConfirmed, setQuantityConfirmed] = React.useState<boolean>(false);
  const [originalInferredQuantity, setOriginalInferredQuantity] = React.useState<number | null>(null);
  const [singleConfirmationToken, setSingleConfirmationToken] = React.useState<string | undefined>(undefined);

  // User manual editing & synthetic demonstration flags
  const [isManuallyEdited, setIsManuallyEdited] = React.useState<boolean>(false);
  const [isDemoTemplateLoaded, setIsDemoTemplateLoaded] = React.useState<boolean>(false);

  const [idempotencyKey, setIdempotencyKey] = React.useState<string>("");
  const [loading, setLoading] = React.useState<boolean>(false);
  const [clientErrors, setClientErrors] = React.useState<Record<string, string>>({});
  const [serverError, setServerError] = React.useState<string | null>(null);
  const [successMessage, setSuccessMessage] = React.useState<string | null>(null);

  const handleClearForm = () => {
    setBudgetDollars("");
    setPostalCode("");
    setRequirementsText("");
    setQuantity(null);
    setQuantitySource("unresolved");
    setQuantityConfirmed(false);
    setOriginalInferredQuantity(null);
    setSingleConfirmationToken(undefined);
    setMultiItems([]);
    setAiDraft(null);
    setAiError(null);
    setSuccessMessage(null);
    setServerError(null);
    setClientErrors({});
    setIsManuallyEdited(false);
    setIsDemoTemplateLoaded(false);
  };

  const handleLoadDemoTemplate = () => {
    setIsDemoTemplateLoaded(true);
    setIsManuallyEdited(false);
    setClientErrors({});
    setServerError(null);
    setSuccessMessage(null);
    setAiError(null);
    setAiDraft(null);

    if (procurementMode === "multi") {
      setBudgetDollars("2050.00");
      setPostalCode("98101");
      setMultiItems([
        {
          id: "line_1",
          title: "Dell XPS 15 Laptop (32GB RAM) [Synthetic Demo]",
          quantity: 1,
          quantitySource: "explicit",
          quantityConfirmed: true,
          originalInferredQuantity: null,
          confirmedAt: new Date().toISOString(),
          confirmedBy: actorId,
          budgetDollars: "1500.00",
          requirements: [
            { key: "merchant_spec", expectedValue: "Dell XPS 15 or equivalent" },
            { key: "condition", expectedValue: "New / Certified Refurbished" },
          ],
        },
        {
          id: "line_2",
          title: "Dell UltraSharp 27 4K Monitor [Synthetic Demo]",
          quantity: 1,
          quantitySource: "explicit",
          quantityConfirmed: true,
          originalInferredQuantity: null,
          confirmedAt: new Date().toISOString(),
          confirmedBy: actorId,
          budgetDollars: "400.00",
          requirements: [{ key: "resolution", expectedValue: "4K UHD" }],
        },
        {
          id: "line_3",
          title: "USB-C Dual 4K Docking Station [Synthetic Demo]",
          quantity: 1,
          quantitySource: "explicit",
          quantityConfirmed: true,
          originalInferredQuantity: null,
          confirmedAt: new Date().toISOString(),
          confirmedBy: actorId,
          budgetDollars: "150.00",
          requirements: [{ key: "ports", expectedValue: "Dual HDMI / DisplayPort" }],
        },
      ]);
    } else {
      setBudgetDollars("1500.00");
      setPostalCode("98101");
      setRequirementsText(
        "merchant_spec: Dell XPS 15 (Synthetic Demo)\nreputation_check: Approved Merchant (Demo)\nfreshness: Valid recent capture"
      );
      setQuantity(1);
      setQuantitySource("explicit");
      setQuantityConfirmed(true);
      setOriginalInferredQuantity(null);
      setSingleConfirmationToken(undefined);
    }
  };

  const handleConfirmLineItemQuantity = async (idx: number) => {
    const item = multiItems[idx];
    if (!item) return;

    if (item.quantity === null || item.quantity < 1) {
      setClientErrors((prev) => ({
        ...prev,
        [`item_${idx}_quantity`]: "Please specify an integer quantity of at least 1 before confirming.",
      }));
      return;
    }

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
          quantitySource: "explicit",
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
    if (quantity === null || quantity < 1) {
      setClientErrors((prev) => ({
        ...prev,
        quantity: "Please specify an integer quantity of at least 1 before confirming.",
      }));
      return;
    }

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
          confirmedQuantity: quantity as number,
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

    const currentRequestId = ++activeRequestIdRef.current;
    // Immediately invalidate previous AI draft and errors
    setAiDraft(null);
    setAiError(null);
    setAiLoading(true);

    // If the form was NOT manually edited by the buyer, clear previous draft/demo state
    // so a failed decomposition never leaves unrelated or stale data
    if (!isManuallyEdited) {
      setBudgetDollars("");
      setPostalCode("");
      setRequirementsText("");
      setQuantity(null);
      setQuantitySource("unresolved");
      setQuantityConfirmed(false);
      setOriginalInferredQuantity(null);
      setSingleConfirmationToken(undefined);
      setMultiItems([]);
      setIsDemoTemplateLoaded(false);
    }

    try {
      const result = await decomposePurchaseIntentApi(trimmed, { actorId });

      // Ignore late responses belonging to older requests
      if (activeRequestIdRef.current !== currentRequestId) {
        return;
      }

      if (!result.ok) {
        // On timeout or provider failure, display only the current request's error
        // Never present an old successful extraction as the result of a new request
        setAiError(`[${result.error.code}] ${result.error.message}`);
        setAiDraft(null);
        if (!isManuallyEdited) {
          setBudgetDollars("");
          setPostalCode("");
          setRequirementsText("");
          setQuantity(null);
          setQuantitySource("unresolved");
          setQuantityConfirmed(false);
          setMultiItems([]);
          setIsDemoTemplateLoaded(false);
        }
      } else {
        const data = result.data;
        setAiDraft(data);
        setIsDemoTemplateLoaded(false);
        setIsManuallyEdited(false);

        // Update draft fields without inventing facts
        if (data.budgetCents !== null) {
          setBudgetDollars((data.budgetCents / 100).toFixed(2));
        }

        // Single-item quantity handling:
        if (typeof data.quantity === "number" && data.quantity >= 1 && data.quantitySource === "explicit") {
          setQuantity(data.quantity);
          setQuantitySource("explicit");
          setQuantityConfirmed(true);
          setOriginalInferredQuantity(null);
          setSingleConfirmationToken(undefined);
        } else {
          // Do not silently default to 1! Keep null/unspecified!
          setQuantity(null);
          setQuantitySource("unresolved");
          setQuantityConfirmed(false);
          setOriginalInferredQuantity(null);
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

        // Form synchronization for multi-item intent:
        // Rule 1 & 2: When Gemini successfully returns multiple lineItems, automatically populate multiItems
        // with every extracted item, regardless of whether Single-Item or Multi-Item mode is currently selected.
        try {
          if (data.lineItems && data.lineItems.length > 0) {
            const mappedItems = mapLineItemsFromDraft(data.lineItems, actorId);
            if (mappedItems.length === 0) {
              throw new Error("Line items collection was empty after mapping.");
            }
            setMultiItems(mappedItems);
            // Automatically switch to multi-item mode when multiple items are extracted
            if (mappedItems.length > 1) {
              setProcurementMode("multi");
            }
          }
        } catch (syncErr: unknown) {
          // Rule 7: If extraction succeeds but form synchronization fails, show an explicit error
          // instead of silently displaying an empty form.
          setAiError(
            `[draft_sync_error] ${
              syncErr instanceof Error
                ? syncErr.message
                : "Failed to synchronize extracted line items to procurement form."
            }`
          );
        }
      }
    } catch (err: unknown) {
      if (activeRequestIdRef.current === currentRequestId) {
        setAiError(err instanceof Error ? err.message : "AI intent decomposition failed.");
        setAiDraft(null);
        if (!isManuallyEdited) {
          setBudgetDollars("");
          setPostalCode("");
          setRequirementsText("");
          setQuantity(null);
          setQuantitySource("unresolved");
          setQuantityConfirmed(false);
          setMultiItems([]);
          setIsDemoTemplateLoaded(false);
        }
      }
    } finally {
      if (activeRequestIdRef.current === currentRequestId) {
        setAiLoading(false);
      }
    }
  };

  const validate = (): boolean => {
    const errors: Record<string, string> = {};

    if (procurementMode === "multi") {
      if (multiItems.length === 0) {
        errors.multiItems = "At least one line item is required.";
      }

      const parsedAggregate = parseFloat(budgetDollars);
      const hasValidAggregate = !isNaN(parsedAggregate) && parsedAggregate > 0;
      const hasAnyItemBudget = multiItems.some((it) => {
        const b = parseFloat(it.budgetDollars);
        return !isNaN(b) && b > 0;
      });

      if (!hasValidAggregate && !hasAnyItemBudget) {
        errors.budget = "Please specify an aggregate procurement budget or set individual item budgets.";
      }

      for (let i = 0; i < multiItems.length; i++) {
        const item = multiItems[i];
        if (!item.title.trim()) {
          errors[`item_${i}_title`] = "Item title is required.";
        }
        const b = parseFloat(item.budgetDollars);
        if (!hasValidAggregate && (isNaN(b) || b <= 0)) {
          errors[`item_${i}_budget`] = "Item budget is required when no aggregate budget is set.";
        }
        if (item.quantity === null || item.quantity === undefined || item.quantity < 1 || !Number.isInteger(item.quantity)) {
          errors[`item_${i}_quantity`] = `Quantity for "${item.title}" is unspecified. Please confirm quantity before submission.`;
        }
      }

      const unconfirmed = multiItems.filter(
        (item) => item.quantity === null || !item.quantityConfirmed || item.quantitySource === "unresolved"
      );
      if (unconfirmed.length > 0) {
        errors.multiItems = `Cannot submit purchase: ${unconfirmed.length} line item(s) have unspecified or unconfirmed quantities. Please specify and confirm quantities before submission.`;
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

      if (quantity === null || quantity === undefined || quantity < 1 || !Number.isInteger(quantity)) {
        errors.quantity = "Quantity is unspecified. Buyer confirmation required before submission.";
      } else if (!quantityConfirmed) {
        errors.quantity = "Quantity requires explicit confirmation before submission.";
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
      budgetCents?: number;
      currency: "USD";
      requirements: Array<string | { key: string; expectedValue?: string; description?: string }>;
      verificationLevel: "standard";
    }> | undefined;
    let requestedQuantity: number;

    if (procurementMode === "multi") {
      const parsedAggregate = parseFloat(budgetDollars);
      const itemSum = multiItems.reduce(
        (sum, item) => sum + Math.round((parseFloat(item.budgetDollars) || 0) * 100),
        0
      );
      budgetCents = !isNaN(parsedAggregate) && parsedAggregate > 0
        ? Math.round(parsedAggregate * 100)
        : itemSum;

      requestedQuantity = multiItems.reduce((sum, item) => sum + (item.quantity || 0), 0);
      if (requestedQuantity < 1 || multiItems.some((it) => it.quantity === null || it.quantity < 1)) {
        setClientErrors({ multiItems: "Cannot submit purchase: line item quantities must be specified and at least 1." });
        return;
      }
      lineItemReqs = multiItems.map((item) => {
        const itemB = Math.round((parseFloat(item.budgetDollars) || 0) * 100);
        return {
          id: item.id,
          title: item.title.trim(),
          quantity: item.quantity as number,
          quantitySource: item.quantitySource,
          quantityConfirmed: item.quantityConfirmed,
          originalInferredQuantity: item.originalInferredQuantity,
          confirmationToken: item.confirmationToken,
          budgetCents: itemB > 0 ? itemB : undefined,
          currency: "USD" as const,
          requirements: item.requirements || [],
          verificationLevel: "standard" as const,
        };
      });
    } else {
      if (quantity === null || quantity < 1) {
        setClientErrors({ quantity: "Please specify a quantity of at least 1." });
        return;
      }
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
          <Sparkles className={`w-4 h-4 text-purple-600 ${aiLoading ? "animate-spin" : "animate-pulse-subtle"}`} />
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
          <div className="mt-3 flex flex-col gap-2">
            <Banner variant="error">
              <div className="flex flex-col gap-1">
                <span className="font-semibold text-xs">{aiError}</span>
                <span className="text-xs text-[var(--ink-muted)]">
                  Manual Entry Fallback: You can configure, review, and submit your purchase request manually using the form fields below.
                </span>
              </div>
            </Banner>
            <div className="flex justify-end">
              <Button
                type="button"
                variant="secondary"
                className="text-xs"
                onClick={handleDecompose}
                disabled={aiLoading || !naturalLanguagePrompt.trim()}
              >
                Retry AI Decomposition
              </Button>
            </div>
          </div>
        )}

        {aiDraft && (
          <div className="mt-3 flex flex-col gap-2 animate-fade-in-up duration-250">
            <Banner variant="info">
              <div className="flex flex-col gap-1">
                <span className="font-semibold text-xs">
                  AI Draft Generated — Buyer Review Required:
                </span>
                <span className="text-xs">
                  Keywords: <span className="font-mono">{aiDraft.productKeywords}</span>
                  {procurementMode === "multi" && (
                    <> | Extracted Items: <span className="font-semibold">{multiItems.length}</span></>
                  )}
                  {" "}| Model Assessment:{" "}
                  <span className="font-semibold capitalize">{aiDraft.confidenceEstimate.label}</span>{" "}
                  (Qualitative heuristic estimate; not a calibrated probability).
                </span>
                {aiDraft.confidenceEstimate.notes && (
                  <span className="text-xs text-[var(--ink-muted)]">
                    Notes: {aiDraft.confidenceEstimate.notes}
                  </span>
                )}
                {procurementMode === "multi" && multiItems.length === 0 && (
                  <span className="text-xs text-amber-700 font-medium">
                    Note: Zero line items are currently populated in the multi-item form below.
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
                    {procurementMode === "multi"
                      ? multiItems.length > 0
                        ? "Please review and adjust the populated requirements below before submitting."
                        : "Form currently contains 0 line items. Please review unresolved ambiguities and add line items before submitting."
                      : requirementsText.trim()
                        ? "Please review and adjust the populated requirements below before submitting."
                        : "Form currently contains no populated requirements. Please review unresolved ambiguities and enter requirements before submitting."}
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

      {/* Mode Switcher: Single Item vs Multi-Item Cart & Demo Template Actions */}
      <div className="flex flex-wrap items-center justify-between gap-2 mb-4 border-b border-[var(--line)] pb-3">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-[var(--ink-muted)]">Procurement Mode:</span>
          <button
            type="button"
            onClick={() => setProcurementMode("single")}
            className={`text-xs px-3 py-1.5 rounded font-medium transition-all duration-150 active:scale-[0.98] cursor-pointer ${
              procurementMode === "single"
                ? "bg-[var(--accent)] text-white shadow-2xs"
                : "bg-[var(--surface-raised)] text-[var(--ink-muted)] border border-[var(--line)] hover:bg-[var(--surface-hover)] hover:text-[var(--ink)]"
            }`}
          >
            Single-Item Procurement
          </button>
          <button
            type="button"
            onClick={() => {
              setProcurementMode("multi");
              // Rule 3: Switching procurement modes preserves extracted line items.
              // If multiItems is currently empty, but active aiDraft has lineItems, synchronize them.
              if (multiItems.length === 0 && aiDraft?.lineItems && aiDraft.lineItems.length > 0) {
                try {
                  const mapped = mapLineItemsFromDraft(aiDraft.lineItems, actorId);
                  if (mapped.length > 0) {
                    setMultiItems(mapped);
                  }
                } catch (syncErr: unknown) {
                  setAiError(
                    `[draft_sync_error] ${
                      syncErr instanceof Error
                        ? syncErr.message
                        : "Failed to synchronize extracted line items to procurement form."
                    }`
                  );
                }
              }
            }}
            className={`text-xs px-3 py-1.5 rounded font-medium transition-all duration-150 active:scale-[0.98] cursor-pointer ${
              procurementMode === "multi"
                ? "bg-[var(--accent)] text-white shadow-2xs"
                : "bg-[var(--surface-raised)] text-[var(--ink-muted)] border border-[var(--line)] hover:bg-[var(--surface-hover)] hover:text-[var(--ink)]"
            }`}
          >
            Multi-Item Cart Aggregation
          </button>
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="secondary"
            onClick={handleLoadDemoTemplate}
            disabled={loading || aiLoading}
            className="text-xs py-1 px-2.5 bg-[var(--surface-raised)] border border-[var(--line)] hover:bg-[var(--surface-hover)]"
            title="Populate synthetic demonstration data (does not initiate payment or create purchase)"
          >
            Load Demo Template
          </Button>
          {(budgetDollars || requirementsText || postalCode || multiItems.length > 0 || isDemoTemplateLoaded || aiDraft) && (
            <Button
              type="button"
              variant="secondary"
              onClick={handleClearForm}
              disabled={loading}
              className="text-xs py-1 px-2 text-[var(--ink-muted)] hover:text-[var(--ink)]"
              title="Clear all manual form fields"
            >
              Clear Form
            </Button>
          )}
        </div>
      </div>

      {isDemoTemplateLoaded && (
        <div className="mb-4">
          <Banner variant="info">
            <div className="flex flex-col gap-1 text-xs">
              <span className="font-semibold text-blue-900">
                [Synthetic Demo Template Loaded — Demonstration Purposes Only]
              </span>
              <span className="text-blue-800">
                This template contains pre-configured synthetic sample data. It does not initiate payment or create purchases automatically. Explicit buyer review and confirmation of all mandatory fields is required before submission.
              </span>
            </div>
          </Banner>
        </div>
      )}

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
                    onChange={(e) => {
                      setBudgetDollars(e.target.value);
                      setIsManuallyEdited(true);
                      setIsDemoTemplateLoaded(false);
                    }}
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
                      placeholder="Enter quantity"
                      value={quantity !== null && quantity !== undefined ? quantity : ""}
                      onChange={(e) => {
                        const val = e.target.value.trim();
                        const parsed = parseInt(val, 10);
                        const newQty = val !== "" && Number.isInteger(parsed) && parsed >= 1 ? parsed : null;
                        setQuantity(newQty);
                        setQuantitySource(newQty !== null ? "explicit" : "unresolved");
                        setQuantityConfirmed(newQty !== null);
                        setSingleConfirmationToken(undefined);
                        setIsManuallyEdited(true);
                        setIsDemoTemplateLoaded(false);
                      }}
                      error={Boolean(clientErrors.quantity)}
                      disabled={loading}
                      className={
                        quantity === null || (quantitySource === "inferred" && !quantityConfirmed)
                          ? "border-amber-400 bg-amber-50/40 text-amber-950 font-medium"
                          : ""
                      }
                      required
                    />
                    {quantity === null ? (
                      <span className="text-xs text-amber-800 bg-amber-100 border border-amber-300 rounded px-2.5 py-1 font-medium whitespace-nowrap">
                        ⚠️ Clarification: Specify Qty
                      </span>
                    ) : quantitySource === "inferred" && !quantityConfirmed ? (
                      <Button
                        type="button"
                        variant="secondary"
                        onClick={handleConfirmSingleQuantity}
                        disabled={loading}
                        className="text-xs py-1.5 px-3 bg-amber-100 text-amber-900 border border-amber-300 hover:bg-amber-200 whitespace-nowrap font-medium"
                      >
                        ⚠️ Confirm ({quantity})
                      </Button>
                    ) : quantityConfirmed ? (
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
                  onChange={(e) => {
                    setPostalCode(e.target.value);
                    setIsManuallyEdited(true);
                    setIsDemoTemplateLoaded(false);
                  }}
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
                onChange={(e) => {
                  setRequirementsText(e.target.value);
                  setIsManuallyEdited(true);
                  setIsDemoTemplateLoaded(false);
                }}
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
                  onChange={(e) => {
                    setPostalCode(e.target.value);
                    setIsManuallyEdited(true);
                    setIsDemoTemplateLoaded(false);
                  }}
                  error={Boolean(clientErrors.postalCode)}
                  disabled={loading}
                  className="font-mono"
                />
              </Field>

              <Field
                label="Aggregate Buyer Budget (USD)"
                htmlFor="multi-purchase-budget"
                hint="Total buyer budget across all requested items"
                error={clientErrors.budget}
              >
                <Input
                  id="multi-purchase-budget"
                  type="text"
                  placeholder="e.g. 5000.00"
                  value={budgetDollars}
                  onChange={(e) => {
                    setBudgetDollars(e.target.value);
                    setIsManuallyEdited(true);
                    setIsDemoTemplateLoaded(false);
                  }}
                  error={Boolean(clientErrors.budget)}
                  disabled={loading}
                  className="font-mono"
                />
              </Field>

              <div className="col-span-full p-3 bg-[var(--surface-raised)] border border-[var(--line)] rounded-md grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="flex flex-col">
                  <span className="text-[11px] font-medium text-[var(--ink-muted)]">Aggregate Buyer Budget:</span>
                  <span className="text-sm font-bold font-mono text-[var(--ink)]">
                    {!isNaN(parseFloat(budgetDollars)) && parseFloat(budgetDollars) > 0
                      ? `$${parseFloat(budgetDollars).toFixed(2)} USD`
                      : "Unspecified"}
                  </span>
                  <span className="text-[10px] text-[var(--ink-muted)]">Target expenditure limit</span>
                </div>
                <div className="flex flex-col">
                  <span className="text-[11px] font-medium text-[var(--ink-muted)]">Individual Item Budgets:</span>
                  <span className="text-sm font-semibold font-mono text-[var(--ink)]">
                    {multiItems.some((it) => !isNaN(parseFloat(it.budgetDollars)) && parseFloat(it.budgetDollars) > 0)
                      ? `$${(
                          multiItems.reduce(
                            (acc, item) => acc + Math.round((parseFloat(item.budgetDollars) || 0) * 100),
                            0
                          ) / 100
                        ).toFixed(2)} USD`
                      : "Unspecified"}
                  </span>
                  <span className="text-[10px] text-[var(--ink-muted)]">
                    {multiItems.some((it) => !isNaN(parseFloat(it.budgetDollars)) && parseFloat(it.budgetDollars) > 0)
                      ? `Sum of item-level ceilings (${multiItems.length} items)`
                      : "Item-specific ceilings not set"}
                  </span>
                </div>
                <div className="flex flex-col">
                  <span className="text-[11px] font-medium text-[var(--ink-muted)]">Estimated Procurement Cost:</span>
                  <span className="text-sm font-medium text-[var(--ink-muted)] italic">
                    Unknown until evaluation
                  </span>
                  <span className="text-[10px] text-[var(--ink-muted)]">Defensible landed cost via Multi-Item Studio</span>
                </div>
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
                  onClick={() => {
                    setIsManuallyEdited(true);
                    setIsDemoTemplateLoaded(false);
                    setMultiItems([
                      ...multiItems,
                      {
                        id: `line_${multiItems.length + 1}`,
                        title: "",
                        quantity: null,
                        quantitySource: "unresolved",
                        quantityConfirmed: false,
                        originalInferredQuantity: null,
                        confirmedAt: null,
                        confirmedBy: null,
                        budgetDollars: "",
                      },
                    ]);
                  }}
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
                {multiItems.length === 0 && (
                  <div className="p-4 bg-[var(--surface-raised)] border border-dashed border-[var(--line)] rounded-md text-center text-xs text-[var(--ink-muted)]">
                    No line items currently added. Click &ldquo;+ Add Line Item&rdquo; above or generate an AI draft to populate items.
                  </div>
                )}
                {multiItems.map((item, idx) => (
                  <div
                    key={item.id}
                    className="p-3 bg-[var(--surface-raised)] border border-[var(--line)] rounded-md flex flex-col sm:flex-row gap-3 items-start sm:items-center animate-fade-in-up duration-200 transition-all hover:border-[var(--control-border)] hover:bg-[var(--surface)]"
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
                          setIsManuallyEdited(true);
                          setIsDemoTemplateLoaded(false);
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
                    <div className="w-40 flex flex-col gap-1">
                      <Input
                        type="number"
                        min="1"
                        step="1"
                        placeholder="Qty"
                        value={item.quantity !== null && item.quantity !== undefined ? item.quantity : ""}
                        onChange={(e) => {
                          setIsManuallyEdited(true);
                          setIsDemoTemplateLoaded(false);
                          const val = e.target.value.trim();
                          const parsed = parseInt(val, 10);
                          const newQty = val !== "" && Number.isInteger(parsed) && parsed >= 1 ? parsed : null;
                          const updated = [...multiItems];
                          updated[idx] = {
                            ...item,
                            quantity: newQty,
                            quantitySource: newQty !== null ? "explicit" : "unresolved",
                            quantityConfirmed: newQty !== null,
                            confirmationToken: undefined,
                            confirmedAt: newQty !== null ? new Date().toISOString() : null,
                            confirmedBy: newQty !== null ? actorId : null,
                          };
                          setMultiItems(updated);
                        }}
                        disabled={loading}
                        className={`text-xs ${
                          item.quantity === null || (item.quantitySource === "inferred" && !item.quantityConfirmed)
                            ? "border-amber-400 bg-amber-50/40 text-amber-950 font-medium"
                            : ""
                        }`}
                      />
                      {item.quantity === null ? (
                        <span className="text-[10px] text-amber-800 bg-amber-100 border border-amber-300 rounded px-1.5 py-0.5 font-medium whitespace-nowrap animate-pulse-subtle">
                          ⚠️ Clarification: Specify Qty
                        </span>
                      ) : item.quantitySource === "inferred" && !item.quantityConfirmed ? (
                        <Button
                          type="button"
                          variant="secondary"
                          onClick={() => handleConfirmLineItemQuantity(idx)}
                          disabled={loading}
                          className="text-[10px] py-0.5 px-1 bg-amber-100 text-amber-900 border border-amber-300 hover:bg-amber-200 font-medium animate-pulse-subtle"
                        >
                          ⚠️ Confirm ({item.quantity})
                        </Button>
                      ) : item.quantityConfirmed ? (
                        <span className="text-[10px] text-emerald-700 font-medium flex items-center gap-1 whitespace-nowrap">
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
                          setIsManuallyEdited(true);
                          setIsDemoTemplateLoaded(false);
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
                          setIsManuallyEdited(true);
                          setIsDemoTemplateLoaded(false);
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
