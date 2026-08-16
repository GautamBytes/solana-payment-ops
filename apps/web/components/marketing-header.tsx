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

export function MarketingHeader() {
  const [open, setOpen] = useState(false);

  return (
    <header className="marketing-header">
      <div className="marketing-header-inner">
        <a className="marketing-brand" href="#top" aria-label="PayOps home">
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
            <a key={link.href} href={link.href}>
              {link.label}
            </a>
          ))}
          <a href={marketingDestinations.githubUrl}>GitHub</a>
        </nav>

        <a
          className="button button-small header-cta"
          href={marketingDestinations.tryUrl}
        >
          <span>Try PayOps</span>
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
          <a key={link.href} href={link.href} onClick={() => setOpen(false)}>
            {link.label}
          </a>
        ))}
        <a
          href={marketingDestinations.githubUrl}
          onClick={() => setOpen(false)}
        >
          GitHub
        </a>
        <a
          className="button"
          href={marketingDestinations.tryUrl}
          onClick={() => setOpen(false)}
        >
          Try PayOps
          <ArrowUpRight size={18} aria-hidden="true" />
        </a>
      </nav>
    </header>
  );
}
