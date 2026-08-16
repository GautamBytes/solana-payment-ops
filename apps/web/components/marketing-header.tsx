"use client";

import { ArrowUpRight, List, SealCheck, X } from "@phosphor-icons/react";
import { useState } from "react";

import { marketingDestinations } from "./marketing-destinations";

const links = [
  { href: "#how-it-works", label: "How it works" },
  { href: "#merchants", label: "Solutions" },
  { href: "/docs", label: "Documentation" },
  { href: "/docs/packages", label: "Packages" },
] as const;

type MarketingHeaderProps = {
  readonly homeHref?: string;
  readonly sectionHrefPrefix?: string;
  readonly ctaHref?: string;
  readonly ctaLabel?: string;
};

export function MarketingHeader({
  homeHref = "#top",
  sectionHrefPrefix = "",
  ctaHref = marketingDestinations.tryUrl,
  ctaLabel = "Try PayOps",
}: MarketingHeaderProps = {}) {
  const [open, setOpen] = useState(false);

  function resolveHref(href: string) {
    return href.startsWith("#") ? `${sectionHrefPrefix}${href}` : href;
  }

  return (
    <header className="marketing-header">
      <div className="marketing-header-inner">
        <a className="marketing-brand" href={homeHref} aria-label="PayOps home">
          <span className="payops-brand-seal" aria-hidden="true">
            <SealCheck size={34} weight="fill" />
          </span>
          <span className="marketing-brand-copy">
            <strong>PayOps</strong>
            <small>Verified Solana payments</small>
          </span>
        </a>

        <nav className="desktop-nav" aria-label="Primary navigation">
          {links.map((link) => (
            <a key={link.href} href={resolveHref(link.href)}>
              {link.label}
            </a>
          ))}
          <a href={marketingDestinations.githubUrl}>GitHub</a>
        </nav>

        <a className="button button-small header-cta" href={ctaHref}>
          <span>{ctaLabel}</span>
          <ArrowUpRight
            className="header-cta-icon"
            size={17}
            aria-hidden="true"
          />
        </a>

        <button
          className="mobile-menu-button"
          type="button"
          aria-label={open ? "Close navigation" : "Open navigation"}
          aria-expanded={open}
          aria-controls="mobile-navigation"
          onClick={() => setOpen((current) => !current)}
        >
          {open ? (
            <X size={23} aria-hidden="true" />
          ) : (
            <List size={23} aria-hidden="true" />
          )}
        </button>
      </div>

      <nav
        className="mobile-nav"
        id="mobile-navigation"
        aria-label="Mobile navigation"
        hidden={!open}
      >
        {links.map((link) => (
          <a
            key={link.href}
            href={resolveHref(link.href)}
            onClick={() => setOpen(false)}
          >
            {link.label}
          </a>
        ))}
        <a
          href={marketingDestinations.githubUrl}
          onClick={() => setOpen(false)}
        >
          GitHub
        </a>
        <a className="button" href={ctaHref} onClick={() => setOpen(false)}>
          {ctaLabel}
          <ArrowUpRight size={18} aria-hidden="true" />
        </a>
      </nav>
    </header>
  );
}
