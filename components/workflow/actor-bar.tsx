"use client";

import * as React from "react";
import { StatusChip } from "../ui/status-chip";

export interface ActorBarProps {
  currentActorId: string;
  onActorChange: (actorId: string) => void;
}

export function ActorBar({ currentActorId, onActorChange }: ActorBarProps) {
  return (
    <div className="border border-[var(--line)] bg-[var(--surface-raised)] rounded-[var(--radius-card)] p-3 text-xs mb-6 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
      <div className="flex items-center gap-2 flex-wrap">
        <StatusChip variant="info" label="Local Demo Auth" />
        <span className="text-[var(--ink-muted)]">Active Caller Identity:</span>
        <select
          id="actor-select"
          aria-label="Active Caller Identity"
          value={currentActorId}
          onChange={(e) => onActorChange(e.target.value)}
          className="border border-[var(--control-border)] bg-[var(--surface)] text-[var(--ink)] rounded-[var(--radius-control)] px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-[var(--accent)]"
        >
          <option value="usr_buyer_1">usr_buyer_1 (Primary Buyer / Owner)</option>
          <option value="usr_buyer_2">usr_buyer_2 (Secondary Buyer)</option>
          <option value="usr_unauthorized">usr_unauthorized (Non-owner to test 403 Forbidden)</option>
        </select>
      </div>
      <p className="text-[11px] text-[var(--ink-muted)] leading-tight">
        Untrusted actor headers are rejected in deployment mode; active only when local demo auth is enabled.
      </p>
    </div>
  );
}
