import { ArrowRight, CheckCircle, SealCheck } from "@phosphor-icons/react/ssr";

import { MarketingHeader } from "./marketing-header";
import { MarketingFooter } from "./marketing-page";

const commitments = [
  "Versioned public contracts and deterministic conformance fixtures",
  "Apache-2.0 packages that can run outside the hosted product",
  "Explicit exceptions instead of guessed payment matches",
  "Public release, security, contribution, and roadmap evidence",
] as const;

export function AboutPageContent() {
  return (
    <div className="marketing trust-page" id="top">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <MarketingHeader homeHref="/" sectionHrefPrefix="/" />
      <main id="main-content">
        <section className="trust-page-hero" aria-labelledby="about-title">
          <p className="eyebrow">About PayOps</p>
          <h1 id="about-title">Payment evidence that teams can reproduce.</h1>
          <p>
            PayOps is built and maintained by Gautam Manchandani as an
            independent open-source project. The project focuses on making
            Solana stablecoin payment decisions reproducible across product,
            operations, and finance systems.
          </p>
          <a className="button" href="/try">
            Try the public workspace
            <ArrowRight size={18} aria-hidden="true" />
          </a>
        </section>

        <div className="trust-page-sections">
          <section aria-labelledby="problem-title">
            <p className="trust-page-index">01</p>
            <div>
              <h2 id="problem-title">The problem</h2>
              <p>
                A successful signature does not prove which invoice was paid.
                Teams still need to verify finality, token identity, recipient
                ownership, exact integer amount, references, and balance
                movement before updating business state.
              </p>
              <p>
                PayOps records those facts as one deterministic decision with
                replayable evidence. Missing or conflicting evidence becomes a
                reviewable exception rather than a guessed match.
              </p>
            </div>
          </section>

          <section aria-labelledby="solana-title">
            <p className="trust-page-index">02</p>
            <div>
              <h2 id="solana-title">Why Solana</h2>
              <p>
                Production payment verification must understand both legacy and
                versioned transactions, including address lookup tables and CPI
                token transfers. It must also resolve SPL token-account
                ownership, finalized commitment, and Solana Pay reference
                accounts without treating a signature as sufficient proof.
              </p>
              <p>
                PayOps makes these Solana-specific checks inspectable and keeps
                the exact rule and parser versions with the resulting evidence.
              </p>
            </div>
          </section>

          <section aria-labelledby="commitments-title">
            <p className="trust-page-index">03</p>
            <div>
              <h2 id="commitments-title">Public-good commitments</h2>
              <ul className="trust-commitment-list">
                {commitments.map((commitment) => (
                  <li key={commitment}>
                    <CheckCircle size={19} weight="fill" aria-hidden="true" />
                    {commitment}
                  </li>
                ))}
              </ul>
            </div>
          </section>

          <section aria-labelledby="boundaries-title">
            <p className="trust-page-index">04</p>
            <div>
              <h2 id="boundaries-title">Current boundaries</h2>
              <div className="boundary-panel">
                <SealCheck size={25} weight="fill" aria-hidden="true" />
                <p>
                  PayOps supports canonical mainnet USDC and USDT under the
                  legacy SPL Token Program. Token-2022 is not supported. PayOps
                  does not custody funds, sign transactions, provide compliance
                  decisions, or promise a contractual service level.
                </p>
              </div>
            </div>
          </section>
        </div>
      </main>
      <MarketingFooter />
    </div>
  );
}
