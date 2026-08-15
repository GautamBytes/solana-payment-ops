import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

describe("PayOps website documentation", () => {
  it("publishes the complete documentation map as website routes", async () => {
    const { docPages } = await import("../components/docs-content");

    expect(docPages.map((page) => page.slug)).toEqual([
      "quickstart",
      "integration",
      "architecture",
      "lifecycle",
      "security",
      "packages",
      "api",
    ]);
  });

  it("renders a self-contained documentation overview", async () => {
    const { default: DocsPage } = await import("../app/docs/page");
    const markup = renderToStaticMarkup(createElement(DocsPage));

    expect(markup).toContain("Build reliable Solana payment operations.");
    expect(markup).toContain("Start reconciling");
    expect(markup).toContain('href="/docs/integration"');
    expect(markup).toContain('href="/docs/architecture"');
    expect(markup).toContain('href="/docs/lifecycle"');
    expect(markup).toContain('href="/docs/security"');
    expect(markup).toContain("What PayOps is trying to fix");
    expect(markup).toContain("Who PayOps is for");
    expect(markup).toContain("Merchant and finance teams");
    expect(markup).toContain("Product and backend teams");
    expect(markup).toContain("Infrastructure and operations teams");
    expect(markup).toContain("How payment truth moves through PayOps");
    expect(markup).not.toContain(
      "github.com/GautamBytes/solana-payment-ops/tree",
    );
  });

  it("gives every guide enough context to be useful without repository notes", async () => {
    const { docPages } = await import("../components/docs-content");

    for (const page of docPages) {
      expect(page.sections.length, page.slug).toBeGreaterThanOrEqual(5);
      expect(
        page.sections.some((section) => section.body.length > 1),
        page.slug,
      ).toBe(true);
    }

    const quickstart = docPages.find((page) => page.slug === "quickstart");
    const integration = docPages.find((page) => page.slug === "integration");
    expect(quickstart?.sections.map((section) => section.title)).toContain(
      "Before you begin",
    );
    expect(quickstart?.sections.map((section) => section.title)).toContain(
      "Move from replay to production",
    );
    expect(integration?.sections.map((section) => section.title)).toContain(
      "Choose the path that fits your team",
    );
  });

  it("renders every guide inside the documentation shell", async () => {
    const { default: DocPage, generateStaticParams } =
      await import("../app/docs/[slug]/page");

    expect(generateStaticParams()).toHaveLength(7);

    const integration = await DocPage({
      params: Promise.resolve({ slug: "integration" }),
    });
    const markup = renderToStaticMarkup(integration);

    expect(markup).toContain("Integrate PayOps into your product");
    expect(markup).toContain("npm install @payops/core");
    expect(markup).toContain("Verify before parsing");
    expect(markup).toContain("Choose the path that fits your team");
    expect(markup).toContain("Previous");
    expect(markup).toContain("Next");
  });
});
