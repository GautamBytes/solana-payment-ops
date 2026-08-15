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
    expect(markup).not.toContain(
      "github.com/GautamBytes/solana-payment-ops/tree",
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
    expect(markup).toContain("Previous");
    expect(markup).toContain("Next");
  });
});
