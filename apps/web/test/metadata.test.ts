import { describe, expect, test } from "vitest";

import { metadata as rootMetadata } from "../app/layout";
import { metadata as operationsMetadata } from "../app/operations/layout";
import { metadata as checkoutMetadata } from "../app/pay/[token]/page";
import robots from "../app/robots";
import sitemap from "../app/sitemap";
import { docPages } from "../components/docs-content";
import { resolvePublicWebOrigin } from "../lib/public-origin";

describe("public discovery metadata", () => {
  test("uses one canonical public origin", () => {
    expect(rootMetadata.metadataBase?.toString()).toBe(
      "https://payops-seven.vercel.app/",
    );
    expect(rootMetadata.robots).toBeUndefined();
    expect(rootMetadata.referrer).toBe("no-referrer");
    expect(resolvePublicWebOrigin("https://payops.example")).toBe(
      "https://payops.example",
    );
    expect(() => resolvePublicWebOrigin("http://payops.example")).toThrow(
      "invalid_public_web_origin",
    );
  });

  test("publishes every public product and documentation route", () => {
    const urls = sitemap().map((entry) => entry.url);
    const expectedPaths = [
      "/",
      "/try",
      "/docs",
      ...docPages.map((page) => `/docs/${page.slug}`),
      "/about",
      "/roadmap",
    ];

    expect(urls).toEqual(
      expectedPaths.map((path) => `https://payops-seven.vercel.app${path}`),
    );
  });

  test("keeps checkout and operational surfaces out of search", () => {
    expect(operationsMetadata.robots).toMatchObject({
      index: false,
      follow: false,
    });
    expect(checkoutMetadata.robots).toMatchObject({
      index: false,
      follow: false,
    });
    expect(robots().rules).toEqual({
      userAgent: "*",
      allow: "/",
      disallow: ["/pay/", "/operations/"],
    });
  });
});
