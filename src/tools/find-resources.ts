/**
 * find_resources — the door every other resource tool is reached through.
 *
 * A Hetzner id is a small integer that appears nowhere in a conversation until
 * something lists it, so without this tool the model holds a set of tools it can
 * never call. Everything downstream — get_resource, the control tools, the
 * generic execute doors — takes an id this tool produced.
 *
 * Three things make this harder than the equivalent tool in the sibling product:
 *
 *   - There is no single "list everything" endpoint. Hetzner has one list
 *     endpoint per resource type, so a search across types is N requests, and a
 *     search across types AND connections is N x M. The breadth is therefore
 *     planned and CAPPED rather than issued blindly, and the cap is reported.
 *   - Ids are numeric and are NOT unique across types: id 42 can be a server and
 *     a volume at the same time. Every row therefore carries its `type` and its
 *     `connection` beside the id, because the id alone does not identify
 *     anything.
 *   - Hetzner filters server-side, properly. `name=` is an exact match and
 *     `label_selector=` is the idiomatic way to find things in this API, so both
 *     are passed through to the API rather than reimplemented over a full fetch.
 *
 * No parameter here accepts a URL, a host or a credential. `connection` is an
 * enum over the configured names, and every path is built from the table below,
 * so there is no schema position into which "point at another host" can be
 * written.
 */

import { z } from 'zod';

import { getOperation } from '../catalog/index.js';
import { request } from '../http/client.js';
import {
  DEFAULT_PER_PAGE,
  MAX_PER_PAGE,
  applySkip,
  firstPage,
  nextPageCursor,
  resumeCursor,
  toQuery,
  type CursorState,
} from '../shaping/cursor.js';
import type { Row } from '../shaping/project.js';
import { HetznerError, SURFACE_LABELS } from '../types.js';
import type { Connection, OperationFamily, ServerConfig, Surface, ToolDef } from '../types.js';
import {
  ALL_CONNECTIONS,
  connectionProperty,
  optionalNumber,
  optionalString,
  renderEnvelope,
  resolveConnectionFanOut,
  runTool,
  shapeResponse,
  toRecord,
  type EnvelopeMeta,
} from './shared.js';

// ---------------------------------------------------------------------------
// The resource table
// ---------------------------------------------------------------------------

/**
 * Every resource type reachable through the promoted read tools.
 *
 * Ordered by how often a person looking for "a thing" means that thing, because
 * this order is also the priority in which lookups are kept when the fan-out is
 * capped.
 */
export const RESOURCE_TYPES = [
  'server',
  'volume',
  'load_balancer',
  'network',
  'firewall',
  'floating_ip',
  'primary_ip',
  'zone',
  'ssh_key',
  'certificate',
  'placement_group',
  'image',
  'storage_box',
] as const;

export type ResourceType = (typeof RESOURCE_TYPES)[number];

export interface ResourceSpec {
  surface: Surface;
  /** Collection path, e.g. "/servers". */
  listPath: string;
  /** Key the collection arrives under, e.g. "servers". */
  listKey: string;
  listOperationId: string;
  /** Key one record arrives under, e.g. "server". */
  itemKey: string;
  getOperationId: string;
  /** Family, for the projection defaults the shaping layer already knows. */
  family: OperationFamily;
  /**
   * Searched when `resource_type` is omitted.
   *
   * Images are excluded: the image list includes every public system image
   * Hetzner publishes, so folding it into an unqualified search buries the two
   * snapshots the caller owns under a hundred rows of Ubuntu.
   */
  inDefaultSearch: boolean;
  /**
   * `GET /zones/{id_or_name}` takes a domain name directly. Every other type
   * demands the numeric id, and forcing a lookup to turn "example.com" into
   * `4711` would be a round trip spent on nothing.
   */
  addressableByName?: boolean;
}

export const RESOURCE_SPECS: Readonly<Record<ResourceType, ResourceSpec>> = {
  server: {
    surface: 'cloud',
    listPath: '/servers',
    listKey: 'servers',
    listOperationId: 'list_servers',
    itemKey: 'server',
    getOperationId: 'get_server',
    family: 'servers',
    inDefaultSearch: true,
  },
  volume: {
    surface: 'cloud',
    listPath: '/volumes',
    listKey: 'volumes',
    listOperationId: 'list_volumes',
    itemKey: 'volume',
    getOperationId: 'get_volume',
    family: 'volumes',
    inDefaultSearch: true,
  },
  load_balancer: {
    surface: 'cloud',
    listPath: '/load_balancers',
    listKey: 'load_balancers',
    listOperationId: 'list_load_balancers',
    itemKey: 'load_balancer',
    getOperationId: 'get_load_balancer',
    family: 'load-balancers',
    inDefaultSearch: true,
  },
  network: {
    surface: 'cloud',
    listPath: '/networks',
    listKey: 'networks',
    listOperationId: 'list_networks',
    itemKey: 'network',
    getOperationId: 'get_network',
    family: 'networks',
    inDefaultSearch: true,
  },
  firewall: {
    surface: 'cloud',
    listPath: '/firewalls',
    listKey: 'firewalls',
    listOperationId: 'list_firewalls',
    itemKey: 'firewall',
    getOperationId: 'get_firewall',
    family: 'firewalls',
    inDefaultSearch: true,
  },
  floating_ip: {
    surface: 'cloud',
    listPath: '/floating_ips',
    listKey: 'floating_ips',
    listOperationId: 'list_floating_ips',
    itemKey: 'floating_ip',
    getOperationId: 'get_floating_ip',
    family: 'floating-ips',
    inDefaultSearch: true,
  },
  primary_ip: {
    surface: 'cloud',
    listPath: '/primary_ips',
    listKey: 'primary_ips',
    listOperationId: 'list_primary_ips',
    itemKey: 'primary_ip',
    getOperationId: 'get_primary_ip',
    family: 'primary-ips',
    inDefaultSearch: true,
  },
  zone: {
    surface: 'cloud',
    listPath: '/zones',
    listKey: 'zones',
    listOperationId: 'list_zones',
    itemKey: 'zone',
    getOperationId: 'get_zone',
    family: 'zones',
    inDefaultSearch: true,
    addressableByName: true,
  },
  ssh_key: {
    surface: 'cloud',
    listPath: '/ssh_keys',
    listKey: 'ssh_keys',
    listOperationId: 'list_ssh_keys',
    itemKey: 'ssh_key',
    getOperationId: 'get_ssh_key',
    family: 'ssh-keys',
    inDefaultSearch: true,
  },
  certificate: {
    surface: 'cloud',
    listPath: '/certificates',
    listKey: 'certificates',
    listOperationId: 'list_certificates',
    itemKey: 'certificate',
    getOperationId: 'get_certificate',
    family: 'certificates',
    inDefaultSearch: true,
  },
  placement_group: {
    surface: 'cloud',
    listPath: '/placement_groups',
    listKey: 'placement_groups',
    listOperationId: 'list_placement_groups',
    itemKey: 'placement_group',
    getOperationId: 'get_placement_group',
    family: 'placement-groups',
    inDefaultSearch: true,
  },
  image: {
    surface: 'cloud',
    listPath: '/images',
    listKey: 'images',
    listOperationId: 'list_images',
    itemKey: 'image',
    getOperationId: 'get_image',
    family: 'images',
    inDefaultSearch: false,
  },
  storage_box: {
    surface: 'hetzner',
    listPath: '/storage_boxes',
    listKey: 'storage_boxes',
    listOperationId: 'list_storage_boxes',
    itemKey: 'storage_box',
    getOperationId: 'get_storage_box',
    family: 'storage-boxes',
    inDefaultSearch: true,
  },
};

/**
 * Derived, never written out.
 *
 * A surface added to the table later starts being offered by both read tools
 * without anyone remembering to update a second list — which is the failure mode
 * a hand-maintained `['cloud', 'hetzner']` has.
 */
export const RESOURCE_SURFACES: readonly Surface[] = [
  ...new Set(RESOURCE_TYPES.map((type) => RESOURCE_SPECS[type].surface)),
];

export function specFor(type: ResourceType): ResourceSpec {
  return RESOURCE_SPECS[type];
}

export function readResourceType(
  args: Record<string, unknown>,
  key = 'resource_type',
): ResourceType {
  const raw = optionalString(args, key);
  if (raw === undefined) {
    throw new HetznerError(
      `\`${key}\` is required.`,
      'validation',
      `One of: ${RESOURCE_TYPES.join(', ')}. A Hetzner id is a plain integer and the same integer can be a server and a volume at once, so the type is what makes it address one resource.`,
    );
  }
  if (!(RESOURCE_TYPES as readonly string[]).includes(raw)) {
    throw new HetznerError(
      `\`${key}\` must be one of: ${RESOURCE_TYPES.join(', ')}.`,
      'validation',
      'find_resources reports the type of every resource it lists.',
    );
  }
  return raw as ResourceType;
}

/** Types this connection's surface can actually serve, in table order. */
function typesOn(surface: Surface, requested: ResourceType | undefined): ResourceType[] {
  const candidates =
    requested === undefined
      ? RESOURCE_TYPES.filter((type) => RESOURCE_SPECS[type].inDefaultSearch)
      : [requested];
  return candidates.filter((type) => RESOURCE_SPECS[type].surface === surface);
}

// ---------------------------------------------------------------------------
// Fan-out planning
// ---------------------------------------------------------------------------

/**
 * Ceiling on concurrent list calls per invocation.
 *
 * Twelve types across four connections is 48 requests against a quota of 3600
 * per hour that every other client using the same token shares. The cap is what
 * stops one exploratory question from spending a noticeable slice of it — and
 * because a silently capped search reads as "that is everything", whatever it
 * cuts is named in `meta.hint`.
 */
export const MAX_LOOKUPS = 12;

interface Lookup {
  connection: Connection;
  type: ResourceType;
}

interface Plan {
  lookups: Lookup[];
  /** Planned but not run, in the order they were dropped. */
  skipped: Lookup[];
}

/**
 * Interleaved by type index across connections, then truncated.
 *
 * Taking the first MAX_LOOKUPS in connection-major order would spend the entire
 * budget on the first connection and never touch the second, which turns a fleet
 * search into a single-connection search that does not say so.
 */
function planLookups(targets: readonly Connection[], requested: ResourceType | undefined): Plan {
  const perConnection = targets.map((connection) => ({
    connection,
    types: typesOn(connection.surface, requested),
  }));
  const depth = Math.max(0, ...perConnection.map((entry) => entry.types.length));

  const ordered: Lookup[] = [];
  for (let index = 0; index < depth; index++) {
    for (const entry of perConnection) {
      const type = entry.types[index];
      if (type !== undefined) ordered.push({ connection: entry.connection, type });
    }
  }
  return { lookups: ordered.slice(0, MAX_LOOKUPS), skipped: ordered.slice(MAX_LOOKUPS) };
}

function describeLookups(lookups: readonly Lookup[], max = 6): string {
  const shown = lookups
    .slice(0, max)
    .map((lookup) => `${lookup.type} on ${lookup.connection.name}`);
  const rest = lookups.length - shown.length;
  return rest > 0 ? `${shown.join(', ')} and ${rest} more` : shown.join(', ');
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

interface Filters {
  /** Free text, lower-cased, matched locally against the name. */
  query?: string;
  /** Exact name, handed to Hetzner's `name=`. */
  name?: string;
  /** Handed to Hetzner's `label_selector=` verbatim. */
  labelSelector?: string;
  type?: ResourceType;
}

function readFilters(args: Record<string, unknown>): Filters {
  const type = optionalString(args, 'resource_type');
  return {
    query: optionalString(args, 'query')?.toLowerCase(),
    name: optionalString(args, 'name'),
    labelSelector: optionalString(args, 'label_selector'),
    type: type === undefined ? undefined : readResourceType(args),
  };
}

/** The frozen non-paging arguments a cursor carries, so a resume needs no re-supply. */
function cursorQuery(filters: Filters): Record<string, string> {
  const query: Record<string, string> = {};
  if (filters.query !== undefined) query['query'] = filters.query;
  if (filters.name !== undefined) query['name'] = filters.name;
  if (filters.labelSelector !== undefined) query['label_selector'] = filters.labelSelector;
  return query;
}

/**
 * The only filtering done in this process.
 *
 * Hetzner's list endpoints match `name` exactly and have no substring or
 * wildcard form, so a free-text search is either "fetch the page and look" or
 * nothing at all. It runs against the page Hetzner already returned rather than
 * against the whole collection: filtering the whole collection would mean paging
 * through it first, and a search that costs twenty requests before it answers is
 * not a search anyone will use twice.
 */
function matchesQuery(raw: Row, needle: string): boolean {
  const name = raw['name'];
  return typeof name === 'string' && name.toLowerCase().includes(needle);
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

function isRow(value: unknown): value is Row {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The projected row.
 *
 * `type`, `connection` and `surface` are not decoration: a numeric id is
 * meaningless without all three, because the same integer identifies different
 * resources in different types and in different projects. Every other tool takes
 * exactly this triple plus the id, so a row is directly actionable and nothing
 * needs a second lookup to become one.
 */
function buildRow(raw: Row, lookup: Lookup): Row {
  const row: Row = {
    id: raw['id'],
    name: raw['name'],
    type: lookup.type,
    surface: lookup.connection.surface,
    connection: lookup.connection.name,
  };
  const status = raw['status'];
  if (typeof status === 'string') row['status'] = status;
  const labels = raw['labels'];
  if (isRow(labels) && Object.keys(labels).length > 0) row['labels'] = labels;
  return row;
}

/** Identity first, so the ladder sacrifices context before it sacrifices the id. */
const ROW_PRUNABLE: readonly string[] = ['labels', 'status'];

function sortKey(row: Row): string {
  return [
    String(row['connection'] ?? ''),
    String(row['type'] ?? ''),
    String(row['name'] ?? '').toLowerCase(),
    String(row['id'] ?? '').padStart(12, '0'),
  ].join(' ');
}

// ---------------------------------------------------------------------------
// One lookup
// ---------------------------------------------------------------------------

interface LookupResult {
  rows: Row[];
  /** Rows on the upstream page BEFORE local filtering — what paging is decided on. */
  fetched: number;
  cursor?: CursorState;
  nextCursor?: string;
  total?: number;
}

async function runLookup(
  lookup: Lookup,
  filters: Filters,
  cursor: CursorState | undefined,
  perPage: number,
  signal: AbortSignal | undefined,
): Promise<LookupResult> {
  const spec = RESOURCE_SPECS[lookup.type];
  // The catalog is the authority on whether an endpoint takes page/per_page.
  // Sending them to one that does not is at best ignored and at worst a 400.
  const paginated = getOperation(spec.listOperationId)?.paginated === true;

  const query: Record<string, string | number | undefined> = {
    name: filters.name,
    label_selector: filters.labelSelector,
  };
  if (paginated) {
    const paging = cursor === undefined ? { page: 1, per_page: perPage } : toQuery(cursor);
    query['page'] = paging.page;
    query['per_page'] = paging.per_page;
  }

  const response = await request({
    connection: lookup.connection,
    method: 'GET',
    path: spec.listPath,
    query,
    operationId: spec.listOperationId,
    signal,
  });

  const body = toRecord(response.data);
  const collection = body[spec.listKey];
  const fetched = Array.isArray(collection) ? collection.filter(isRow) : [];

  const rows = applySkip(fetched, cursor)
    .filter((raw) => filters.query === undefined || matchesQuery(raw, filters.query))
    .map((raw) => buildRow(raw, lookup));

  const result: LookupResult = { rows, fetched: fetched.length };
  if (cursor !== undefined) {
    result.cursor = cursor;
    // Decided on the upstream row count, never on the filtered one: a page that
    // local filtering emptied is not the end of the collection, and treating it
    // as one would silently drop everything after it.
    result.nextCursor = nextPageCursor(cursor, response.pagination, fetched.length);
    result.total = response.pagination?.totalEntries;
  }
  return result;
}

/** Cursors are per type, so one minted over servers cannot page volumes. */
function cursorOp(type: ResourceType): string {
  return `find_resources:${type}`;
}

function eligibleConnections(cfg: ServerConfig): number {
  return [...cfg.registry.connections.values()].filter((connection) =>
    RESOURCE_SURFACES.includes(connection.surface),
  ).length;
}

function clampPerPage(value: number): number {
  if (!Number.isFinite(value) || value < 1) return DEFAULT_PER_PAGE;
  return Math.min(Math.trunc(value), MAX_PER_PAGE);
}

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

interface Collected {
  rows: Row[];
  errors: Array<{ connection: string; message: string }>;
  /** A caller who went away is not a fan-out failure, but it is not a result either. */
  cancelled?: HetznerError;
  attempted: number;
  failed: number;
}

function failureMessage(lookup: Lookup, error: unknown): string {
  const detail =
    error instanceof HetznerError || error instanceof Error
      ? error.message
      : 'the lookup failed with a non-Error value';
  return `${lookup.type}: ${detail}`;
}

// ---------------------------------------------------------------------------
// The tool
// ---------------------------------------------------------------------------

/** Per lookup when several run, so a wide search does not return 300 rows. */
const MULTI_LOOKUP_PER_PAGE = 10;

const LABEL_SELECTOR_SYNTAX =
  '`env=prod` (equals), `env!=prod` (not equals), `env in (prod,staging)`, `env notin (dev)`, `env` (key present), `!env` (key absent); comma-separated terms are ANDed.';

export const findResourcesTool: ToolDef = {
  name: 'find_resources',
  description:
    'Find Hetzner resources by name, by label selector or by listing a type, across one connection or every configured connection. ' +
    `Covers ${RESOURCE_TYPES.join(', ')}. ` +
    'Each row carries id, name, type, surface and connection, plus status and labels where the resource has them. ' +
    'This is where numeric ids come from: get_resource and the control tools all take an id together with its resource_type and connection, because the same integer identifies different resources in different types and different projects. ' +
    'For the complete stored configuration of one resource use get_resource.',
  annotations: {
    title: 'Find resources',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  surface: 'read',
  apiSurfaces: RESOURCE_SURFACES,
  inputSchema: (cfg) => ({
    query: z
      .string()
      .max(200)
      .optional()
      .describe(
        'Case-insensitive substring matched against the resource name. Applied to the rows Hetzner returns for this page, since its list endpoints match names exactly and offer no substring form.',
      ),
    name: z
      .string()
      .max(253)
      .optional()
      .describe(
        'Exact name, filtered by Hetzner itself. Names are unique per project and per type, so this returns at most one row per type per connection.',
      ),
    label_selector: z
      .string()
      .max(400)
      .optional()
      .describe(
        `Hetzner label selector, filtered by Hetzner itself: ${LABEL_SELECTOR_SYNTAX} Labels are Hetzner's own grouping mechanism and every type in this tool supports them.`,
      ),
    resource_type: z
      .enum(RESOURCE_TYPES)
      .optional()
      .describe(
        `Search only this type. Omitted, the search covers ${RESOURCE_TYPES.filter((type) => RESOURCE_SPECS[type].inDefaultSearch).join(', ')} — image is searched only when named here, because the image list contains every public system image Hetzner publishes.`,
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_PER_PAGE)
      .optional()
      .describe(
        `Rows per type per connection, ${MAX_PER_PAGE} maximum (Hetzner's per_page ceiling). Defaults to ${DEFAULT_PER_PAGE} when one type on one connection is searched and ${MULTI_LOOKUP_PER_PAGE} when several are.`,
      ),
    cursor: z
      .string()
      .optional()
      .describe(
        "Opaque cursor from a previous call's meta.next_cursor. Minted only when resource_type names one type and the search runs against one connection.",
      ),
    // `allowAll` only when there is something to fan out ACROSS. With one
    // eligible connection `"*"` and that connection's name are the same search,
    // and offering both would keep a parameter alive that has no decision in it.
    ...connectionProperty(cfg, {
      allowAll: eligibleConnections(cfg) > 1,
      surfaces: RESOURCE_SURFACES,
    }),
  }),
  handler: async (args, cfg, extra) =>
    runTool(async () => {
      const filters = readFilters(args);
      const targets = resolveConnectionFanOut(args, cfg, { surfaces: RESOURCE_SURFACES });
      const fanOut = optionalString(args, 'connection') === ALL_CONNECTIONS;

      const plan = planLookups(targets, filters.type);
      if (plan.lookups.length === 0) {
        throw new HetznerError(
          filters.type === undefined
            ? 'None of the configured connections can serve this search.'
            : `\`${filters.type}\` lives on ${SURFACE_LABELS[RESOURCE_SPECS[filters.type].surface]}, and no connection in this search is on that surface.`,
          'surface_mismatch',
          `Connections in this search: ${targets.map((c) => `${c.name} (${SURFACE_LABELS[c.surface]})`).join(', ')}.`,
        );
      }

      const single = plan.lookups.length === 1;
      const only = plan.lookups[0] as Lookup;
      const requestedLimit = optionalNumber(args, 'limit');
      // Clamped rather than rejected. An oversized page size is a harmless
      // misjudgement and Hetzner's own ceiling is 50; failing the call over it
      // would spend a turn to teach the caller a number the schema already says.
      const perPage = clampPerPage(
        requestedLimit ?? (single ? DEFAULT_PER_PAGE : MULTI_LOOKUP_PER_PAGE),
      );

      const rawCursor = optionalString(args, 'cursor');
      if (rawCursor !== undefined && !single) {
        throw new HetznerError(
          'This cursor cannot be resumed: the current arguments search several type-and-connection combinations.',
          'validation',
          'A cursor pages one Hetzner list endpoint on one connection, so meta.next_cursor is only minted when resource_type names one type and the search runs against a single connection.',
        );
      }
      // Only the single-lookup case gets a cursor at all: page numbers on N
      // interleaved collections cannot be expressed in one token without
      // inventing a merge order Hetzner does not have.
      const cursor = !single
        ? undefined
        : rawCursor !== undefined
          ? resumeCursor(rawCursor, { op: cursorOp(only.type), connection: only.connection.name })
          : firstPage({
              op: cursorOp(only.type),
              connection: only.connection.name,
              perPage,
              query: cursorQuery(filters),
            });

      const collected = await collect(plan.lookups, filters, cursor, perPage, extra.signal);

      // Everything we did was cancelled and nothing came back: reporting an
      // empty fleet would be a confident answer to a question nobody is still
      // waiting for.
      if (collected.rows.length === 0 && collected.errors.length === 0 && collected.cancelled) {
        throw collected.cancelled;
      }

      collected.rows.sort((left, right) => {
        const a = sortKey(left);
        const b = sortKey(right);
        return a < b ? -1 : a > b ? 1 : 0;
      });

      const allFailed = collected.failed === collected.attempted && collected.attempted > 0;
      const meta: EnvelopeMeta = {
        connection: fanOut ? ALL_CONNECTIONS : only.connection.name,
        surface: uniformSurface(plan.lookups),
        hint: composeHint({ plan, collected, filters, perPage, single, allFailed }),
      };
      if (cursor !== undefined) meta.cursor = cursor;
      if (collected.lookupTotal !== undefined) meta.total = collected.lookupTotal;
      if (collected.nextCursor !== undefined) meta.next_cursor = collected.nextCursor;
      if (collected.errors.length > 0) meta.errors = collected.errors;

      const result = renderEnvelope(
        shapeResponse(collected.rows, meta, { prunable: ROW_PRUNABLE }),
      );
      // An empty list because nothing answered is not "nothing exists", and it
      // is the one wrong answer here that reads as a confident one.
      return allFailed ? { ...result, isError: true } : result;
    }),
};

interface CollectedPage extends Collected {
  nextCursor?: string;
  lookupTotal?: number;
}

/**
 * Every lookup at once, with the origin attached while the results are still
 * separated — the connection and type a row came from cannot be recovered once
 * the arrays are flattened.
 *
 * `allSettled`, so one unreachable project reports itself in `meta.errors` next
 * to the rows that did come back rather than taking the whole answer down.
 */
async function collect(
  lookups: readonly Lookup[],
  filters: Filters,
  cursor: CursorState | undefined,
  perPage: number,
  signal: AbortSignal | undefined,
): Promise<CollectedPage> {
  const settled = await Promise.allSettled(
    lookups.map((lookup) => runLookup(lookup, filters, cursor, perPage, signal)),
  );

  const out: CollectedPage = { rows: [], errors: [], attempted: lookups.length, failed: 0 };
  settled.forEach((outcome, index) => {
    const lookup = lookups[index];
    if (lookup === undefined) return;
    if (outcome.status === 'rejected') {
      out.failed += 1;
      const reason: unknown = outcome.reason;
      if (reason instanceof HetznerError && reason.kind === 'cancelled') {
        // Deliberately NOT an entry in meta.errors: the caller went away, which
        // is a fact about the caller and not a fault in their fleet.
        out.cancelled ??= reason;
        return;
      }
      out.errors.push({
        connection: lookup.connection.name,
        message: failureMessage(lookup, reason),
      });
      return;
    }
    out.rows.push(...outcome.value.rows);
    if (outcome.value.nextCursor !== undefined) out.nextCursor = outcome.value.nextCursor;
    if (outcome.value.total !== undefined) out.lookupTotal = outcome.value.total;
  });
  return out;
}

function uniformSurface(lookups: readonly Lookup[]): Surface | undefined {
  const surfaces = new Set(lookups.map((lookup) => lookup.connection.surface));
  return surfaces.size === 1 ? lookups[0]?.connection.surface : undefined;
}

interface HintInput {
  plan: Plan;
  collected: CollectedPage;
  filters: Filters;
  perPage: number;
  single: boolean;
  allFailed: boolean;
}

/**
 * Facts about what was searched and what was not.
 *
 * The capped-fan-out sentence is the load-bearing one. A search that quietly
 * stopped after twelve lookups and reported four rows reads as "you have four
 * resources", and a caller acting on that will conclude something is missing
 * that was never looked for.
 */
function composeHint(input: HintInput): string {
  const notes: string[] = [];
  const { plan, collected, filters, single } = input;

  if (input.allFailed) {
    notes.push(
      `No lookup answered: all ${collected.attempted} failed. The rows below are not an empty fleet, they are the absence of an answer — see meta.errors.`,
    );
  } else if (single) {
    const only = plan.lookups[0] as Lookup;
    notes.push(`Searched ${only.type} on connection ${only.connection.name}.`);
  } else {
    const connections = new Set(plan.lookups.map((lookup) => lookup.connection.name));
    notes.push(
      `Searched ${plan.lookups.length} type-and-connection combinations across ${connections.size} connection(s), up to ${input.perPage} rows each.`,
    );
  }

  if (plan.skipped.length > 0) {
    notes.push(
      `Capped at ${MAX_LOOKUPS} list calls per invocation, so ${plan.skipped.length} combination(s) were not searched: ${describeLookups(plan.skipped)}. Anything there is absent from these rows. resource_type and connection narrow a search to a single combination.`,
    );
  }

  if (filters.query !== undefined) {
    notes.push(
      'query is matched in this process against the names on the page Hetzner returned; name and label_selector are matched by Hetzner across the whole collection.',
    );
  }

  if (!single && collected.rows.length > 0) {
    notes.push('No cursor is issued for a multi-type or multi-connection search.');
  }

  notes.push('These rows are a projection; get_resource returns the full record for one id.');
  return notes.join(' ');
}
