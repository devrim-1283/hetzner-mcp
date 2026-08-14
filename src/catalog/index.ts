/**
 * The single accessor for the generated catalog.
 *
 * Nothing outside this module reads `CATALOG` directly — it is deliberately not
 * re-exported. Every consumer that filtered the raw array itself would grow its
 * own idea of what is visible, and those ideas drift: the model finds
 * `delete_server`, discovers there is no door for it, and stalls. One accessor,
 * one set of filters.
 *
 * Dependency-free and synchronous on purpose. This module is imported on the
 * hot path of process start — every MCP client spawns the server fresh — so it
 * builds one index over ~220 rows and does nothing else at load.
 */

import { CATALOG } from '../generated/catalog.js';
import { METADATA } from '../generated/meta.js';
import { SCHEMAS } from '../generated/schemas.js';
import type { OperationSchema, ParamSchema } from '../generated/schemas.js';
import { SURFACES } from '../types.js';
import type {
  CatalogOperation,
  DangerClass,
  HttpMethod,
  OperationFamily,
  Surface,
} from '../types.js';

export { METADATA };
export type { OperationSchema, ParamSchema };

const OPERATIONS_BY_ID: ReadonlyMap<string, CatalogOperation> = new Map(
  CATALOG.map((operation) => [operation.id, operation]),
);

// A Map, not the record itself: `SCHEMAS['constructor']` on an object literal
// answers from the prototype chain with something truthy, and the id reaching
// these functions came from the model.
const SCHEMAS_BY_ID: ReadonlyMap<string, OperationSchema> = new Map(Object.entries(SCHEMAS));

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

/**
 * Metadata for an id. This is a lookup, not a permission check — it answers
 * "what is this operation", never "may I run it". Anything deciding
 * reachability must consult the returned row's `danger` itself.
 */
export function getOperation(id: string): CatalogOperation | undefined {
  return OPERATIONS_BY_ID.get(id);
}

/**
 * Pruned parameter and request-body schemas, or undefined when the operation
 * takes neither. Kept out of `CatalogOperation` on purpose: inlining ~220
 * schemas into every search result would spend the context budget the catalog
 * exists to save. Search shows the row; describe shows the shape.
 */
export function getSchema(id: string): OperationSchema | undefined {
  return SCHEMAS_BY_ID.get(id);
}

export function operationCount(): number {
  return CATALOG.length;
}

// ---------------------------------------------------------------------------
// Billing
// ---------------------------------------------------------------------------

/**
 * A category key from the cloud API's `GET /pricing` response.
 *
 * Left as a plain string rather than a union: the categories are data owned by
 * Hetzner, and a union baked in here would claim an authority this module does
 * not have. The catalog test reads the real list out of the vendored spec and
 * asserts every value below is one of them, so a pricing change breaks the
 * build rather than silently invalidating the mapping.
 */
export type PricingCategory = string;

/**
 * Which `/pricing` category quotes the price a costly operation opens.
 *
 * `costly` on its own only says "this opens a bill". This says which bill, so
 * the tool layer can fill `ResponseMeta.billing` from the same `/pricing` data
 * Hetzner publishes and state the actual price next to the act rather than
 * leaving it for the invoice.
 *
 * Cloud only. The account surface has no `/pricing` endpoint — creating or
 * resizing a Storage Box is billable, but Hetzner publishes no machine-readable
 * price for it, so those operations carry `costly` with no category rather than
 * a category invented here.
 */
export const PRICING_CATEGORY_BY_OPERATION: ReadonlyMap<string, PricingCategory> = new Map([
  ['create_server', 'server_types'],
  ['change_server_type', 'server_types'],
  ['create_volume', 'volume'],
  ['resize_volume', 'volume'],
  ['create_load_balancer', 'load_balancer_types'],
  ['change_load_balancer_type', 'load_balancer_types'],
  ['create_floating_ip', 'floating_ips'],
  ['create_primary_ip', 'primary_ips'],
  ['create_server_image', 'image'],
  ['enable_server_backup', 'server_backup'],
]);

/** The `/pricing` category for an operation, or undefined when none applies. */
export function getPricingCategory(id: string): PricingCategory | undefined {
  return PRICING_CATEGORY_BY_OPERATION.get(id);
}

// ---------------------------------------------------------------------------
// Browsing
// ---------------------------------------------------------------------------

export interface FamilySummary {
  family: OperationFamily;
  count: number;
}

/**
 * Families present on a surface, largest first.
 *
 * Derived rather than declared: `OperationFamily` lists every family the
 * product will ever have, including the Robot ones no spec has been vendored
 * for yet. Offering a model a family that resolves to zero operations wastes a
 * turn, so only families with rows are listed.
 */
export function listFamilies(surface?: Surface): FamilySummary[] {
  const counts = new Map<OperationFamily, number>();
  for (const operation of CATALOG) {
    if (surface !== undefined && operation.surface !== surface) continue;
    counts.set(operation.family, (counts.get(operation.family) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([family, count]) => ({ family, count }))
    .sort((a, b) => b.count - a.count || a.family.localeCompare(b.family));
}

export interface SurfaceSummary {
  surface: Surface;
  count: number;
}

/** Surfaces the shipped catalog actually covers. `robot` is absent until vendored. */
export function listSurfaces(): SurfaceSummary[] {
  return SURFACES.map((surface) => ({
    surface,
    count: CATALOG.filter((operation) => operation.surface === surface).length,
  })).filter((row) => row.count > 0);
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export interface SearchOptions {
  /** Free text matched against operation id, path and summary. */
  query?: string;
  /** Accepts a set so a caller can pass exactly the surfaces it has connections for. */
  surface?: Surface | readonly Surface[];
  family?: OperationFamily | readonly OperationFamily[];
  /** Accepts a set so a gated server can search only the classes it will run. */
  danger?: DangerClass | readonly DangerClass[];
  method?: HttpMethod | readonly HttpMethod[];
  limit?: number;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/**
 * Noise words only. `get`, `list`, `create` and `delete` stay in — they are the
 * strongest routing signal a query carries, not filler.
 */
const STOPWORDS: ReadonlySet<string> = new Set([
  'a',
  'an',
  'the',
  'of',
  'for',
  'to',
  'in',
  'on',
  'is',
  'it',
  'and',
  'my',
  'me',
  'i',
  'how',
  'do',
  'can',
  'you',
  'please',
]);

/**
 * Where Hetzner's vocabulary diverges from the question a person asks.
 * Deliberately not a general thesaurus: each entry exists because an operation
 * is otherwise unreachable by the obvious query.
 *
 * The DNS entries matter most. Hetzner calls a DNS zone a "Zone" and a record
 * set an "RRSet", so nothing in the id, path or summary of `create_zone_rrset`
 * contains a word anybody types when they mean "add a DNS record".
 */
const QUERY_ALIASES: ReadonlyMap<string, string> = new Map([
  ['dns', 'zone'],
  ['domain', 'zone'],
  ['record', 'rrset'],
  ['records', 'rrsets'],
  ['vm', 'server'],
  ['vps', 'server'],
  ['instance', 'server'],
  ['machine', 'server'],
  ['lb', 'balancer'],
  ['loadbalancer', 'balancer'],
  ['disk', 'volume'],
  ['restart', 'reboot'],
  ['ssl', 'certificate'],
  ['tls', 'certificate'],
  ['cert', 'certificate'],
  ['key', 'ssh'],
  ['storagebox', 'storage'],
]);

// Whole-token hits outrank substring hits: "reset" matching the `reset` segment
// of `reset_server_password` means more than "set" appearing inside it.
const SCORE_EXACT_ID = 1000;
const SCORE_ID_TOKEN = 10;
const SCORE_ID_SUBSTRING = 6;
const SCORE_PATH_TOKEN = 6;
const SCORE_PATH_SUBSTRING = 4;
const SCORE_SUMMARY_TOKEN = 4;
const SCORE_SUMMARY_SUBSTRING = 2;

/**
 * Charged per token in the id that the query did not ask for.
 *
 * Without it "create server" ranks `create_server_image` above `create_server`,
 * and "load balancer" ranks `attach_load_balancer_to_network` above
 * `list_load_balancers`: the longer id matches everything the shorter one does
 * plus more text, so it accumulates a higher raw score while being the more
 * specific — and therefore less likely — answer. Words the caller did not say
 * are evidence against the match, not for it.
 */
const PENALTY_UNASKED_ID_TOKEN = 8;

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0 && !STOPWORDS.has(token));
}

/**
 * Hetzner's ids are singular (`create_server`) while its paths are plural
 * (`/servers`), and a person types whichever comes to mind. Without folding the
 * two together, "load balancer" ranks `get_load_balancer_type` above
 * `list_load_balancers` — the plural id simply fails to match the singular
 * query and loses ten points for it.
 *
 * A trailing `s` is the whole stemmer. Anything more would need a real word
 * list, and both sides of the comparison keep their original token as well, so
 * a wrong stem costs nothing: `status` -> `statu` matches only itself.
 */
function expand(token: string): string[] {
  if (token.length >= 3 && token.endsWith('s')) return [token, token.slice(0, -1)];
  return [token];
}

function tokenSet(text: string): Set<string> {
  const out = new Set<string>();
  for (const token of tokenize(text)) for (const form of expand(token)) out.add(form);
  return out;
}

interface SearchIndexEntry {
  id: string;
  path: string;
  summary: string;
  /** Raw id tokens, for the whole-id coverage bonus. */
  idTokenList: readonly string[];
  idTokens: ReadonlySet<string>;
  pathTokens: ReadonlySet<string>;
  summaryTokens: ReadonlySet<string>;
}

// Derived once from immutable data. Cold start is a UX property here, but ~220
// splits at load beat redoing them on every search call.
const SEARCH_INDEX: ReadonlyMap<string, SearchIndexEntry> = new Map(
  CATALOG.map((operation) => {
    const id = operation.id.toLowerCase();
    const path = operation.path.toLowerCase();
    const summary = operation.summary.toLowerCase();
    return [
      operation.id,
      {
        id,
        path,
        summary,
        idTokenList: tokenize(id),
        idTokens: tokenSet(id),
        pathTokens: tokenSet(path),
        summaryTokens: tokenSet(summary),
      },
    ];
  }),
);

function fieldScore(
  token: string,
  tokens: ReadonlySet<string>,
  haystack: string,
  tokenScore: number,
  substringScore: number,
): number {
  for (const form of expand(token)) if (tokens.has(form)) return tokenScore;
  // Substring runs against the raw query token only. A stemmed substring probe
  // would let "status" find every path containing "statu", which is noise.
  return haystack.includes(token) ? substringScore : 0;
}

/** Fields are summed: a term present in id, path and summary is a stronger hit. */
function scoreToken(token: string, entry: SearchIndexEntry): number {
  return (
    fieldScore(token, entry.idTokens, entry.id, SCORE_ID_TOKEN, SCORE_ID_SUBSTRING) +
    fieldScore(token, entry.pathTokens, entry.path, SCORE_PATH_TOKEN, SCORE_PATH_SUBSTRING) +
    fieldScore(
      token,
      entry.summaryTokens,
      entry.summary,
      SCORE_SUMMARY_TOKEN,
      SCORE_SUMMARY_SUBSTRING,
    )
  );
}

/** How many tokens the id carries that the query never mentioned. */
function unaskedIdTokens(tokens: readonly string[], entry: SearchIndexEntry): number {
  const asked = new Set<string>();
  for (const token of tokens) {
    for (const form of expand(token)) asked.add(form);
    const alias = QUERY_ALIASES.get(token);
    if (alias !== undefined) for (const form of expand(alias)) asked.add(form);
  }
  return entry.idTokenList.filter((idToken) => !expand(idToken).some((f) => asked.has(f))).length;
}

interface ScoredOperation {
  operation: CatalogOperation;
  /** How many query tokens hit anything. Ranks above raw score. */
  matched: number;
  score: number;
}

function scoreOperation(operation: CatalogOperation, tokens: readonly string[]): ScoredOperation {
  const entry = SEARCH_INDEX.get(operation.id);
  if (entry === undefined) return { operation, matched: 0, score: 0 };

  let matched = 0;
  let score = 0;
  for (const token of tokens) {
    // A Map again: `tokenize` happily yields "constructor", and an object
    // literal would answer that lookup from its prototype.
    const alias = QUERY_ALIASES.get(token);
    const hit = Math.max(
      scoreToken(token, entry),
      alias === undefined ? 0 : scoreToken(alias, entry),
    );
    if (hit > 0) {
      matched += 1;
      score += hit;
    }
  }
  if (matched > 0) score -= PENALTY_UNASKED_ID_TOKEN * unaskedIdTokens(tokens, entry);
  return { operation, matched, score };
}

function resolveLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_LIMIT);
}

function includes<T>(filter: T | readonly T[] | undefined, value: T): boolean {
  if (filter === undefined) return true;
  return Array.isArray(filter) ? filter.includes(value) : filter === value;
}

function matchesFilters(operation: CatalogOperation, opts: SearchOptions): boolean {
  return (
    includes(opts.surface, operation.surface) &&
    includes(opts.family, operation.family) &&
    includes(opts.danger, operation.danger) &&
    includes(opts.method, operation.method)
  );
}

/**
 * Relevance search over the catalog.
 *
 * Returned rows are whole `CatalogOperation`s, so every result carries its
 * `danger`, its `costly` flag and whether it `returnsAction` — the model can
 * pick the right door and know what the response will look like on the first
 * try instead of guessing and being refused.
 */
export function searchOperations(opts: SearchOptions = {}): CatalogOperation[] {
  const limit = resolveLimit(opts.limit);
  const filtered = CATALOG.filter((operation) => matchesFilters(operation, opts));

  const normalizedQuery = (opts.query ?? '').trim().toLowerCase();
  const tokens = tokenize(normalizedQuery);
  // Browsing, not searching: `family: 'volumes'` with no query is a legitimate
  // "show me what is here", so return the filtered set rather than nothing.
  if (tokens.length === 0) return filtered.slice(0, limit);

  const scored: ScoredOperation[] = [];
  for (const operation of filtered) {
    // An id typed verbatim is an unambiguous request, not a relevance question.
    if (operation.id.toLowerCase() === normalizedQuery) {
      scored.push({ operation, matched: tokens.length, score: SCORE_EXACT_ID });
      continue;
    }
    const row = scoreOperation(operation, tokens);
    if (row.matched > 0) scored.push(row);
  }

  scored.sort(
    (a, b) =>
      b.matched - a.matched || b.score - a.score || a.operation.id.localeCompare(b.operation.id),
  );
  return scored.slice(0, limit).map((row) => row.operation);
}
