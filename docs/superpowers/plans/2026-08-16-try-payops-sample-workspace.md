# Try PayOps Sample Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the pilot application with an always-available `/try` sample workspace that demonstrates matched payments, exceptions, and evidence without signup or backend dependencies.

**Architecture:** Add a typed, deterministic sample model under `apps/web/lib/try/`, render it through a dedicated read-only client component and `/try` route, then point every merchant-facing CTA at that route. Keep `/operations` unchanged; the sample workspace borrows its product vocabulary but owns separate components and CSS so no authenticated mutation can leak into the demo.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript 7, Vitest 4, Playwright 1.62, Phosphor Icons, existing PayOps CSS tokens.

## Global Constraints

- Node.js must remain `>=22.18.0`; pnpm must remain `11.15.0`.
- The sample route must require no account, invitation, database, worker, API, or RPC.
- Sample data must be deterministic, realistic, synthetic, and visibly labeled at all times.
- Do not import or render `OperationsDashboard`; `/operations` authorization and mutations remain unchanged.
- Public merchant CTAs must use `Try PayOps`, `Explore sample workspace`, and `See PayOps in action`; no public CTA may use pilot, beta, application, invitation, or request-access language.
- Do not display a public-wallet action until the separate public-wallet plan is deployed and healthy.
- Use the existing Archivo, IBM Plex Mono, PayOps emerald, and operations visual language; add no dependency.
- All interactive controls must be keyboard accessible, retain visible focus, avoid color-only status, reflow without horizontal page overflow, and respect `prefers-reduced-motion`.

---

## File Structure

- Create `apps/web/lib/try/types.ts`: public read-only view-model contracts.
- Create `apps/web/lib/try/sample-workspace.ts`: one immutable deterministic sample model derived from named v0.1 fixture cases.
- Create `apps/web/components/try-workspace.tsx`: client-side guide, selection, details, and sample disclosure.
- Create `apps/web/app/try/page.tsx`: route metadata and server entry.
- Create `apps/web/styles/try.css`: styles scoped under `.try-shell`.
- Create `apps/web/test/try-sample.test.ts`: model invariants.
- Create `apps/web/test/try-workspace.test.tsx`: rendering and interaction-facing markup contracts.
- Create `apps/web/test/e2e/try.spec.ts`: desktop/mobile and accessibility path.
- Modify `apps/web/app/layout.tsx`: import `try.css`.
- Modify `apps/web/components/marketing-destinations.ts`: replace `pilotUrl` with `tryUrl`.
- Modify `apps/web/components/marketing-header.tsx`, `apps/web/components/marketing-page.tsx`, and `apps/web/components/docs-shell.tsx`: approved CTA copy and destinations.
- Modify `apps/web/styles/marketing.css`: rename `.pilot` selectors to `.try-cta` without visual regression.
- Modify `apps/web/test/marketing.test.tsx` and `apps/web/test/docs.test.tsx`: enforce self-serve copy and route.
- Modify `README.md`: advertise the sample workspace while preserving the open-core pilot package description.

---

### Task 1: Deterministic sample workspace model

**Files:**

- Create: `apps/web/lib/try/types.ts`
- Create: `apps/web/lib/try/sample-workspace.ts`
- Create: `apps/web/test/try-sample.test.ts`

**Interfaces:**

- Produces: `TryWorkspace`, `TryPaymentDecision`, `TryEvidenceStep`, and `sampleWorkspace`.
- Consumers: `TryWorkspaceView` in Task 2.

- [ ] **Step 1: Write the failing model test**

Create `apps/web/test/try-sample.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { sampleWorkspace } from "../lib/try/sample-workspace";

describe("Try PayOps sample workspace", () => {
  it("is deterministic, synthetic, and covers matched plus exception decisions", () => {
    expect(sampleWorkspace.kind).toBe("sample");
    expect(sampleWorkspace.disclosure).toContain("synthetic");
    expect(sampleWorkspace.decisions.map(({ state }) => state)).toEqual([
      "matched",
      "exception",
      "exception",
    ]);
    expect(sampleWorkspace.summary).toEqual({
      invoices: 3,
      matchedPayments: 1,
      exceptions: 2,
      finalizedVolume: "37.499999 USDC",
    });
    expect(
      sampleWorkspace.decisions.every(
        ({ signature, evidence }) =>
          /^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(signature) &&
          evidence.map(({ stage }) => stage).join(",") ===
            "detect,verify,match,prove",
      ),
    ).toBe(true);
  });

  it("links each scenario to a bundled v0.1 fixture and exposes no mutation", () => {
    expect(
      sampleWorkspace.decisions.map(({ sourceFixture }) => sourceFixture),
    ).toEqual([
      "fixtures/v0.1/usdc-transfer-checked-finalized.json",
      "fixtures/v0.1/cases/wrong-destination-token-account.json",
      "fixtures/v0.1/cases/partial-base-unit-amount.json",
    ]);
    expect(JSON.stringify(sampleWorkspace)).not.toMatch(
      /assign|resolve|promote|private.?key|seed.?phrase/i,
    );
  });
});
```

- [ ] **Step 2: Run the test and verify the red state**

Run:

```bash
pnpm --filter @payops/web test -- test/try-sample.test.ts
```

Expected: FAIL because `../lib/try/sample-workspace` does not exist.

- [ ] **Step 3: Define the read-only model contracts**

Create `apps/web/lib/try/types.ts`:

```ts
export type TryDecisionState = "matched" | "exception";
export type TryEvidenceStage = "detect" | "verify" | "match" | "prove";

export interface TryEvidenceStep {
  readonly stage: TryEvidenceStage;
  readonly label: string;
  readonly outcome: "passed" | "failed" | "recorded";
  readonly detail: string;
}

export interface TryPaymentDecision {
  readonly id: string;
  readonly invoiceReference: string;
  readonly state: TryDecisionState;
  readonly exceptionLabel: string | null;
  readonly assetSymbol: "USDC" | "USDT";
  readonly amountTokens: string;
  readonly amountBaseUnits: string;
  readonly signature: string;
  readonly slot: number;
  readonly finalizedAt: string;
  readonly recipient: string;
  readonly reference: string;
  readonly sourceFixture: string;
  readonly evidence: readonly TryEvidenceStep[];
}

export interface TryWorkspace {
  readonly kind: "sample";
  readonly disclosure: string;
  readonly summary: {
    readonly invoices: number;
    readonly matchedPayments: number;
    readonly exceptions: number;
    readonly finalizedVolume: string;
  };
  readonly decisions: readonly TryPaymentDecision[];
}
```

- [ ] **Step 4: Implement the immutable sample model**

Create `apps/web/lib/try/sample-workspace.ts` with three literal decisions. Use these exact fixture identities and facts:

```ts
import type { TryPaymentDecision, TryWorkspace } from "./types";

const recipient = "Cmn8RVNLZAtyq51B31RXDrrS24DYphEftzDCX4FzPLM";
const reference = "Gh5GixNvrU87vKWcLLLp6dcgBGRDtP4EJesFu6rjif4";

const decisions: readonly TryPaymentDecision[] = [
  {
    id: "sample-matched",
    invoiceReference: "INV-0421",
    state: "matched",
    exceptionLabel: null,
    assetSymbol: "USDC",
    amountTokens: "12.500000",
    amountBaseUnits: "12500000",
    signature:
      "2Ana1pUpv2ZbMVkwF5FXapYeBEjdxDatLn7nvJkhgTSXbs59SyZSx866bXirPgj8QQVB57uxHJBG1YFvkRbFj4T",
    slot: 345678901,
    finalizedAt: "2026-08-06T07:06:40.000Z",
    recipient,
    reference,
    sourceFixture: "fixtures/v0.1/usdc-transfer-checked-finalized.json",
    evidence: [
      {
        stage: "detect",
        label: "Finalized transfer observed",
        outcome: "passed",
        detail: "Slot 345678901",
      },
      {
        stage: "verify",
        label: "Token, recipient, and amount verified",
        outcome: "passed",
        detail: "12.500000 USDC",
      },
      {
        stage: "match",
        label: "Reference matched INV-0421",
        outcome: "passed",
        detail: reference,
      },
      {
        stage: "prove",
        label: "Replayable evidence preserved",
        outcome: "recorded",
        detail: "15 deterministic checks",
      },
    ],
  },
  {
    id: "sample-wrong-destination",
    invoiceReference: "INV-0422",
    state: "exception",
    exceptionLabel: "Wrong destination",
    assetSymbol: "USDC",
    amountTokens: "12.500000",
    amountBaseUnits: "12500000",
    signature:
      "66ha5owWorvkzWaEf4g85Q6E6LEGmppeqQ4RpyDUDmQWr41eyexZwLzcu1Pfq4DhV4EFsv2pLcFXgJrvyxMvBU6q",
    slot: 345678915,
    finalizedAt: "2026-08-06T07:06:55.000Z",
    recipient,
    reference,
    sourceFixture: "fixtures/v0.1/cases/wrong-destination-token-account.json",
    evidence: [
      {
        stage: "detect",
        label: "Finalized transfer observed",
        outcome: "passed",
        detail: "Slot 345678915",
      },
      {
        stage: "verify",
        label: "Destination check failed",
        outcome: "failed",
        detail: "Transfer recipient differs from the invoice",
      },
      {
        stage: "match",
        label: "Invoice left unpaid",
        outcome: "failed",
        detail: "Exception: wrong destination",
      },
      {
        stage: "prove",
        label: "Failure evidence preserved",
        outcome: "recorded",
        detail: "No payment state guessed",
      },
    ],
  },
  {
    id: "sample-partial-amount",
    invoiceReference: "INV-0423",
    state: "exception",
    exceptionLabel: "Amount mismatch",
    assetSymbol: "USDC",
    amountTokens: "12.499999",
    amountBaseUnits: "12499999",
    signature:
      "fRTLbAQ2w1bisJQNUfEavKowvnYSoFxUawyXbBtw7cUDm8bniw9D7tmJCQyNV21CPgqxavGLMzC1Ry5xzKAbbD1",
    slot: 345678917,
    finalizedAt: "2026-08-06T07:06:57.000Z",
    recipient,
    reference,
    sourceFixture: "fixtures/v0.1/cases/partial-base-unit-amount.json",
    evidence: [
      {
        stage: "detect",
        label: "Finalized transfer observed",
        outcome: "passed",
        detail: "Slot 345678917",
      },
      {
        stage: "verify",
        label: "Exact amount check failed",
        outcome: "failed",
        detail: "Expected 12.500000; observed 12.499999",
      },
      {
        stage: "match",
        label: "Invoice left unpaid",
        outcome: "failed",
        detail: "Exception: amount mismatch",
      },
      {
        stage: "prove",
        label: "Failure evidence preserved",
        outcome: "recorded",
        detail: "One base unit difference retained",
      },
    ],
  },
] as const;

export const sampleWorkspace: TryWorkspace = Object.freeze({
  kind: "sample",
  disclosure:
    "Realistic synthetic data — no account, wallet, or funds are involved.",
  summary: {
    invoices: 3,
    matchedPayments: 1,
    exceptions: 2,
    finalizedVolume: "37.499999 USDC",
  },
  decisions,
});
```

- [ ] **Step 5: Run the focused tests and typecheck**

Run:

```bash
pnpm --filter @payops/web test -- test/try-sample.test.ts
pnpm --filter @payops/web typecheck
```

Expected: both commands exit 0.

- [ ] **Step 6: Commit the model**

```bash
git add apps/web/lib/try/types.ts apps/web/lib/try/sample-workspace.ts apps/web/test/try-sample.test.ts
git commit -m "feat(web): add deterministic PayOps sample model"
```

---

### Task 2: Read-only `/try` workspace

**Files:**

- Create: `apps/web/components/try-workspace.tsx`
- Create: `apps/web/app/try/page.tsx`
- Create: `apps/web/styles/try.css`
- Create: `apps/web/test/try-workspace.test.tsx`
- Modify: `apps/web/app/layout.tsx`

**Interfaces:**

- Consumes: `TryWorkspace` and `sampleWorkspace` from Task 1.
- Produces: `TryWorkspaceView({ workspace }: { readonly workspace: TryWorkspace })` and the public `/try` route.

- [ ] **Step 1: Write the failing rendering test**

Create `apps/web/test/try-workspace.test.tsx`:

```tsx
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { default as TryPage, metadata } from "../app/try/page";

describe("Try PayOps route", () => {
  it("renders a labeled, populated, read-only sample workspace", () => {
    const markup = renderToStaticMarkup(createElement(TryPage));
    expect(markup).toContain("Try PayOps");
    expect(markup).toContain("Sample data");
    expect(markup).toContain("Realistic synthetic data");
    expect(markup).toContain("INV-0421");
    expect(markup).toContain("Matched");
    expect(markup).toContain("Wrong destination");
    expect(markup).toContain("Amount mismatch");
    expect(markup).toContain("Detect");
    expect(markup).toContain("Verify");
    expect(markup).toContain("Match");
    expect(markup).toContain("Prove");
    expect(markup).not.toMatch(/assign case|resolve|promote to live/i);
  });

  it("publishes indexable product metadata", () => {
    expect(metadata).toMatchObject({
      title: "Try PayOps — Explore verified Solana payments",
      robots: { index: true, follow: true },
    });
  });
});
```

- [ ] **Step 2: Run the test and verify the red state**

```bash
pnpm --filter @payops/web test -- test/try-workspace.test.tsx
```

Expected: FAIL because `app/try/page.tsx` does not exist.

- [ ] **Step 3: Implement the client workspace**

Create `apps/web/components/try-workspace.tsx` as a client component. It must:

```tsx
"use client";

import {
  CheckCircle,
  Flask,
  ShieldCheck,
  Warning,
} from "@phosphor-icons/react";
import { useState } from "react";
import type { TryPaymentDecision, TryWorkspace } from "../lib/try/types";

export function TryWorkspaceView({
  workspace,
}: {
  readonly workspace: TryWorkspace;
}) {
  const [selectedId, setSelectedId] = useState(workspace.decisions[0]!.id);
  const [guideVisible, setGuideVisible] = useState(true);
  const selected = workspace.decisions.find(({ id }) => id === selectedId)!;

  return (
    <main className="try-shell" id="try-main">
      <header className="try-header">
        <a className="try-brand" href="/">
          PayOps
        </a>
        <div className="try-sample-disclosure" role="note">
          <Flask size={18} aria-hidden="true" />
          <strong>Sample data</strong>
          <span>{workspace.disclosure}</span>
        </div>
      </header>
      <section className="try-intro" aria-labelledby="try-title">
        <p>Interactive product tour</p>
        <h1 id="try-title">Try PayOps</h1>
        <p>
          Inspect how finalized Solana payments become matched decisions,
          explicit exceptions, and replayable evidence.
        </p>
      </section>
      {guideVisible ? (
        <aside className="try-guide" aria-label="Three things to explore">
          <strong>Three things to explore</strong>
          <ol>
            <li>Open the matched invoice.</li>
            <li>Review an exception.</li>
            <li>Inspect Detect → Verify → Match → Prove.</li>
          </ol>
          <button type="button" onClick={() => setGuideVisible(false)}>
            Dismiss guide
          </button>
        </aside>
      ) : null}
      <section className="try-summary" aria-label="Sample workspace summary">
        <Summary label="Invoices" value={String(workspace.summary.invoices)} />
        <Summary
          label="Matched"
          value={String(workspace.summary.matchedPayments)}
        />
        <Summary
          label="Exceptions"
          value={String(workspace.summary.exceptions)}
        />
        <Summary
          label="Finalized volume"
          value={workspace.summary.finalizedVolume}
        />
      </section>
      <div className="try-grid">
        <section className="try-decisions" aria-labelledby="decisions-title">
          <h2 id="decisions-title">Payment decisions</h2>
          <ul>
            {workspace.decisions.map((decision) => (
              <li key={decision.id}>
                <button
                  type="button"
                  aria-pressed={decision.id === selected.id}
                  onClick={() => setSelectedId(decision.id)}
                >
                  <DecisionLabel decision={decision} />
                </button>
              </li>
            ))}
          </ul>
        </section>
        <DecisionDetail decision={selected} />
      </div>
    </main>
  );
}

function Summary({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string;
}) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function DecisionLabel({
  decision,
}: {
  readonly decision: TryPaymentDecision;
}) {
  const matched = decision.state === "matched";
  return (
    <>
      <span>{decision.invoiceReference}</span>
      <strong>
        {decision.amountTokens} {decision.assetSymbol}
      </strong>
      <em>
        {matched ? (
          <CheckCircle aria-hidden="true" />
        ) : (
          <Warning aria-hidden="true" />
        )}
        {matched ? "Matched" : decision.exceptionLabel}
      </em>
    </>
  );
}

function DecisionDetail({
  decision,
}: {
  readonly decision: TryPaymentDecision;
}) {
  return (
    <section
      className="try-detail"
      aria-live="polite"
      aria-labelledby="decision-title"
    >
      <p>{decision.state === "matched" ? "Payment matched" : "Needs review"}</p>
      <h2 id="decision-title">{decision.invoiceReference}</h2>
      <dl>
        <div>
          <dt>Signature</dt>
          <dd>{decision.signature}</dd>
        </div>
        <div>
          <dt>Recipient</dt>
          <dd>{decision.recipient}</dd>
        </div>
        <div>
          <dt>Reference</dt>
          <dd>{decision.reference}</dd>
        </div>
      </dl>
      <ol className="try-evidence">
        {decision.evidence.map((step) => (
          <li key={step.stage} data-outcome={step.outcome}>
            <ShieldCheck aria-hidden="true" />
            <span>{step.stage}</span>
            <strong>{step.label}</strong>
            <p>{step.detail}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}
```

Keep every action read-only. Do not add a wallet button in this task.

- [ ] **Step 4: Add the route and stylesheet import**

Create `apps/web/app/try/page.tsx`:

```tsx
import type { Metadata } from "next";
import { TryWorkspaceView } from "../../components/try-workspace";
import { sampleWorkspace } from "../../lib/try/sample-workspace";

export const metadata: Metadata = {
  title: "Try PayOps — Explore verified Solana payments",
  description:
    "Explore realistic sample invoices, verified payments, exceptions, and evidence without creating an account.",
  robots: { index: true, follow: true },
};

export default function TryPage() {
  return <TryWorkspaceView workspace={sampleWorkspace} />;
}
```

Add this import after `operations.css` in `apps/web/app/layout.tsx`:

```ts
import "../styles/try.css";
```

- [ ] **Step 5: Implement the scoped responsive styles**

Create `apps/web/styles/try.css`. Scope every selector under `.try-shell`. Use:

```css
.try-shell {
  min-height: 100vh;
  padding: clamp(1rem, 3vw, 3rem);
  color: #10233f;
  background: #edf1f4;
}
.try-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
}
.try-brand {
  color: #10233f;
  font: 650 1.25rem var(--display);
  text-decoration: none;
}
.try-sample-disclosure {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  max-width: 48rem;
  padding: 0.75rem 1rem;
  color: #0c6255;
  background: #e8f5f1;
  border: 1px solid #9bcfc4;
}
.try-intro {
  max-width: 52rem;
  margin: clamp(3rem, 8vw, 7rem) auto 2rem;
  text-align: center;
}
.try-intro h1 {
  margin: 0;
  font: 610 clamp(3rem, 8vw, 6.5rem)/0.95 var(--display);
  letter-spacing: -0.05em;
}
.try-guide,
.try-summary,
.try-decisions,
.try-detail {
  background: #fff;
  border: 1px solid #cbd4de;
  box-shadow: 0 12px 40px rgb(16 35 63 / 0.05);
}
.try-guide {
  max-width: 72rem;
  margin: 0 auto 1.5rem;
  padding: 1rem 1.25rem;
}
.try-guide ol {
  display: flex;
  flex-wrap: wrap;
  gap: 1.5rem;
  padding-left: 1.25rem;
}
.try-summary {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  max-width: 72rem;
  margin: 0 auto 1.5rem;
}
.try-summary div {
  display: grid;
  gap: 0.35rem;
  padding: 1.25rem;
  border-right: 1px solid #dbe2e9;
}
.try-grid {
  display: grid;
  grid-template-columns: minmax(18rem, 0.8fr) minmax(0, 1.7fr);
  gap: 1.5rem;
  max-width: 72rem;
  margin: 0 auto;
}
.try-decisions,
.try-detail {
  padding: 1.25rem;
}
.try-decisions ul,
.try-evidence {
  margin: 0;
  padding: 0;
  list-style: none;
}
.try-decisions button {
  width: 100%;
  padding: 1rem;
  color: inherit;
  background: transparent;
  border: 0;
  border-top: 1px solid #dbe2e9;
  text-align: left;
}
.try-decisions button[aria-pressed="true"] {
  background: #e8f5f1;
  box-shadow: inset 3px 0 #0c8f78;
}
.try-evidence {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  margin-top: 1.5rem;
}
.try-evidence li {
  min-width: 0;
  padding: 1rem;
  border: 1px solid #dbe2e9;
}
.try-shell :where(a, button):focus-visible {
  outline: 3px solid #0c8f78;
  outline-offset: 3px;
}
@media (max-width: 760px) {
  .try-header,
  .try-sample-disclosure {
    align-items: flex-start;
  }
  .try-sample-disclosure {
    display: grid;
  }
  .try-summary {
    grid-template-columns: repeat(2, 1fr);
  }
  .try-grid {
    grid-template-columns: 1fr;
  }
  .try-evidence {
    grid-template-columns: 1fr;
  }
}
@media (prefers-reduced-motion: reduce) {
  .try-shell *,
  .try-shell *::before,
  .try-shell *::after {
    scroll-behavior: auto !important;
    transition-duration: 0.01ms !important;
    animation-duration: 0.01ms !important;
  }
}
```

If the component markup introduces any additional selectors, add each selector to
`try.css` under `.try-shell`; do not style global `button`, `a`, or `main`
elements. Keep every responsive change inside the existing 760px media query.

- [ ] **Step 6: Run component tests, typecheck, and formatting**

```bash
pnpm --filter @payops/web test -- test/try-sample.test.ts test/try-workspace.test.tsx
pnpm --filter @payops/web typecheck
pnpm exec prettier --check apps/web/app/try/page.tsx apps/web/components/try-workspace.tsx apps/web/lib/try apps/web/styles/try.css apps/web/test/try-sample.test.ts apps/web/test/try-workspace.test.tsx
```

Expected: all commands exit 0.

- [ ] **Step 7: Commit the route**

```bash
git add apps/web/app/layout.tsx apps/web/app/try/page.tsx apps/web/components/try-workspace.tsx apps/web/lib/try apps/web/styles/try.css apps/web/test/try-sample.test.ts apps/web/test/try-workspace.test.tsx
git commit -m "feat(web): add self-serve PayOps sample workspace"
```

---

### Task 3: Replace public pilot CTAs

**Files:**

- Modify: `apps/web/components/marketing-destinations.ts`
- Modify: `apps/web/components/marketing-header.tsx`
- Modify: `apps/web/components/marketing-page.tsx`
- Modify: `apps/web/components/docs-shell.tsx`
- Modify: `apps/web/styles/marketing.css`
- Modify: `apps/web/test/marketing.test.tsx`
- Modify: `apps/web/test/docs.test.tsx`

**Interfaces:**

- Consumes: the `/try` route from Task 2.
- Produces: `marketingDestinations.tryUrl` with every merchant CTA pointing to it.

- [ ] **Step 1: Write failing CTA assertions**

Add to `apps/web/test/marketing.test.tsx`:

```ts
it("offers self-serve product access without a pilot application", async () => {
  const { default: HomePage } = await import("../app/page");
  const markup = renderToStaticMarkup(createElement(HomePage));
  expect(markup).toContain('href="/try"');
  expect(markup).toContain("Try PayOps");
  expect(markup).toContain("Explore sample workspace");
  expect(markup).toContain("See PayOps in action");
  expect(markup).not.toMatch(
    /start a pilot|read-only pilot|PayOps%20read-only%20pilot/i,
  );
});
```

Add to `apps/web/test/docs.test.tsx` inside the overview test:

```ts
expect(markup).toContain('href="/try"');
expect(markup).toContain("Try PayOps");
expect(markup).not.toContain("Start a pilot");
```

- [ ] **Step 2: Run tests and verify the red state**

```bash
pnpm --filter @payops/web test -- test/marketing.test.tsx test/docs.test.tsx
```

Expected: FAIL because current CTAs still use `pilotUrl` and pilot copy.

- [ ] **Step 3: Replace the destination contract**

Change `apps/web/components/marketing-destinations.ts` to export:

```ts
const githubUrl = "https://github.com/GautamBytes/solana-payment-ops";

export const marketingDestinations = {
  docsUrl: "/docs",
  integrationUrl: "/docs/integration",
  packagesUrl: "/docs/packages",
  securityUrl: "/docs/security",
  apiUrl: "/docs/api",
  tryUrl: "/try",
  githubUrl,
  talkUrl:
    `${githubUrl}/issues/new?title=Question%20about%20PayOps&body=` +
    "What%20would%20you%20like%20to%20know%20about%20PayOps%3F",
} as const;
```

- [ ] **Step 4: Apply the approved copy everywhere**

Make these exact replacements:

```text
marketing-header.tsx desktop and mobile:
  href={marketingDestinations.tryUrl}
  label: Try PayOps

marketing-page.tsx merchant card:
  href={marketingDestinations.tryUrl}
  label: Explore sample workspace

marketing-page.tsx final section:
  className/id/aria id: try-cta / try / try-title
  eyebrow: No application. No setup.
  heading: See PayOps in action.
  body: Explore realistic sample payments, exceptions, and evidence without creating an account.
  primary href: marketingDestinations.tryUrl
  primary label: See PayOps in action
  secondary: Ask a question (unchanged destination)

docs-shell.tsx:
  href={marketingDestinations.tryUrl}
  label: Try PayOps
```

Rename only the marketing section selectors in `apps/web/styles/marketing.css`:

```text
.pilot → .try-cta
.pilot-actions → .try-cta-actions
```

Do not alter layout values while renaming.

- [ ] **Step 5: Run focused regression tests**

```bash
pnpm --filter @payops/web test -- test/marketing.test.tsx test/docs.test.tsx test/try-workspace.test.tsx
pnpm --filter @payops/web typecheck
pnpm exec prettier --check apps/web/components/marketing-destinations.ts apps/web/components/marketing-header.tsx apps/web/components/marketing-page.tsx apps/web/components/docs-shell.tsx apps/web/styles/marketing.css apps/web/test/marketing.test.tsx apps/web/test/docs.test.tsx
```

Expected: all commands exit 0.

- [ ] **Step 6: Commit the CTA migration**

```bash
git add apps/web/components/marketing-destinations.ts apps/web/components/marketing-header.tsx apps/web/components/marketing-page.tsx apps/web/components/docs-shell.tsx apps/web/styles/marketing.css apps/web/test/marketing.test.tsx apps/web/test/docs.test.tsx
git commit -m "feat(web): replace pilot CTAs with self-serve access"
```

---

### Task 4: End-to-end, accessibility, and public documentation verification

**Files:**

- Create: `apps/web/test/e2e/try.spec.ts`
- Modify: `README.md`

**Interfaces:**

- Consumes: public `/try` route and CTA changes from Tasks 2–3.
- Produces: browser-level acceptance coverage and accurate project entry documentation.

- [ ] **Step 1: Write the failing browser journey**

Create `apps/web/test/e2e/try.spec.ts`:

```ts
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test("opens a useful sample workspace from the homepage without contact", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Try PayOps" }).first().click();
  await expect(page).toHaveURL(/\/try$/);
  await expect(page.getByRole("heading", { name: "Try PayOps" })).toBeVisible();
  await expect(page.getByText("Sample data")).toBeVisible();
  await page.getByRole("button", { name: /INV-0422/ }).click();
  await expect(page.getByText("Wrong destination")).toBeVisible();
  await expect(page.getByText("Invoice left unpaid")).toBeVisible();
});

test("keeps the sample disclosure after dismissing the guide", async ({
  page,
}) => {
  await page.goto("/try");
  await page.getByRole("button", { name: "Dismiss guide" }).click();
  await expect(page.getByRole("note")).toContainText(
    "Realistic synthetic data",
  );
  await expect(page.getByText("Three things to explore")).toHaveCount(0);
});

test("has no serious accessibility violations or horizontal overflow", async ({
  page,
}) => {
  await page.goto("/try");
  const results = await new AxeBuilder({ page }).analyze();
  expect(
    results.violations.filter(
      ({ impact }) => impact === "serious" || impact === "critical",
    ),
  ).toEqual([]);
  const overflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth >
      document.documentElement.clientWidth + 1,
  );
  expect(overflow).toBe(false);
});
```

- [ ] **Step 2: Run the browser test**

```bash
pnpm exec playwright test apps/web/test/e2e/try.spec.ts --project=desktop --project=mobile
```

Expected before any selector corrections: at least one assertion fails if the accessible name or mobile layout does not match. Fix the implementation, not the test intent, then rerun until both projects pass.

- [ ] **Step 3: Update README product entry without erasing the open-core pilot package**

After the introductory paragraphs in `README.md`, add:

```md
## Try PayOps

The product website includes a self-serve `/try` workspace with realistic,
synthetic invoices, payment decisions, exceptions, and evidence. It requires no
account, wallet connection, or pilot application. The published open-core
packages and self-hosted production stack remain separate deployment choices.
```

Keep the `@payops/pilot` package table row and shadow-audit runbook because they
describe a real open-core package, not the website conversion path.

- [ ] **Step 4: Run the complete web and repository checks**

```bash
pnpm --filter @payops/web test
pnpm --filter @payops/web typecheck
pnpm exec playwright test apps/web/test/e2e/try.spec.ts --project=desktop --project=mobile
pnpm format:check
pnpm check
```

Expected: all commands exit 0; Vitest and Playwright report zero failing tests.

- [ ] **Step 5: Inspect the production build output**

```bash
pnpm --filter @payops/web build
```

Expected: exit 0 and the Next.js route summary includes `/try`.

- [ ] **Step 6: Commit the acceptance coverage and docs**

```bash
git add apps/web/test/e2e/try.spec.ts README.md
git commit -m "test(web): verify self-serve PayOps sample journey"
```

---

## Plan Acceptance Gate

Before starting the public-wallet plan, verify all of the following from a clean checkout:

```bash
rg -n -i "start a pilot|read-only pilot|PayOps%20read-only%20pilot" apps/web
pnpm --filter @payops/web test
pnpm --filter @payops/web typecheck
pnpm exec playwright test apps/web/test/e2e/try.spec.ts --project=desktop --project=mobile
pnpm --filter @payops/web build
git status --short
```

Expected:

- `rg` prints no matches.
- Every command exits 0.
- `/try` is present in the build output.
- `git status --short` is empty.
