import { existsSync, readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

describe("PayOps marketing homepage", () => {
  it("explains the product, its safeguards, and both adoption paths", async () => {
    expect(existsSync(new URL("../app/page.tsx", import.meta.url))).toBe(true);

    const { default: HomePage } = await import("../app/page");
    const markup = renderToStaticMarkup(createElement(HomePage));

    expect(markup).toContain(
      "Know exactly which Solana payments got you paid.",
    );
    expect(markup).toContain("watches finalized USDC and USDT transfers");
    expect(markup).toContain("No custody. No private keys.");
    expect(markup).toContain("What happens after your customer pays?");
    expect(markup).toContain("Detect");
    expect(markup).toContain("Verify");
    expect(markup).toContain("Match");
    expect(markup).toContain("Prove");
    expect(markup).toContain("never falsely marked paid");
    expect(markup).toContain("For merchants");
    expect(markup).toContain("For developers");
    expect(markup).toContain("Why teams trust PayOps");
    expect(markup).toContain("25 / 25 conformance");
    expect(markup).toContain("npm install @payops/sdk");
  });

  it("keeps product education on the website and reserves GitHub for source", async () => {
    const { default: HomePage } = await import("../app/page");
    const markup = renderToStaticMarkup(createElement(HomePage));

    expect(markup).toContain('href="#how-it-works"');
    expect(markup).toContain('href="#merchants"');
    expect(markup).toContain('href="#developers"');
    expect(markup).toContain(
      'href="https://github.com/GautamBytes/solana-payment-ops"',
    );
    expect(markup).toContain('href="/docs"');
    expect(markup).toContain('href="/docs/integration"');
    expect(markup).toContain('href="/docs/packages"');
    expect(markup).toContain('href="/docs/security"');
    expect(markup).not.toContain("/tree/main/docs/");
    expect(markup).toContain(
      'href="https://github.com/GautamBytes/solana-payment-ops/issues/new',
    );
    expect(markup).toContain("title=Question%20about%20PayOps");
    expect(markup).not.toContain("/discussions");
  });

  it("uses the approved plain-language hero and documentation preview", async () => {
    const { default: HomePage } = await import("../app/page");
    const markup = renderToStaticMarkup(createElement(HomePage));

    expect(markup).toContain(
      "Know exactly which Solana payments got you paid.",
    );
    expect(markup).toContain("Open the docs");
    expect(markup).toContain("Quickstart");
    expect(markup).toContain("Architecture");
    expect(markup).toContain("Lifecycle events");
    expect(markup).toContain("API reference");
    expect(markup).toContain('data-hero-flow-field="true"');
    expect(markup).toContain('aria-hidden="true"');
  });

  it("publishes indexable homepage metadata without changing private routes", async () => {
    const { metadata } = await import("../app/page");

    expect(metadata.title).toBe(
      "PayOps — Solana payment reconciliation for real businesses",
    );
    expect(metadata.robots).toMatchObject({ index: true, follow: true });
    expect(metadata.openGraph).toMatchObject({
      title: "Know exactly which Solana payments got you paid.",
      type: "website",
    });
  });

  it("includes accessible navigation and interaction controls", async () => {
    const { default: HomePage } = await import("../app/page");
    const markup = renderToStaticMarkup(createElement(HomePage));

    expect(markup).toContain('href="#main-content"');
    expect(markup).toContain("Skip to content");
    expect(markup).toContain('aria-label="Open navigation"');
    expect(markup).toContain('aria-label="Copy SDK install command"');
    expect(markup).toContain('aria-live="polite"');
  });

  it("keeps generic marketing controls isolated from checkout and operations", () => {
    const css = readFileSync(
      new URL("../styles/marketing.css", import.meta.url),
      "utf8",
    );

    expect(css).not.toMatch(/^\.button(?:-|\s|\{|,)/m);
    expect(css).not.toMatch(/^\.mobile-nav(?:-|\s|\{|,)/m);
  });

  it("reveals compact sections progressively without hiding content from no-JS users", async () => {
    const { default: HomePage } = await import("../app/page");
    const markup = renderToStaticMarkup(createElement(HomePage));
    const css = readFileSync(
      new URL("../styles/marketing.css", import.meta.url),
      "utf8",
    );

    expect(markup.match(/data-scroll-reveal="true"/g)).toHaveLength(7);
    expect(markup).toContain('data-marketing-reveal-controller="true"');
    expect(css).toContain("content-visibility: auto");
    expect(css).toContain("contain-intrinsic-size: auto 36rem");
    expect(css).toContain(
      '.marketing.reveal-enabled [data-scroll-reveal="true"]',
    );
    expect(css).toContain("filter: blur(8px)");
    expect(css).toContain("cubic-bezier(0.22, 1, 0.36, 1)");
    expect(css).toContain("padding: clamp(4.75rem, 7vw, 6.25rem) 0");
  });
});
