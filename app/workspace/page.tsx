import { Metadata } from "next";
import { PurchaseDashboard } from "@/components/workflow/purchase-dashboard";

export const metadata: Metadata = {
  title: "Workspace | Plinthly — Every purchase. Proven.",
  description:
    "Enterprise purchase assurance workspace. AI intent decomposition, deterministic policy verification, and multi-cart PayPal execution.",
};

export default function WorkspacePage() {
  return <PurchaseDashboard />;
}

