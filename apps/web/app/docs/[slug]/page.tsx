import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { docPages, getDocPage } from "../../../components/docs-content";
import { DocArticle, DocsShell } from "../../../components/docs-shell";

export function generateStaticParams() {
  return docPages.map((page) => ({ slug: page.slug }));
}

export async function generateMetadata({
  params,
}: {
  readonly params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const page = getDocPage(slug);
  return page
    ? { title: `${page.title} — PayOps docs`, description: page.summary }
    : {};
}

export default async function DocPage({
  params,
}: {
  readonly params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const page = getDocPage(slug);
  if (!page) notFound();

  return (
    <DocsShell currentSlug={slug}>
      <DocArticle page={page} />
    </DocsShell>
  );
}
