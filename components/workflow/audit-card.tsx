"use client";

import * as React from "react";
import { Card } from "../ui/card";
import { Button } from "../ui/button";
import { Banner } from "../ui/banner";
import { StatusChip } from "../ui/status-chip";
import { getAuditHistoryApi } from "../../lib/workflow/client-api";
import { AuditEventEntry } from "../../lib/workflow/types";

export interface AuditCardProps {
  purchaseId: string;
  actorId: string;
}

export function AuditCard({ purchaseId, actorId }: AuditCardProps) {
  const [events, setEvents] = React.useState<AuditEventEntry[]>([]);
  const [loading, setLoading] = React.useState<boolean>(false);
  const [serverError, setServerError] = React.useState<string | null>(null);
  const [hasLoaded, setHasLoaded] = React.useState<boolean>(false);

  const [prevPurchaseId, setPrevPurchaseId] = React.useState<string>(purchaseId);

  // Immediately clear previous events during render if purchaseId changed
  if (purchaseId !== prevPurchaseId) {
    setPrevPurchaseId(purchaseId);
    setEvents([]);
    setServerError(null);
    setHasLoaded(false);
  }

  // Automatically fetch audit history when purchaseId or actorId changes.
  // Ignores stale async responses via cancellation flag.
  React.useEffect(() => {
    let cancelled = false;

    if (!purchaseId || purchaseId.trim().length === 0) {
      return;
    }

    void (async () => {
      await Promise.resolve();
      if (cancelled) return;

      setLoading(true);
      try {
        const result = await getAuditHistoryApi(purchaseId, { actorId });
        if (cancelled) return;

        if (!result.ok) {
          setServerError(`[${result.error.code}] ${result.error.message}`);
        } else {
          setEvents(result.data.events);
          setHasLoaded(true);
        }
      } catch (err) {
        if (cancelled) return;
        setServerError(err instanceof Error ? err.message : "Failed to load audit history.");
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [purchaseId, actorId]);

  const fetchAudit = async () => {
    if (!purchaseId) return;
    setServerError(null);
    setLoading(true);
    try {
      const result = await getAuditHistoryApi(purchaseId, { actorId });
      if (!result.ok) {
        setServerError(`[${result.error.code}] ${result.error.message}`);
      } else {
        setEvents(result.data.events);
        setHasLoaded(true);
      }
    } catch (err) {
      setServerError(err instanceof Error ? err.message : "Failed to load audit history.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card heading="5. Audit History & Event Timeline" className="mb-6">
      <p className="text-xs text-[var(--ink-muted)] mb-3">
        Chronological audit trail of structured events emitted during state machine transitions.
      </p>

      {/* Explicit Audit Limitation Banner from Phase 6.1 */}
      <div className="mb-4">
        <Banner variant="info">
          <strong>Audit Architecture Limitation Notice:</strong> As identified in the Phase 6.1 audit, standalone payment verification attempts (pending status, transient timeouts, or mismatches) update the payment attempt record and are not emitted as timeline audit events. Only pure state transitions (e.g. buyer_approved) append to the persistent audit log.
        </Banner>
      </div>

      {serverError && (
        <div className="mb-3">
          <Banner variant="error">{serverError}</Banner>
        </div>
      )}

      <div className="flex items-center justify-between mb-4">
        <Button
          id="refresh-audit-btn"
          variant="secondary"
          onClick={fetchAudit}
          loading={loading}
          disabled={loading}
          className="text-xs"
        >
          {loading ? "Loading..." : hasLoaded ? "Refresh Audit Events" : "Load Audit History"}
        </Button>
        {hasLoaded && (
          <span className="text-xs text-[var(--ink-muted)]">
            Total recorded events: {events.length}
          </span>
        )}
      </div>

      {events.length > 0 ? (
        <div className="space-y-3">
          {events.map((event, idx) => (
            <div
              key={event.id || idx}
              className="border border-[var(--line)] rounded-[var(--radius-control)] p-3 bg-[var(--surface-raised)] text-xs"
            >
              <div className="flex items-center justify-between mb-1.5">
                <div className="flex items-center gap-2">
                  <StatusChip variant="info" label={event.type} />
                  <span className="font-mono text-[11px] text-[var(--ink-muted)]">
                    {event.occurredAt}
                  </span>
                </div>
                <span className="text-[11px] text-[var(--ink-muted)]">
                  Actor: {typeof event.actor === "object" ? JSON.stringify(event.actor) : String(event.actor)}
                </span>
              </div>
              {Boolean(event.payload) && (
                <div className="mt-2 pt-1.5 border-t border-[var(--line)]">
                  <pre className="text-[11px] font-mono text-[var(--ink-muted)] whitespace-pre-wrap overflow-x-auto bg-[var(--surface)] p-2 rounded">
                    {JSON.stringify(event.payload, null, 2)}
                  </pre>
                </div>
              )}
            </div>
          ))}
        </div>
      ) : hasLoaded ? (
        <div className="text-xs text-[var(--ink-muted)] p-4 text-center border border-dashed border-[var(--line)] rounded-[var(--radius-control)]">
          No audit events recorded for this purchase yet.
        </div>
      ) : null}
    </Card>
  );
}
