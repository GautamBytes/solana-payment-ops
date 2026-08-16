import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { default as TryPage, metadata } from "../app/try/page";

afterEach(() => {
  vi.unstubAllEnvs();
});

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

  it("continues the PayOps marketing shell into the product workspace", () => {
    const markup = renderToStaticMarkup(createElement(TryPage));

    expect(markup).toContain('class="marketing try-experience"');
    expect(markup).toContain('class="marketing-header"');
    expect(markup).toContain("Verified Solana payments");
    expect(markup).toContain('href="#workspace"');
    expect(markup).toContain("Open workspace");
  });

  it("renders both self-serve modes when public analysis is enabled", () => {
    vi.stubEnv("PAYOPS_PUBLIC_WALLET_ANALYSIS_ENABLED", "true");
    vi.stubEnv("NEXT_PUBLIC_PAYOPS_API_ORIGIN", "https://api.payops.example");
    const markup = renderToStaticMarkup(createElement(TryPage));

    expect(markup).toContain("Explore sample workspace");
    expect(markup).toContain("Use a public wallet");
    expect(markup).toContain("Public blockchain data only");
    expect(markup).toContain("Compare against an expected payment");
    expect(markup).not.toMatch(/pilot|waitlist|connect wallet/i);
  });

  it("publishes indexable product metadata", () => {
    expect(metadata).toMatchObject({
      title: "Try PayOps | Explore verified Solana payments",
      robots: { index: true, follow: true },
    });
  });
});
