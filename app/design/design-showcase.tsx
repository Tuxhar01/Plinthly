"use client";

import * as React from "react";
import { AppShell } from "@/components/ui/app-shell";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { StatusChip } from "@/components/ui/status-chip";
import { Skeleton } from "@/components/ui/skeleton";
import { Banner } from "@/components/ui/banner";
import { CheckCircle, AlertTriangle, AlertCircle, Info } from "lucide-react";

export function DesignShowcase() {
  const [theme, setTheme] = React.useState<"system" | "light" | "dark">("system");

  const applyTheme = (nextTheme: "system" | "light" | "dark") => {
    setTheme(nextTheme);
    const root = document.documentElement;
    if (nextTheme === "system") {
      root.removeAttribute("data-theme");
    } else {
      root.setAttribute("data-theme", nextTheme);
    }
  };

  return (
    <AppShell
      headerActions={
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            onClick={() => applyTheme(theme === "dark" ? "light" : "dark")}
          >
            Toggle Theme ({theme})
          </Button>
          <Button
            variant="secondary"
            onClick={() => applyTheme("system")}
          >
            Reset to System
          </Button>
        </div>
      }
    >
      <div className="space-y-10 py-6">
        <div>
          <h1 className="text-3xl font-semibold mb-2 font-[family-name:var(--font-display)] text-[var(--ink)]">
            Design Primitives Showcase
          </h1>
          <p className="text-sm text-[var(--ink-muted)]">
            Interactive development-only verification page for Phase 0 UI primitives and tokens.
          </p>
        </div>

        {/* Buttons */}
        <section className="space-y-4">
          <h2 className="text-xl font-semibold border-b border-[var(--line)] pb-2 font-[family-name:var(--font-display)] text-[var(--ink)]">
            Buttons
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <Card heading="Primary Variant">
              <div className="flex flex-col gap-3">
                <Button variant="primary">Default State</Button>
                <Button variant="primary" loading>Loading State</Button>
                <Button variant="primary" disabled>Disabled State</Button>
              </div>
            </Card>

            <Card heading="Secondary Variant">
              <div className="flex flex-col gap-3">
                <Button variant="secondary">Default State</Button>
                <Button variant="secondary" loading>Loading State</Button>
                <Button variant="secondary" disabled>Disabled State</Button>
              </div>
            </Card>

            <Card heading="Destructive Variant">
              <div className="flex flex-col gap-3">
                <Button variant="destructive">Default State</Button>
                <Button variant="destructive" loading>Loading State</Button>
                <Button variant="destructive" disabled>Disabled State</Button>
              </div>
            </Card>
          </div>
        </section>

        {/* Form Controls */}
        <section className="space-y-4">
          <h2 className="text-xl font-semibold border-b border-[var(--line)] pb-2 font-[family-name:var(--font-display)] text-[var(--ink)]">
            Field, Input, and Textarea
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <Card heading="Inputs">
              <div className="flex flex-col gap-4">
                <Field label="Standard Input" htmlFor="input-default" hint="This is a helpful hint for the input.">
                  <Input id="input-default" placeholder="Enter placeholder text..." />
                </Field>

                <Field label="Input with Error" htmlFor="input-error" error="This field is required.">
                  <Input id="input-error" defaultValue="Invalid input value" error />
                </Field>

                <Field label="Disabled Input" htmlFor="input-disabled" hint="This control is disabled.">
                  <Input id="input-disabled" defaultValue="Disabled text value" disabled />
                </Field>
              </div>
            </Card>

            <Card heading="Textareas">
              <div className="flex flex-col gap-4">
                <Field label="Standard Textarea" htmlFor="textarea-default" hint="Provide detailed notes here.">
                  <Textarea id="textarea-default" rows={3} placeholder="Enter description..." />
                </Field>

                <Field label="Textarea with Error" htmlFor="textarea-error" error="Description exceeds maximum character count.">
                  <Textarea id="textarea-error" rows={3} defaultValue="Some problematic content" error />
                </Field>

                <Field label="Disabled Textarea" htmlFor="textarea-disabled" hint="Cannot be edited.">
                  <Textarea id="textarea-disabled" rows={3} defaultValue="Read-only disabled content" disabled />
                </Field>
              </div>
            </Card>
          </div>
        </section>

        {/* Cards */}
        <section className="space-y-4">
          <h2 className="text-xl font-semibold border-b border-[var(--line)] pb-2 font-[family-name:var(--font-display)] text-[var(--ink)]">
            Cards
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <Card heading="Card with Heading">
              <p className="text-sm text-[var(--ink)]">
                A container primitive with 1px decorative line border, 10px radius, and 16px padding.
              </p>
            </Card>
            <Card>
              <p className="text-sm text-[var(--ink)]">
                Card without heading displaying arbitrary child elements with surface background.
              </p>
            </Card>
          </div>
        </section>

        {/* Status Chips */}
        <section className="space-y-4">
          <h2 className="text-xl font-semibold border-b border-[var(--line)] pb-2 font-[family-name:var(--font-display)] text-[var(--ink)]">
            Status Chips
          </h2>
          <Card>
            <div className="flex flex-wrap gap-4 items-center">
              <StatusChip variant="pass" label="Verified" icon={<CheckCircle className="w-3.5 h-3.5" />} />
              <StatusChip variant="caution" label="Pending Review" icon={<AlertTriangle className="w-3.5 h-3.5" />} />
              <StatusChip variant="block" label="Blocked" icon={<AlertCircle className="w-3.5 h-3.5" />} />
              <StatusChip variant="info" label="Informational" icon={<Info className="w-3.5 h-3.5" />} />
              <StatusChip variant="neutral" label="Draft" />
            </div>
          </Card>
        </section>

        {/* Skeletons */}
        <section className="space-y-4">
          <h2 className="text-xl font-semibold border-b border-[var(--line)] pb-2 font-[family-name:var(--font-display)] text-[var(--ink)]">
            Skeletons
          </h2>
          <Card heading="Skeleton Loading Pulse">
            <div className="space-y-3">
              <Skeleton className="h-6 w-3/4" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-5/6" />
              <div className="flex gap-3 pt-2">
                <Skeleton className="h-9 w-24" />
                <Skeleton className="h-9 w-24" />
              </div>
            </div>
          </Card>
        </section>

        {/* Banners */}
        <section className="space-y-4">
          <h2 className="text-xl font-semibold border-b border-[var(--line)] pb-2 font-[family-name:var(--font-display)] text-[var(--ink)]">
            Banners
          </h2>
          <div className="space-y-3">
            <Banner variant="error">
              <strong>Error Banner:</strong> An issue occurred requiring immediate user attention.
            </Banner>
            <Banner variant="success">
              <strong>Success Banner:</strong> The operation completed and verification passed.
            </Banner>
            <Banner variant="info">
              <strong>Info Banner:</strong> Additional contextual information for the user.
            </Banner>
          </div>
        </section>
      </div>
    </AppShell>
  );
}
