"use client";

import { useEffect } from "react";

const REVEAL_SELECTOR = '[data-scroll-reveal="true"]';

export function MarketingScrollReveal() {
  useEffect(() => {
    const root = document.querySelector<HTMLElement>(".marketing");
    const sections = Array.from(
      document.querySelectorAll<HTMLElement>(REVEAL_SELECTOR),
    );
    const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");

    if (!root || sections.length === 0) return;

    if (motionQuery.matches || !("IntersectionObserver" in window)) {
      sections.forEach((section) => {
        section.dataset.revealed = "true";
      });
      return;
    }

    root.classList.add("reveal-enabled");
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;

          const section = entry.target as HTMLElement;
          section.dataset.revealed = "true";
          observer.unobserve(section);
        });
      },
      {
        rootMargin: "0px 0px -8% 0px",
        threshold: 0.06,
      },
    );

    sections.forEach((section) => observer.observe(section));

    return () => {
      observer.disconnect();
      root.classList.remove("reveal-enabled");
    };
  }, []);

  return <span hidden data-marketing-reveal-controller="true" />;
}
