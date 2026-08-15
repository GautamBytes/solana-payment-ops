"use client";

import { List, X } from "@phosphor-icons/react";
import { useState } from "react";

import { marketingDestinations } from "./marketing-destinations";

const links = [
  { href: "#how-it-works", label: "How it works" },
  { href: "#merchants", label: "For merchants" },
  { href: "#developers", label: "For developers" },
  { href: "#trust", label: "Security" },
] as const;

export function MarketingHeader() {
  const [open, setOpen] = useState(false);

  return (
    <header className="marketing-header">
      <div className="marketing-header-inner">
        <a className="marketing-brand" href="#top" aria-label="PayOps home">
          <img src="/icon.svg" width="34" height="34" alt="" />
          <span>PayOps</span>
        </a>

        <nav className="desktop-nav" aria-label="Primary navigation">
          {links.map((link) => (
            <a key={link.href} href={link.href}>
              {link.label}
            </a>
          ))}
          <a href={marketingDestinations.docsUrl}>Docs</a>
          <a href={marketingDestinations.githubUrl}>GitHub</a>
        </nav>

        <a
          className="button button-small header-cta"
          href={marketingDestinations.pilotUrl}
        >
          Start a pilot
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
        <a href={marketingDestinations.docsUrl} onClick={() => setOpen(false)}>
          Docs
        </a>
        <a
          href={marketingDestinations.githubUrl}
          onClick={() => setOpen(false)}
        >
          GitHub
        </a>
        <a
          className="button"
          href={marketingDestinations.pilotUrl}
          onClick={() => setOpen(false)}
        >
          Start a pilot
        </a>
      </nav>
    </header>
  );
}
