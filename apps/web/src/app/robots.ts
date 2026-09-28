import type { MetadataRoute } from 'next';
import { buildRobots } from '@/lib/seo/feeds';
import { webConfig } from '@/server/config';

export const dynamic = 'force-dynamic';

export default function robots(): MetadataRoute.Robots {
  const config = webConfig();
  const publicSite = /^https:\/\/(?!localhost)/.test(config.publicWebOrigin);
  return buildRobots(config.publicWebOrigin, config.publicIndexing && publicSite);
}
