import {
  ArrowLeft,
  ArrowRight,
  CheckCircle,
  GithubLogo,
  SealCheck,
} from "@phosphor-icons/react/ssr";
import type { ReactNode } from "react";
import { docPages, type DocPage } from "./docs-content";
import { marketingDestinations } from "./marketing-destinations";

export function DocsShell({
  children,
  currentSlug,
}: {
  readonly children: ReactNode;
  readonly currentSlug?: string;
}) {
  return (
    <div className="docs-site">
      <a className="skip-link" href="#docs-content">
        Skip to content
      </a>
      <header className="docs-header">
        <a className="docs-brand" href="/" aria-label="PayOps home">
          <span className="payops-brand-seal" aria-hidden="true">
            <SealCheck size={32} weight="fill" />
          </span>
          <span>PayOps</span>
          <em>Docs</em>
        </a>
        <nav aria-label="Documentation utilities">
          <a href="/">Product</a>
          <a href={marketingDestinations.githubUrl}>
            <GithubLogo size={18} aria-hidden="true" /> Source
          </a>
          <a className="docs-header-cta" href={marketingDestinations.pilotUrl}>
            Start a pilot
          </a>
        </nav>
      </header>
      <div className="docs-layout">
        <aside className="docs-sidebar" aria-label="Documentation">
          <p>Documentation</p>
          <a className={!currentSlug ? "active" : undefined} href="/docs">
            Overview
          </a>
          {docPages.map((page) => (
            <a
              className={currentSlug === page.slug ? "active" : undefined}
              href={`/docs/${page.slug}`}
              key={page.slug}
            >
              {page.label}
            </a>
          ))}
          <div className="docs-sidebar-status">
            <CheckCircle size={18} weight="fill" aria-hidden="true" />
            <span>
              <strong>v0.1 contract</strong>
              Stable and replayable
            </span>
          </div>
        </aside>
        <main className="docs-main" id="docs-content">
          {children}
        </main>
      </div>
    </div>
  );
}

export function DocArticle({ page }: { readonly page: DocPage }) {
  const index = docPages.findIndex((candidate) => candidate.slug === page.slug);
  const previous = index > 0 ? docPages[index - 1] : undefined;
  const next = index < docPages.length - 1 ? docPages[index + 1] : undefined;

  return (
    <article className="doc-article">
      <header className="doc-article-header">
        <p className="docs-kicker">{page.label}</p>
        <h1>{page.title}</h1>
        <p>{page.summary}</p>
        <div className="doc-article-meta">
          <span>
            Guide {index + 1} of {docPages.length}
          </span>
          <span>{page.readingTime} read</span>
          <span>v0.1 stable</span>
        </div>
      </header>
      <nav className="doc-at-a-glance" aria-label="On this page">
        <div>
          <small>On this page</small>
          <strong>{page.sections.length} focused sections</strong>
        </div>
        <ol>
          {page.sections.map((section, sectionIndex) => (
            <li key={section.title}>
              <a href={`#${section.title.toLowerCase().replaceAll(" ", "-")}`}>
                <span>{String(sectionIndex + 1).padStart(2, "0")}</span>
                {section.title}
              </a>
            </li>
          ))}
        </ol>
      </nav>
      <div className="doc-article-body">
        {page.sections.map((section, sectionIndex) => (
          <section
            key={section.title}
            id={section.title.toLowerCase().replaceAll(" ", "-")}
          >
            <span className="doc-section-index">
              {String(sectionIndex + 1).padStart(2, "0")}
            </span>
            <div className="doc-section-content">
              <h2>{section.title}</h2>
              {section.body.map((paragraph) => (
                <p key={paragraph}>{paragraph}</p>
              ))}
              {section.code ? (
                <div className="doc-code-block">
                  <span>Example</span>
                  <pre>
                    <code>{section.code}</code>
                  </pre>
                </div>
              ) : null}
              {section.callout ? (
                <aside className="doc-callout">
                  <CheckCircle size={20} weight="fill" aria-hidden="true" />
                  <p>{section.callout}</p>
                </aside>
              ) : null}
            </div>
          </section>
        ))}
      </div>
      <nav className="doc-pagination" aria-label="Guide pagination">
        {previous ? (
          <a href={`/docs/${previous.slug}`}>
            <ArrowLeft size={18} aria-hidden="true" />
            <span>
              <small>Previous</small>
              {previous.label}
            </span>
          </a>
        ) : (
          <span />
        )}
        {next ? (
          <a href={`/docs/${next.slug}`}>
            <span>
              <small>Next</small>
              {next.label}
            </span>
            <ArrowRight size={18} aria-hidden="true" />
          </a>
        ) : null}
      </nav>
    </article>
  );
}
