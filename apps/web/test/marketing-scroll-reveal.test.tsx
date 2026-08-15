/** @vitest-environment jsdom */

import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MarketingScrollReveal } from "../components/marketing-scroll-reveal";

class MockIntersectionObserver {
  static latest: MockIntersectionObserver | undefined;

  readonly observed: Element[] = [];
  readonly unobserved: Element[] = [];

  constructor(
    readonly callback: IntersectionObserverCallback,
    readonly options?: IntersectionObserverInit,
  ) {
    MockIntersectionObserver.latest = this;
  }

  observe = (target: Element) => this.observed.push(target);
  unobserve = (target: Element) => this.unobserved.push(target);
  disconnect = vi.fn();
  takeRecords = () => [];
  root = null;
  rootMargin = "0px";
  thresholds = [0.06];
}

function setReducedMotion(matches: boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({
      addEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
      matches,
      media: "(prefers-reduced-motion: reduce)",
      onchange: null,
      removeEventListener: vi.fn(),
    })),
  });
}

describe("marketing scroll reveals", () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <main class="marketing">
        <section data-scroll-reveal="true"></section>
        <section data-scroll-reveal="true"></section>
      </main>
    `;
    MockIntersectionObserver.latest = undefined;
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("reveals each section once when it enters the viewport", () => {
    setReducedMotion(false);
    vi.stubGlobal("IntersectionObserver", MockIntersectionObserver);

    render(<MarketingScrollReveal />);

    const root = document.querySelector(".marketing");
    const sections = Array.from(
      document.querySelectorAll<HTMLElement>('[data-scroll-reveal="true"]'),
    );
    const observer = MockIntersectionObserver.latest;
    const [firstSection, secondSection] = sections;
    if (!firstSection || !secondSection) {
      throw new Error("Expected both reveal sections");
    }

    expect(root?.classList.contains("reveal-enabled")).toBe(true);
    expect(observer?.observed).toEqual(sections);

    observer?.callback(
      [
        {
          isIntersecting: true,
          target: firstSection,
        } as unknown as IntersectionObserverEntry,
      ],
      observer as unknown as IntersectionObserver,
    );

    expect(firstSection.getAttribute("data-revealed")).toBe("true");
    expect(observer?.unobserved).toEqual([firstSection]);
    expect(secondSection.hasAttribute("data-revealed")).toBe(false);
  });

  it("shows everything immediately when reduced motion is requested", () => {
    setReducedMotion(true);

    render(<MarketingScrollReveal />);

    const root = document.querySelector(".marketing");
    const sections = Array.from(
      document.querySelectorAll<HTMLElement>('[data-scroll-reveal="true"]'),
    );

    expect(root?.classList.contains("reveal-enabled")).toBe(false);
    expect(
      sections.every((section) => section.dataset.revealed === "true"),
    ).toBe(true);
  });
});
