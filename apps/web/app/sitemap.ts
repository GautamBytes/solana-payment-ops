import type { MetadataRoute } from "next";

import { docPages } from "../components/docs-content";
import { resolvePublicWebOrigin } from "../lib/public-origin";

export default function sitemap(): MetadataRoute.Sitemap {
  const origin = resolvePublicWebOrigin(process.env.PAYOPS_WEB_ORIGIN);
  const paths = [
    "/",
    "/try",
    "/docs",
    ...docPages.map((page) => `/docs/${page.slug}`),
    "/about",
    "/roadmap",
  ];

  return paths.map((path) => ({ url: `${origin}${path}` }));
}
