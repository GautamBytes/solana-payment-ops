import { existsSync, readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

describe("PayOps marketing homepage", () => {
  it("gives the hero actions distinct jobs and on-brand hover states", async () => {
    const { default: HomePage } = await import("../app/page");
    const markup = renderToStaticMarkup(createElement(HomePage));
    const css = readFileSync(
      new URL("../styles/marketing.css", import.meta.url),
      "utf8",
    );

    const heroActions =
      markup.match(/<div class="hero-actions">([\s\S]*?)<\/div>/)?.[1] ?? "";
    const primaryHover =
      css.match(/\.marketing \.button:hover\s*\{([^}]*)\}/s)?.[1] ?? "";
    const secondaryHover =
      css.match(/\.marketing \.button-secondary:hover\s*\{([^}]*)\}/s)?.[1] ??
      "";

    expect(heroActions).toContain('href="#how-it-works"');
    expect(heroActions).toContain("Explore payment flow");
    expect(heroActions).toContain('href="/docs/quickstart"');
    expect(heroActions).toContain("Developer quickstart");
    expect(heroActions).not.toContain("Open the docs");
    expect(primaryHover).toContain("background: var(--m-green-hover)");
    expect(primaryHover).not.toContain("var(--m-lime)");
    expect(secondaryHover).toContain("color: var(--m-green)");
    expect(secondaryHover).toContain("border-color:");
  });

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
    expect(markup).toContain("PayOps never marks them paid.");
    expect(markup).toContain("For merchants");
    expect(markup).toContain("For developers");
    expect(markup).toContain("Why teams trust PayOps");
    expect(markup).toContain("25 / 25 conformance");
    expect(markup).toContain('class="trust-surface"');
    expect(markup).toContain('class="proof-point-number"');
    expect(markup).toContain("Built for verification before automation.");
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

    const stageStart = markup.indexOf('class="hero-stage"');
    const fieldPosition = markup.indexOf('data-hero-flow-field="true"');
    const factsPosition = markup.indexOf('class="marketing-proof-rail"');

    expect(stageStart).toBeGreaterThan(-1);
    expect(fieldPosition).toBeGreaterThan(stageStart);
    expect(factsPosition).toBeGreaterThan(fieldPosition);
  });

  it("continues the animated hero field behind the bottom facts area", () => {
    const css = readFileSync(
      new URL("../styles/marketing.css", import.meta.url),
      "utf8",
    );
    const fieldSource = readFileSync(
      new URL("../components/hero-flow-field.tsx", import.meta.url),
      "utf8",
    );

    expect(css).toContain(".hero-stage");
    expect(css).toMatch(/\.hero-stage\s*\{[^}]*isolation:\s*isolate/s);
    expect(css).toMatch(
      /\.marketing-proof-rail\s*\{[^}]*position:\s*relative[^}]*z-index:\s*1/s,
    );
    expect(fieldSource).toContain('querySelector<HTMLElement>(".hero")');
    expect(fieldSource).toContain(
      "flowGeometryHeight(stageHeight, railHeight)",
    );
  });

  it("keeps the payment proof panel lifted within the desktop hero", () => {
    const css = readFileSync(
      new URL("../styles/marketing.css", import.meta.url),
      "utf8",
    );

    expect(css).toMatch(
      /\.proof-panel\s*\{[^}]*transform:\s*translateY\(-0\.75rem\)/s,
    );
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

  it("presents a polished responsive marketing navigation", async () => {
    const { default: HomePage } = await import("../app/page");
    const markup = renderToStaticMarkup(createElement(HomePage));
    const css = readFileSync(
      new URL("../styles/marketing.css", import.meta.url),
      "utf8",
    );

    expect(markup).toContain('class="marketing-brand-copy"');
    expect(markup).toContain("Verified Solana payments");
    expect(markup).toContain('class="payops-brand-seal"');
    expect(markup).not.toContain('src="/icon.svg"');
    expect(markup).toContain('class="header-cta-icon"');
    expect(css).toMatch(
      /\.marketing-header\s*\{[^}]*position:\s*sticky[^}]*backdrop-filter:\s*blur\(18px\)/s,
    );
    expect(css).toMatch(
      /\.desktop-nav\s*\{[^}]*border:\s*1px solid[^}]*border-radius:\s*999px/s,
    );
    expect(css).toMatch(/\.desktop-nav a::after\s*\{/);
    expect(css).toMatch(/\.header-cta\s*\{[^}]*box-shadow:/s);
    expect(css).toMatch(
      /\.marketing-header \.mobile-nav\s*\{[^}]*border-radius:/s,
    );
  });

  it("keeps the landing page compact across desktop and mobile", async () => {
    const css = readFileSync(
      new URL("../styles/marketing.css", import.meta.url),
      "utf8",
    );

    expect(css).toMatch(
      /\.hero\s*\{[^}]*min-height:\s*clamp\(38rem,\s*calc\(100svh - 4\.5rem\),\s*44rem\)/s,
    );
    expect(css).toMatch(
      /\.hero-inner\s*\{[^}]*padding:\s*clamp\(2\.75rem,\s*4\.5vw,\s*4rem\) 0 clamp\(3\.5rem,\s*5\.5vw,\s*5rem\)/s,
    );
    expect(css).toMatch(
      /\.marketing-section\s*\{[^}]*padding:\s*clamp\(3\.75rem,\s*5vw,\s*5\.25rem\) 0/s,
    );
    expect(css).toMatch(
      /@media \(max-width:\s*720px\)[\s\S]*?\.hero-inner\s*\{[^}]*padding:\s*2rem 0 2\.75rem/s,
    );
    expect(css).toMatch(
      /@media \(max-width:\s*720px\)[\s\S]*?\.marketing-section\s*\{[^}]*padding-block:\s*3\.25rem/s,
    );
  });

  it("gives the editorial, process, and documentation sections visual depth", async () => {
    const { default: HomePage } = await import("../app/page");
    const markup = renderToStaticMarkup(createElement(HomePage));
    const css = readFileSync(
      new URL("../styles/marketing.css", import.meta.url),
      "utf8",
    );

    expect(markup).toContain('class="plain-language-card"');
    expect(markup).toContain('class="plain-language-cues"');
    expect(markup.match(/class="process-card"/g)).toHaveLength(4);
    expect(markup).toContain('class="docs-window-shell"');
    expect(css).toMatch(
      /\.plain-language-card\s*\{[^}]*border:\s*1px solid[^}]*box-shadow:/s,
    );
    expect(css).toMatch(
      /\.process-card:hover\s*\{[^}]*transform:\s*translateY\(-0\.3rem\)/s,
    );
    expect(css).toMatch(
      /\.docs-window-shell\s*\{[^}]*border:\s*1px solid[^}]*box-shadow:/s,
    );
  });

  it("uses an on-brand review assurance instead of a warning treatment", async () => {
    const { default: HomePage } = await import("../app/page");
    const markup = renderToStaticMarkup(createElement(HomePage));
    const css = readFileSync(
      new URL("../styles/marketing.css", import.meta.url),
      "utf8",
    );

    expect(markup).toContain("Unclear payments go to review.");
    expect(markup).toContain("PayOps never marks them paid.");
    expect(markup).not.toContain("review—never");
    expect(css).toMatch(
      /\.exception-note\s*\{[^}]*border:\s*1px solid rgba\(22, 229, 162,[^}]*background:\s*rgba\(7, 24, 17,/s,
    );
  });

  it("uses the PayOps emerald palette for selected text", () => {
    const css = readFileSync(
      new URL("../styles/marketing.css", import.meta.url),
      "utf8",
    );

    expect(css).toMatch(
      /\.marketing ::selection,\s*\.docs-site ::selection\s*\{[^}]*color:\s*#03120c;[^}]*background:\s*rgba\(22, 229, 162, 0\.92\);/s,
    );
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
    expect(css).toContain("padding: clamp(3.75rem, 5vw, 5.25rem) 0");
  });
});
