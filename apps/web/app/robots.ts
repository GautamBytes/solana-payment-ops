import type { MetadataRoute } from "next";

import { resolvePublicWebOrigin } from "../lib/public-origin";

export default function robots(): MetadataRoute.Robots {
  const origin = resolvePublicWebOrigin(process.env.PAYOPS_WEB_ORIGIN);
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/pay/", "/operations/"],
    },
    sitemap: `${origin}/sitemap.xml`,
  };
}
