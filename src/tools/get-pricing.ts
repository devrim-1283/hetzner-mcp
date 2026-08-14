/**
 * get_pricing — what the next costly call will cost, before it is made.
 *
 * WHY THIS TOOL EXISTS AT ALL
 *
 * Costly operations in this product are deliberately NOT gated: creating a
 * server, a volume or a Load Balancer opens a bill and is still reachable
 * without a flag, because gating everything that spends money makes the server
 * useless for the work people actually do with it. Making the price visible is
 * what that openness is traded for. This is the endpoint behind that promise —
 * and the same data `billingFromPrices` reads when a write tool states the price
 * of what it just created.
 *
 * VAT IS PART OF THE PRICE, NOT A FOOTNOTE
 *
 * Every figure Hetzner publishes comes as a `net`/`gross` pair, and `vat_rate`
 * is the percentage between them for this account's billing country. A price
 * quoted without saying which of the two it is is wrong by that percentage, so
 * `currency` and `vat_rate` are returned on every response including a filtered
 * one, and the hint says plainly what each half means.
 *
 * WHY THE FILTERS
 *
 * The unfiltered payload is a price row per server type per location, and it
 * grows every time Hetzner opens a datacenter or adds a machine size. Asking for
 * one category, one location, or both keeps the answer proportional to the
 * question. `operation` is the same filter reached from the other direction:
 * given a catalog operation id, the catalog already knows which category quotes
 * the bill it opens.
 *
 * CLOUD ONLY
 *
 * The account API publishes no pricing endpoint. Creating or resizing a Storage
 * Box is billable, but Hetzner publishes no machine-readable price for it, so a
 * pricing request against an account connection is refused here by name rather
 * than being sent out to collect a 404 that explains nothing.
 */

import { z } from 'zod';

import {
  getOperation,
  getPricingCategory,
  PRICING_CATEGORY_BY_OPERATION,
} from '../catalog/index.js';
import { request } from '../http/client.js';
import type { Row } from '../shaping/project.js';
import { HetznerError, SURFACE_LABELS } from '../types.js';
import type { Connection, ToolDef } from '../types.js';
import {
  connectionProperty,
  optionalString,
  renderEnvelope,
  resolveConnection,
  runTool,
  shapeResponse,
  toRecord,
  type EnvelopeMeta,
} from './shared.js';

/**
 * Exactly what `GET /pricing` returns, beside `currency` and `vat_rate`.
 *
 * Spelled out rather than derived from the response so that asking for a
 * category Hetzner stopped publishing is a stated refusal instead of an empty
 * object, and so the schema can offer the list without a network call.
 *
 * The response also carries a singular `floating_ip` alongside the plural
 * `floating_ips`. It is the superseded shape — one flat monthly price with no
 * type and no location — and returning both would put two different prices for
 * the same thing in one response, so only the plural is listed.
 */
const CATEGORIES = [
  'primary_ips',
  'floating_ips',
  'image',
  'volume',
  'server_backup',
  'server_types',
  'load_balancer_types',
] as [string, ...string[]];

/** Priced per project, not per location; a location filter cannot narrow them. */
const LOCATIONLESS: readonly string[] = ['image', 'volume', 'server_backup'];

/**
 * Sacrificed in this order if the whole payload will not fit.
 *
 * Deprecation prose goes first because it restates the `deprecated` flag; the
 * traffic extras go next because they price a different thing than the machine
 * itself. The price pair is never in this list — a pricing response that dropped
 * the price would be worse than no response.
 */
const PRICING_PRUNABLE: readonly string[] = [
  'server_types.deprecation',
  'load_balancer_types.deprecation',
  'server_types.prices.price_per_tb_traffic',
  'load_balancer_types.prices.price_per_tb_traffic',
  'server_types.prices.included_traffic',
  'load_balancer_types.prices.included_traffic',
];

/** A Hetzner location name — `fsn1`, `nbg1`, `ash`. Never anything with a host in it. */
const LOCATION_PATTERN = /^[a-z0-9][a-z0-9-]{0,30}$/;

function isRow(value: unknown): value is Row {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Location filtering
// ---------------------------------------------------------------------------

/** Every location that appears in any `prices[]` entry of the payload. */
function collectLocations(value: unknown, out: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectLocations(item, out);
    return;
  }
  if (!isRow(value)) return;

  const prices = value['prices'];
  if (Array.isArray(prices)) {
    for (const price of prices) {
      const location = toRecord(price)['location'];
      if (typeof location === 'string') out.add(location);
    }
    return;
  }
  for (const child of Object.values(value)) collectLocations(child, out);
}

/**
 * Keeps only the price rows for one location.
 *
 * A row whose `prices` becomes empty is dropped entirely rather than returned
 * with an empty array: a server type that is not sold in Falkenstein is not an
 * answer to "what does it cost in Falkenstein", and an empty array reads as a
 * price of nothing.
 */
function withLocation(value: unknown, location: string): unknown {
  if (Array.isArray(value)) {
    return value.map((row) => withLocation(row, location)).filter((row) => row !== undefined);
  }
  if (!isRow(value)) return value;

  const prices = value['prices'];
  if (Array.isArray(prices)) {
    const kept = prices.filter((price) => toRecord(price)['location'] === location);
    return kept.length === 0 ? undefined : { ...value, prices: kept };
  }

  const out: Row = {};
  for (const [key, child] of Object.entries(value)) out[key] = withLocation(child, location);
  return out;
}

// ---------------------------------------------------------------------------
// Category selection
// ---------------------------------------------------------------------------

function assertCloud(connection: Connection): void {
  if (connection.surface === 'cloud') return;
  throw new HetznerError(
    `There is no pricing endpoint on ${SURFACE_LABELS[connection.surface]}, and connection \`${connection.name}\` is on it.`,
    'surface_mismatch',
    'Only Hetzner Cloud publishes machine-readable prices. Account Storage Boxes and Robot dedicated servers are billable but Hetzner publishes their prices only on its website, so this tool has nothing to read for them.',
  );
}

/**
 * The category asked for, whether by name or by the operation that would open
 * the bill.
 *
 * Both at once is refused rather than silently resolved: a caller who gave two
 * different answers to the same question has a wrong belief about one of them,
 * and picking one hides which.
 */
function readCategory(args: Record<string, unknown>): string | undefined {
  const category = optionalString(args, 'category');
  if (category !== undefined && !CATEGORIES.includes(category)) {
    throw new HetznerError(
      `\`category\` "${category}" is not a price category.`,
      'validation',
      `Hetzner Cloud publishes exactly: ${CATEGORIES.join(', ')}.`,
    );
  }

  const operation = optionalString(args, 'operation');
  if (operation === undefined) return category;

  const resolved = getPricingCategory(operation);
  if (resolved === undefined) {
    const known = getOperation(operation) !== undefined;
    throw new HetznerError(
      known
        ? `Operation \`${operation}\` has no published price category.`
        : `There is no operation \`${operation}\` in the catalog.`,
      'validation',
      known
        ? `Operations with a price category: ${[...PRICING_CATEGORY_BY_OPERATION.keys()].join(', ')}. Everything else either costs nothing or is billed on a surface Hetzner publishes no prices for.`
        : 'search_operations lists the operation ids this server knows.',
    );
  }
  if (category !== undefined && category !== resolved) {
    throw new HetznerError(
      `\`category: "${category}"\` and \`operation: "${operation}"\` disagree.`,
      'validation',
      `\`${operation}\` is priced under \`${resolved}\`.`,
    );
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

export const getPricingTool: ToolDef = {
  name: 'get_pricing',
  description:
    'Return the prices Hetzner Cloud publishes: ' +
    `${CATEGORIES.join(', ')}, together with the currency and the VAT rate. ` +
    'Every figure comes as a net and a gross pair, and vat_rate is the percentage between them. ' +
    'The full payload is a price row per server type per location, so `category`, `location`, or an `operation` id whose bill maps to a category narrow it. ' +
    'Hetzner publishes no prices for the account API or for Robot dedicated servers; a request on those connections is refused rather than sent.',
  annotations: {
    title: 'Get pricing',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  surface: 'read',
  apiSurfaces: ['cloud'],
  inputSchema: (cfg) => ({
    category: z
      .enum(CATEGORIES)
      .describe(
        `One price category. server_types, load_balancer_types, primary_ips and floating_ips are priced per location; ${LOCATIONLESS.join(', ')} are priced per project and carry no location. Omitted, all seven are returned.`,
      )
      .optional(),
    location: z
      .string()
      .regex(LOCATION_PATTERN)
      .describe(
        'A Hetzner location name, e.g. fsn1, nbg1, hel1, ash, hil or sin. Keeps only the price rows for that location, and drops rows that are not sold there. Categories priced per project are unaffected.',
      )
      .optional(),
    operation: z
      .string()
      .max(120)
      .describe(
        `A catalog operation id that opens a bill, e.g. ${[...PRICING_CATEGORY_BY_OPERATION.keys()].slice(0, 3).join(', ')}. Resolves to the category that quotes that bill, and is refused if it disagrees with an explicit category.`,
      )
      .optional(),
    ...connectionProperty(cfg),
  }),
  handler: async (args, cfg, extra) =>
    runTool(async () => {
      const connection = resolveConnection(args, cfg);
      assertCloud(connection);

      const category = readCategory(args);
      const location = optionalString(args, 'location');
      if (location !== undefined && !LOCATION_PATTERN.test(location)) {
        throw new HetznerError(
          `\`location\` "${location}" is not a location name.`,
          'validation',
          'Locations are short lowercase slugs such as fsn1 or ash; list_locations reports the ones this project can use.',
        );
      }

      const response = await request({
        connection,
        method: 'GET',
        path: '/pricing',
        operationId: 'get_pricing',
        signal: extra.signal,
      });

      const pricing = toRecord(toRecord(response.data)['pricing']);
      if (Object.keys(pricing).length === 0) {
        throw new HetznerError(
          'Hetzner returned no pricing object.',
          'unknown',
          'GET /pricing answers with a `pricing` key; a response without one means something other than the Hetzner Cloud API replied.',
        );
      }

      const selected = category === undefined ? CATEGORIES : [category];
      const missing = selected.filter((key) => pricing[key] === undefined);
      if (category !== undefined && missing.length > 0) {
        throw new HetznerError(
          `Hetzner's pricing response has no \`${category}\` category.`,
          'not_found',
          `It returned: ${Object.keys(pricing).join(', ')}.`,
        );
      }

      if (location !== undefined) {
        const available = new Set<string>();
        for (const key of selected) collectLocations(pricing[key], available);
        if (available.size > 0 && !available.has(location)) {
          // Filtering to an unknown location would answer with empty arrays,
          // which reads as "nothing costs anything here" rather than "that is
          // not a location these categories are priced in".
          throw new HetznerError(
            `No price row names location \`${location}\`.`,
            'not_found',
            `Priced locations in ${category === undefined ? 'this response' : `\`${category}\``}: ${[...available].sort().join(', ')}.`,
          );
        }
      }

      const currency = typeof pricing['currency'] === 'string' ? pricing['currency'] : 'EUR';
      const data: Row = { currency, vat_rate: pricing['vat_rate'] };
      for (const key of selected) {
        const value = pricing[key];
        if (value === undefined) continue;
        if (location === undefined || LOCATIONLESS.includes(key)) {
          data[key] = value;
          continue;
        }
        data[key] = withLocation(value, location) ?? [];
      }

      const notes: string[] = [
        category === undefined
          ? `All ${selected.length} price categories Hetzner Cloud publishes.`
          : `The \`${category}\` price category.`,
      ];
      if (location !== undefined) {
        const unaffected = selected.filter((key) => LOCATIONLESS.includes(key));
        notes.push(
          `Restricted to location ${location}; rows not sold there are absent.` +
            (unaffected.length > 0
              ? ` ${unaffected.join(', ')} are priced per project rather than per location and are returned whole.`
              : ''),
        );
      }
      notes.push(
        `Prices are in ${currency}. Each figure carries a net and a gross value: gross includes the ${String(pricing['vat_rate'] ?? 'stated')}% VAT rate in vat_rate, net excludes it, and gross is what the invoice charges.`,
        "These are Hetzner's published list prices at the time of this call; they do not include anything already running on this project.",
      );

      const meta: EnvelopeMeta = {
        connection: connection.name,
        surface: connection.surface,
        count: selected.filter((key) => data[key] !== undefined).length,
        hint: notes.join(' '),
      };

      return renderEnvelope(shapeResponse(data, meta, { prunable: PRICING_PRUNABLE }));
    }),
};
