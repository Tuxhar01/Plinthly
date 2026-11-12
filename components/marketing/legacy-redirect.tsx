"use client";

import * as React from "react";
import { useSearchParams, useRouter } from "next/navigation";

export function LegacyRedirect() {
  const searchParams = useSearchParams();
  const router = useRouter();

  React.useEffect(() => {
    const purchaseId = searchParams.get("purchaseId");
    const aggregateId = searchParams.get("aggregateId");

    if (purchaseId || aggregateId) {
      const query = new URLSearchParams();
      if (purchaseId) query.set("purchaseId", purchaseId);
      if (aggregateId) query.set("aggregateId", aggregateId);
      router.replace(`/workspace?${query.toString()}`);
    }
  }, [searchParams, router]);

  return null;
}

