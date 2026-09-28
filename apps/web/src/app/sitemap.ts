import type { MetadataRoute } from 'next';
import { buildSitemap } from '@/lib/seo/feeds';
import { webConfig } from '@/server/config';

export const dynamic = 'force-dynamic';

export default function sitemap(): MetadataRoute.Sitemap {
  return buildSitemap(webConfig().publicWebOrigin);
}
