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

  it("continues the PayOps marketing shell into the product workspace", () => {
    const markup = renderToStaticMarkup(createElement(TryPage));

    expect(markup).toContain('class="marketing try-experience"');
    expect(markup).toContain('class="marketing-header"');
    expect(markup).toContain("Verified Solana payments");
    expect(markup).toContain('href="#workspace"');
    expect(markup).toContain("Open workspace");
  });

  it("publishes indexable product metadata", () => {
    expect(metadata).toMatchObject({
      title: "Try PayOps | Explore verified Solana payments",
      robots: { index: true, follow: true },
    });
  });
});
