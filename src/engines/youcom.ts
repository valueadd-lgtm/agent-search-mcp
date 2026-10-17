import { SearchResult, type EngineSearchOptions } from '../types.js';
import { withTimeout } from '../infrastructure/abort.js';
import { logger } from '../infrastructure/logger.js';
import { providerCatalog } from './provider-catalog.js';

export const youcomProvider = providerCatalog.youcom;

/**
 * Attributable User-Agent for You.com API traffic from this integration.
 * See https://github.com/youdotcom-oss/integration-tracking for the convention.
 */
const YOUCOM_USER_AGENT = 'youdotcom-integration/lennney-agent-search-mcp';

interface YouComSearchItem {
  url?: string;
  title?: string;
  description?: string;
  snippets?: string[];
  snippet?: string;
}

interface YouComSearchResponse {
  // Keyed Agents API returns a flat `results` array; the keyless Agents API and
  // the Search API nest results under `web`/`news`. Detect with Array.isArray.
  results?:
    | YouComSearchItem[]
    | { web?: YouComSearchItem[]; news?: YouComSearchItem[] };
}

function mapResult(result: YouComSearchItem): SearchResult | null {
  const title = result.title?.trim() || '';
  const url = result.url?.trim() || '';
  if (!title || !url) return null;

  return {
    title,
    url,
    snippet:
      result.description?.trim()
      || result.snippets?.[0]?.trim()
      || result.snippet?.trim()
      || '',
    source: 'youcom',
    engines: ['youcom'],
  };
}

function collectItems(data: YouComSearchResponse): YouComSearchItem[] {
  const { results } = data;
  if (Array.isArray(results)) return results;
  return [...(results?.web ?? []), ...(results?.news ?? [])];
}

/**
 * Search You.com. Works without an API key using the keyless Agents API
 * (GET https://api.you.com/v1/agents/search, ~100 searches/day per IP), and
 * upgrades to the keyed Search API (GET https://ydc-index.io/v1/search) when
 * `YDC_API_KEY` is set for higher quota and `news` coverage.
 */
export async function searchYouCom(
  query: string,
  count: number = 10,
  options?: EngineSearchOptions,
): Promise<SearchResult[]> {
  const apiKey = process.env.YDC_API_KEY;
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'User-Agent': YOUCOM_USER_AGENT,
  };

  let url: string;
  if (apiKey) {
    const u = new URL('https://ydc-index.io/v1/search');
    u.searchParams.set('query', query);
    u.searchParams.set('count', String(count));
    url = u.toString();
    headers['X-API-Key'] = apiKey;
  } else {
    const u = new URL('https://api.you.com/v1/agents/search');
    u.searchParams.set('query', query);
    u.searchParams.set('max_results', String(count));
    url = u.toString();
  }

  const res = await fetch(url, {
    headers,
    signal: withTimeout(options?.signal, 10000),
  });

  if (!res.ok) {
    if (res.status >= 400 && res.status < 500) {
      if (options?.throwOnError) throw new Error(`You.com HTTP ${res.status}`);
      logger.warn({ status: res.status }, 'You.com HTTP client error');
      return [];
    }
    throw new Error(`You.com HTTP ${res.status}`);
  }

  const data = (await res.json()) as YouComSearchResponse;
  return collectItems(data)
    .map(mapResult)
    .filter((result): result is SearchResult => result !== null)
    .slice(0, count);
}