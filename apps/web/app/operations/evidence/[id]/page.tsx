import { notFound } from "next/navigation";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export default async function EvidenceReadyPage({
  params,
}: {
  readonly params: Promise<{ readonly id: string }>;
}) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const encoded = encodeURIComponent(id);
  return (
    <main className="ops-shell evidence-ready">
      <section className="ops-workspace">
        <p className="ops-kicker">Evidence ready</p>
        <h1>Keep the three verification files together.</h1>
        <p className="ops-intro">
          The signed JSON proves the payment record. Its signed artifact digest
          also proves the PDF. The historical key file makes verification
          possible after key rotation.
        </p>
        <div className="evidence-downloads">
          <a href={`/operations/download/evidence/${encoded}?format=json`}>
            Signed JSON manifest
          </a>
          <a href={`/operations/download/evidence/${encoded}?format=pdf`}>
            Human-readable PDF
          </a>
          <a href={`/operations/download/evidence/${encoded}/verification`}>
            Signature and public key
          </a>
        </div>
        <a className="ops-back-link" href="/operations">
          Back to payment operations
        </a>
      </section>
    </main>
  );
}
