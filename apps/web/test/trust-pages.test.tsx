import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import AboutPage, { metadata as aboutMetadata } from "../app/about/page";
import RoadmapPage, { metadata as roadmapMetadata } from "../app/roadmap/page";

describe("public trust routes", () => {
  test("publishes factual project ownership and Solana-specific boundaries", () => {
    const markup = renderToStaticMarkup(createElement(AboutPage));

    expect(markup).toContain("Gautam Manchandani");
    expect(markup).toContain("versioned transactions");
    expect(markup).toContain("address lookup tables");
    expect(markup).toContain("CPI token transfers");
    expect(markup).toContain("Token-2022 is not supported");
    expect(aboutMetadata.title).toBe("About the project");
    expect(aboutMetadata.robots).toMatchObject({ index: true, follow: true });
  });

  test("separates shipped, in-progress, and proposed work", () => {
    const markup = renderToStaticMarkup(createElement(RoadmapPage));

    expect(markup).toContain("Shipped");
    expect(markup).toContain("In progress");
    expect(markup).toContain("Proposed grant milestones");
    expect(markup).toContain(
      "Hosted readiness checks, recovery runbooks, and structured logs",
    );
    expect(markup).toContain("Backup restore and incident drill evidence");
    expect(markup).not.toContain("Structured operational logging and alerts");
    expect(roadmapMetadata.title).toBe("Roadmap");
    expect(roadmapMetadata.robots).toMatchObject({ index: true, follow: true });
  });
});
