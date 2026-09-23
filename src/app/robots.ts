import type { MetadataRoute } from "next";

/** Internal business application: keep every page out of search engines. */
export default function robots(): MetadataRoute.Robots {
  return { rules: { userAgent: "*", disallow: "/" } };
}
