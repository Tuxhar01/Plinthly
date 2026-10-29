/**
 * Typed Agent Client for Plinthly API (APIMatic Contract Integration)
 *
 * Implements strict least-privilege enterprise procurement boundaries:
 * 1. AI agents can decompose requirements, search products, and evaluate policies.
 * 2. System actors are strictly blocked from self-approving purchases.
 * 3. Payment capture is permanently omitted (intent=AUTHORIZE only).
 */

export interface PlinthlyClientOptions {
  readonly baseUrl: string;
  readonly authToken?: string;
  readonly actorId?: string;
  readonly actorKind?: "user" | "system";
  readonly fetchFn?: typeof fetch;
}

export class PlinthlyApiClient {
  private readonly baseUrl: string;
  private readonly authToken?: string;
  private readonly actorId: string;
  private readonly actorKind: "user" | "system";
  private readonly fetchFn: typeof fetch;

  constructor(options: PlinthlyClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.authToken = options.authToken;
    this.actorId = options.actorId || "agent_procurement_bot";
    this.actorKind = options.actorKind || "system";
    this.fetchFn = options.fetchFn ?? (typeof fetch !== "undefined" ? fetch : (() => Promise.reject(new Error("fetch unavailable"))) as unknown as typeof fetch);
  }

  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "x-actor-id": this.actorId,
      "x-actor-kind": this.actorKind,
    };
    if (this.authToken) {
      headers["Authorization"] = `Bearer ${this.authToken}`;
    }
    return headers;
  }

  async checkHealth(): Promise<{ status: string; timestamp: string }> {
    const res = await this.fetchFn(`${this.baseUrl}/api/health`, {
      method: "GET",
      headers: this.getHeaders(),
    });
    if (!res.ok) {
      throw new Error(`Health check failed with status ${res.status}`);
    }
    return res.json();
  }

  async decompose(prompt: string): Promise<unknown> {
    const res = await this.fetchFn(`${this.baseUrl}/api/ai/decompose`, {
      method: "POST",
      headers: this.getHeaders(),
      body: JSON.stringify({ prompt }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`Decomposition failed: ${JSON.stringify(err)}`);
    }
    return res.json();
  }

  async searchProducts(query: string, purchaseId?: string): Promise<unknown> {
    const res = await this.fetchFn(`${this.baseUrl}/api/discovery/search`, {
      method: "POST",
      headers: this.getHeaders(),
      body: JSON.stringify({ query, purchaseId }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`Search failed: ${JSON.stringify(err)}`);
    }
    return res.json();
  }

  /**
   * Evaluates candidate against deterministic server-side policies.
   */
  async evaluate(purchaseId: string, candidateId: string, expectedVersion: number): Promise<unknown> {
    const res = await this.fetchFn(`${this.baseUrl}/api/purchases/${purchaseId}/evaluate`, {
      method: "POST",
      headers: this.getHeaders(),
      body: JSON.stringify({ candidateId, expectedVersion }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`Evaluation failed: ${JSON.stringify(err)}`);
    }
    return res.json();
  }

  /**
   * Enforces least privilege: Autonomous system agents CANNOT call approve.
   */
  async approve(purchaseId: string, candidateId: string, expectedVersion: number): Promise<unknown> {
    if (this.actorKind === "system") {
      throw new Error(
        "Security Invariant Violation: System actors cannot approve purchases; human buyer approval is strictly required."
      );
    }
    const res = await this.fetchFn(`${this.baseUrl}/api/purchases/${purchaseId}/approve`, {
      method: "POST",
      headers: this.getHeaders(),
      body: JSON.stringify({ candidateId, expectedVersion }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`Approval failed: ${JSON.stringify(err)}`);
    }
    return res.json();
  }
}
