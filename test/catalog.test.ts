/**
 * The generated catalog.
 *
 * Everything here is a property of code a generator emits, which is precisely
 * why it needs tests: a regeneration against a newer Hetzner spec can change any
 * of it, and the whole safety model downstream — which generic door exists, what
 * `search_operations` shows a model, what the transport refuses — is computed
 * from these rows.
 *
 * Three properties matter more than the rest:
 *
 *  1. EVERY DELETE IS DESTRUCTIVE, and so are the four operations that are not
 *     DELETEs but destroy data anyway. "Block the DELETEs" misses a rebuild that
 *     wipes a disk and a snapshot rollback that Hetzner's own text calls
 *     irrevocable.
 *  2. THE SURFACE TRAVELS WITH EVERY ROW. A cloud Server and a Robot server are
 *     different machines on different hosts with different billing; an operation
 *     that lost its surface would be executed against whichever base URL
 *     happened to be default.
 *  3. IDS ARE UNIQUE ACROSS SURFACES. The tool layer addresses operations by id
 *     alone, so a collision would make one of the two silently unreachable.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  METADATA,
  PRICING_CATEGORY_BY_OPERATION,
  getOperation,
  getPricingCategory,
  getSchema,
  listFamilies,
  listSurfaces,
  operationCount,
  searchOperations,
} from '../src/catalog/index.js';
import { CATALOG } from '../src/generated/catalog.js';
import { SURFACES } from '../src/types.js';
import type { CatalogOperation, DangerClass, OperationFamily, Surface } from '../src/types.js';

/** Pinned in the generator too. Duplicated here so a bad refresh fails twice. */
const EXPECTED_CLOUD_OPERATIONS = 189;
const EXPECTED_ACCOUNT_OPERATIONS = 32;

/**
 * The hand-maintained destructive overrides, by route. Written out again rather
 * than imported from the generator: a test that read the same list the
 * classifier reads would agree with it by construction and prove nothing.
 */
const DESTRUCTIVE_OVERRIDES: ReadonlyArray<readonly [Surface, string, string]> = [
  ['cloud', 'rebuild_server', 'POST /servers/{id}/actions/rebuild'],
  ['cloud', 'import_zone_zonefile', 'POST /zones/{id_or_name}/actions/import_zonefile'],
  [
    'cloud',
    'set_zone_rrset_records',
    'POST /zones/{id_or_name}/rrsets/{rr_name}/{rr_type}/actions/set_records',
  ],
  [
    'hetzner',
    'rollback_storage_box_snapshot',
    'POST /storage_boxes/{id}/actions/rollback_snapshot',
  ],
];

const COSTLY_ROUTES: ReadonlyArray<readonly [Surface, string]> = [
  ['cloud', 'POST /servers'],
  ['cloud', 'POST /volumes'],
  ['cloud', 'POST /load_balancers'],
  ['cloud', 'POST /floating_ips'],
  ['cloud', 'POST /primary_ips'],
  ['cloud', 'POST /servers/{id}/actions/create_image'],
  ['cloud', 'POST /servers/{id}/actions/enable_backup'],
  ['cloud', 'POST /servers/{id}/actions/change_type'],
  ['cloud', 'POST /load_balancers/{id}/actions/change_type'],
  ['cloud', 'POST /volumes/{id}/actions/resize'],
  ['hetzner', 'POST /storage_boxes'],
  ['hetzner', 'POST /storage_boxes/{id}/actions/change_type'],
];

const DANGER_CLASSES: readonly DangerClass[] = ['safe', 'write', 'destructive'];

const FAMILIES: readonly OperationFamily[] = [
  'servers',
  'server-types',
  'images',
  'ssh-keys',
  'volumes',
  'networks',
  'firewalls',
  'load-balancers',
  'floating-ips',
  'primary-ips',
  'certificates',
  'placement-groups',
  'zones',
  'actions',
  'datacenters',
  'locations',
  'isos',
  'pricing',
  'storage-boxes',
  'robot-servers',
  'robot-ips',
  'robot-boot',
  'robot-storage-boxes',
  'robot-ordering',
  'other',
];

function ids(rows: readonly CatalogOperation[]): string[] {
  return rows.map((row) => row.id);
}

function routeOf(operation: CatalogOperation): string {
  return `${operation.method} ${operation.path}`;
}

function findByRoute(surface: Surface, route: string): CatalogOperation | undefined {
  return CATALOG.find((row) => row.surface === surface && routeOf(row) === route);
}

// ---------------------------------------------------------------------------
// Reading the vendored specs
// ---------------------------------------------------------------------------

interface VendoredSpec {
  paths: Record<string, Record<string, unknown>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readSpec(file: string): VendoredSpec {
  const path = fileURLToPath(new URL(`../scripts/${file}`, import.meta.url));
  return JSON.parse(readFileSync(path, 'utf8')) as VendoredSpec;
}

/** Minimal local `$ref` resolver — enough to walk one response schema. */
function deref(spec: unknown, node: unknown, seen: ReadonlySet<string> = new Set()): unknown {
  if (!isRecord(node)) return node;
  const ref = node['$ref'];
  if (typeof ref !== 'string' || seen.has(ref)) return node;
  let resolved: unknown = spec;
  for (const segment of ref.slice(2).split('/')) {
    if (!isRecord(resolved)) return node;
    resolved = resolved[segment];
  }
  return deref(spec, resolved, new Set([...seen, ref]));
}

/**
 * The billable resource kinds Hetzner itself publishes, taken from the `GET
 * /pricing` response schema in the vendored cloud spec rather than hardcoded.
 * `currency` and `vat_rate` describe the quote, not a resource.
 */
function pricingCategoriesFromSpec(): string[] {
  const spec = readSpec('hetzner-cloud.openapi.json');
  const operation = spec.paths['/pricing']?.['get'];
  const response = deref(spec, isRecord(operation) ? operation['responses'] : undefined);
  const ok = deref(spec, isRecord(response) ? response['200'] : undefined);
  const content = deref(spec, isRecord(ok) ? ok['content'] : undefined);
  const json = deref(spec, isRecord(content) ? content['application/json'] : undefined);
  const envelope = deref(spec, isRecord(json) ? json['schema'] : undefined);
  const envelopeProps = isRecord(envelope) ? envelope['properties'] : undefined;
  const pricing = deref(spec, isRecord(envelopeProps) ? envelopeProps['pricing'] : undefined);
  const properties = isRecord(pricing) ? pricing['properties'] : undefined;

  if (!isRecord(properties)) {
    throw new Error('GET /pricing no longer exposes a pricing object in the vendored cloud spec');
  }
  return Object.keys(properties).filter((key) => key !== 'currency' && key !== 'vat_rate');
}

// ---------------------------------------------------------------------------
// Pinned counts
// ---------------------------------------------------------------------------

describe('pinned counts', () => {
  it('holds per surface', () => {
    // Asserted rather than measured: a generator that adapted to whatever it was
    // fed would emit a half-catalog after a bad spec refresh, and the missing
    // half is indistinguishable from a capability the product never had.
    const cloud = CATALOG.filter((row) => row.surface === 'cloud');
    const account = CATALOG.filter((row) => row.surface === 'hetzner');

    expect(cloud).toHaveLength(EXPECTED_CLOUD_OPERATIONS);
    expect(account).toHaveLength(EXPECTED_ACCOUNT_OPERATIONS);
    expect(CATALOG).toHaveLength(EXPECTED_CLOUD_OPERATIONS + EXPECTED_ACCOUNT_OPERATIONS);
  });

  it('agrees with the metadata the generator wrote', () => {
    expect(METADATA.operationCount).toBe(CATALOG.length);
    expect(operationCount()).toBe(CATALOG.length);

    const counted = METADATA.specs.reduce((total, spec) => total + spec.operationCount, 0);
    expect(counted).toBe(METADATA.operationCount);
  });

  it('records provenance for every surface it shipped', () => {
    // Surfaced on a zero-result search: the likeliest cause of a miss is a
    // catalog older than the API it is describing.
    expect(METADATA.specs.length).toBeGreaterThan(0);
    for (const spec of METADATA.specs) {
      expect(SURFACES).toContain(spec.surface);
      expect(spec.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(spec.version).toMatch(/^\d+\.\d+/);
    }
    expect(Number.isNaN(Date.parse(METADATA.generatedAt))).toBe(false);
  });

  it('leaves robot out until a spec is vendored for it', () => {
    // Deferred, not forgotten. A row claiming `robot` before the transport can
    // speak HTTP Basic to robot-ws.your-server.de would be a promise the server
    // cannot keep.
    expect(CATALOG.some((row) => row.surface === 'robot')).toBe(false);
    expect(listSurfaces().map((row) => row.surface)).toEqual(['cloud', 'hetzner']);
  });
});

// ---------------------------------------------------------------------------
// Every row is well formed
// ---------------------------------------------------------------------------

describe('catalog rows', () => {
  it('carry a valid surface, family and danger class', () => {
    for (const row of CATALOG) {
      expect(SURFACES, row.id).toContain(row.surface);
      expect(FAMILIES, row.id).toContain(row.family);
      expect(DANGER_CLASSES, row.id).toContain(row.danger);
    }
  });

  it('use every danger class, so every generic door has something behind it', () => {
    const classes = new Set<DangerClass>(CATALOG.map((row) => row.danger));

    expect([...classes].sort()).toEqual(['destructive', 'safe', 'write']);
  });

  it('have unique ids across surfaces', () => {
    // The tool layer takes an id, not an (id, surface) pair. A collision would
    // make one of the two unreachable, silently and non-deterministically.
    const seen = new Set(ids(CATALOG));

    expect(seen.size).toBe(CATALOG.length);
  });

  it('list every placeholder their path template contains', () => {
    // The generic executor substitutes from `pathParams`; a placeholder missing
    // from the list would be sent literally and produce an unreadable 404.
    for (const row of CATALOG) {
      const placeholders = [...row.path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
      expect(placeholders.sort(), row.id).toEqual([...row.pathParams].sort());
    }
  });

  it('start every path with a slash and carry no query string', () => {
    for (const row of CATALOG) {
      expect(row.path.startsWith('/'), row.id).toBe(true);
      expect(row.path, row.id).not.toMatch(/[?#]/);
    }
  });

  it('give every operation a summary with no Markdown left in it', () => {
    // Summaries are search text and are rendered per result row. Hetzner writes
    // its prose as Markdown links into its own docs site, which mean nothing
    // once the label is out of that page.
    for (const row of CATALOG) {
      expect(row.summary.trim().length, row.id).toBeGreaterThan(0);
      expect(row.summary, row.id).not.toMatch(/\[[^\]]*\]\(/);
    }
  });

  it('declare no request body on a GET', () => {
    for (const row of CATALOG.filter((operation) => operation.method === 'GET')) {
      expect(row.hasBody, row.id).toBe(false);
    }
  });

  it('only mark pagination where a page parameter exists', () => {
    for (const row of CATALOG) {
      const paginatable = row.queryParams.includes('page') || row.queryParams.includes('per_page');
      expect(row.paginated === true, row.id).toBe(paginatable);
    }
    // The cloud API's list endpoints, per its own documentation.
    const paginated = CATALOG.filter((row) => row.surface === 'cloud' && row.paginated === true);
    expect(paginated).toHaveLength(38);
  });

  it('mark the asynchronous mutations that return an Action', () => {
    // Hetzner mutations mostly return `{ action: { status: 'running' } }` rather
    // than the finished resource. A tool that returned that and stopped would
    // have told the model nothing about whether the work happened.
    expect(getOperation('create_server')?.returnsAction).toBe(true);
    expect(getOperation('reboot_server')?.returnsAction).toBe(true);
    // A pure catalogue read returns no Action. If this flips, the detector has
    // widened into "mentions an action somewhere" and is worthless.
    expect(getOperation('list_server_types')?.returnsAction).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Danger classification — the safety-critical part
// ---------------------------------------------------------------------------

describe('danger classification', () => {
  it('files every DELETE as destructive', () => {
    const deletes = CATALOG.filter((row) => row.method === 'DELETE');

    expect(deletes.length).toBeGreaterThan(0);
    expect(ids(deletes.filter((row) => row.danger !== 'destructive'))).toEqual([]);
  });

  it('files every GET as safe and nothing else', () => {
    // Both directions matter. A GET classified `write` has no door at all, and a
    // non-GET classified `safe` would reach a tool annotated `readOnlyHint`.
    expect(ids(CATALOG.filter((row) => row.method === 'GET' && row.danger !== 'safe'))).toEqual([]);
    expect(ids(CATALOG.filter((row) => row.danger === 'safe' && row.method !== 'GET'))).toEqual([]);
  });

  it.each(DESTRUCTIVE_OVERRIDES)(
    'files the %s route %s as destructive even though it is not a DELETE',
    (surface, id, route) => {
      const operation = findByRoute(surface, route);

      expect(operation, `${surface} ${route} is not in the catalog`).toBeDefined();
      expect(operation?.id).toBe(id);
      expect(operation?.method).not.toBe('DELETE');
      expect(operation?.danger).toBe('destructive');
    },
  );

  it('files nothing else as destructive without being a DELETE', () => {
    // Widening this is a real change to the tool surface, so it should have to
    // be made deliberately rather than arriving with a regeneration.
    const declared = new Set(DESTRUCTIVE_OVERRIDES.map(([, id]) => id));
    const unexpected = CATALOG.filter(
      (row) => row.danger === 'destructive' && row.method !== 'DELETE' && !declared.has(row.id),
    );

    expect(ids(unexpected)).toEqual([]);
  });

  it('leaves the recovery and power verbs as ordinary writes', () => {
    // Gating these would put recovery behind the same flag as the thing being
    // recovered from. `set_firewall_rules` is the only verb for editing rules at
    // all, and the rules are readable beforehand; `reset` and `poweroff` risk
    // unflushed writes but destroy nothing by design.
    for (const id of [
      'set_firewall_rules',
      'reset_server',
      'poweroff_server',
      'enable_server_rescue',
      'change_server_type',
    ]) {
      expect(getOperation(id), id).toBeDefined();
      expect(getOperation(id)?.danger, id).toBe('write');
    }
  });
});

// ---------------------------------------------------------------------------
// Costly classification — surfaced, never gated
// ---------------------------------------------------------------------------

describe('costly classification', () => {
  it.each(COSTLY_ROUTES)('flags the %s route %s as costly', (surface, route) => {
    const operation = findByRoute(surface, route);

    expect(operation, `${surface} ${route} is not in the catalog`).toBeDefined();
    expect(operation?.costly, operation?.id).toBe(true);
  });

  it('flags nothing else', () => {
    const declared = new Set(COSTLY_ROUTES.map(([surface, route]) => `${surface} ${route}`));
    const flagged = CATALOG.filter((row) => row.costly === true).map(
      (row) => `${row.surface} ${routeOf(row)}`,
    );

    expect(flagged.filter((route) => !declared.has(route))).toEqual([]);
    expect(flagged).toHaveLength(COSTLY_ROUTES.length);
  });

  it('maps every cloud costly operation onto a real Hetzner pricing category', () => {
    // The costly list is exactly congruent with Hetzner's own price catalogue,
    // and that congruence is enforced rather than assumed. The categories are
    // read out of the vendored spec, so a Hetzner pricing change breaks this
    // test instead of silently invalidating the flag — which is the failure
    // that put `POST /certificates` on the list in the first place.
    const categories = pricingCategoriesFromSpec();
    expect(categories).toContain('server_types');
    expect(categories).toContain('server_backup');
    // Certificates are absent from `/pricing` because Hetzner's managed
    // certificates are free. That absence is why they are not flagged costly.
    expect(categories).not.toContain('certificates');
    expect(getOperation('create_certificate')?.costly).toBeUndefined();

    const cloudCostly = CATALOG.filter((row) => row.surface === 'cloud' && row.costly === true);
    expect(cloudCostly.length).toBeGreaterThan(0);

    for (const row of cloudCostly) {
      const category = getPricingCategory(row.id);
      expect(category, `${row.id} has no pricing category`).toBeDefined();
      expect(categories, `${row.id} -> ${String(category)}`).toContain(category);
    }

    // And no stale entries pointing at operations that are no longer costly.
    const costlyIds = new Set(cloudCostly.map((row) => row.id));
    expect([...PRICING_CATEGORY_BY_OPERATION.keys()].filter((id) => !costlyIds.has(id))).toEqual(
      [],
    );
  });

  it('exempts the account surface, which has no pricing endpoint', () => {
    // Explicit rather than incidental. Creating and resizing a Storage Box is
    // billable, but the account API publishes no `/pricing` document, so those
    // operations deliberately carry `costly` with no category. Inventing one
    // here would be a price this codebase made up.
    const accountSpec = readSpec('hetzner-api.openapi.json');
    expect(Object.keys(accountSpec.paths).some((path) => /pricing/i.test(path))).toBe(false);

    const accountCostly = CATALOG.filter((row) => row.surface === 'hetzner' && row.costly === true);
    expect(ids(accountCostly)).toEqual(['create_storage_box', 'change_storage_box_type']);
    for (const row of accountCostly) {
      expect(getPricingCategory(row.id), row.id).toBeUndefined();
    }
  });

  it('does not gate what it flags', () => {
    // A deliberate product decision: opening a bill is a consequence to state,
    // not a capability to withhold. Nothing costly may be classified
    // destructive, or the flag would become a gate by the back door.
    for (const row of CATALOG.filter((operation) => operation.costly === true)) {
      expect(row.danger, row.id).toBe('write');
      expect(row.method, row.id).toBe('POST');
    }
  });
});

// ---------------------------------------------------------------------------
// Lookup and browsing
// ---------------------------------------------------------------------------

describe('lookup', () => {
  it('resolves an id to its row and an unknown id to undefined', () => {
    expect(getOperation('create_server')?.path).toBe('/servers');
    expect(getOperation('no_such_operation')).toBeUndefined();
  });

  it('does not answer a prototype key from the schema table', () => {
    // The id reaching this function came from the model. On an object literal,
    // `SCHEMAS['constructor']` returns something truthy from the prototype.
    expect(getSchema('constructor')).toBeUndefined();
    expect(getOperation('toString')).toBeUndefined();
  });

  it('emits a body schema for exactly the operations that take a body', () => {
    for (const row of CATALOG) {
      expect(getSchema(row.id)?.body !== undefined, row.id).toBe(row.hasBody);
    }
  });

  it('describes the parameters an operation declares', () => {
    const schema = getSchema('list_servers');
    const names = (schema?.params ?? []).map((param) => param.name);

    expect(names).toContain('page');
    expect(names).toContain('per_page');
    expect((schema?.params ?? []).every((param) => param.in === 'path' || param.in === 'query'));
  });

  it('lists only families that actually have operations', () => {
    // Offering a model a family that resolves to nothing wastes a turn.
    for (const surface of SURFACES) {
      for (const row of listFamilies(surface)) {
        expect(row.count, `${surface}/${row.family}`).toBeGreaterThan(0);
      }
    }
    expect(listFamilies('hetzner').map((row) => row.family)).toEqual(['storage-boxes']);
    expect(listFamilies('robot')).toEqual([]);

    const cloudFamilies = listFamilies('cloud').map((row) => row.family);
    expect(cloudFamilies).toContain('servers');
    expect(cloudFamilies).toContain('zones');
    // `other` is for operations with genuinely no home. Every current tag maps.
    expect(cloudFamilies).not.toContain('other');
  });
});

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

describe('searchOperations', () => {
  it.each([
    ['create server', 'create_server'],
    ['delete volume', 'delete_volume'],
    ['reboot server', 'reboot_server'],
    ['rebuild server', 'rebuild_server'],
    ['create ssh key', 'create_ssh_key'],
    ['list load balancers', 'list_load_balancers'],
  ])('ranks the obvious hit for %j first', (query, expected) => {
    expect(searchOperations({ query, limit: 5 })[0]?.id).toBe(expected);
  });

  it('finds DNS records, which Hetzner calls RRSets in Zones', () => {
    // Nothing in the id, path or summary of `create_zone_rrset` contains a word
    // anybody types when they mean "add a DNS record", so without the alias one
    // of the most-wanted operations on the surface is unreachable by search.
    const results = searchOperations({ query: 'dns record', limit: 10 });

    expect(results.length).toBeGreaterThan(0);
    expect(results.every((row) => row.family === 'zones')).toBe(true);
    expect(ids(results)).toContain('create_zone_rrset');
  });

  it('resolves an id typed verbatim to that exact operation', () => {
    expect(searchOperations({ query: 'get_storage_box' })[0]?.id).toBe('get_storage_box');
  });

  it('filters by surface', () => {
    const results = searchOperations({ query: 'snapshot', surface: 'hetzner', limit: 50 });

    expect(results.length).toBeGreaterThan(0);
    expect(results.every((row) => row.surface === 'hetzner')).toBe(true);
  });

  it('filters by family and by danger, including a set of classes', () => {
    const gated = searchOperations({ query: 'server', danger: ['safe', 'write'], limit: 100 });
    expect(gated.every((row) => row.danger !== 'destructive')).toBe(true);

    const open = searchOperations({ query: 'delete server', danger: 'destructive', limit: 10 });
    expect(ids(open)).toContain('delete_server');

    const family = searchOperations({ family: 'volumes', limit: 100 });
    expect(family.length).toBeGreaterThan(0);
    expect(family.every((row) => row.family === 'volumes')).toBe(true);
  });

  it('browses with no query rather than returning nothing', () => {
    const results = searchOperations({ surface: 'hetzner', limit: 100 });

    expect(results).toHaveLength(EXPECTED_ACCOUNT_OPERATIONS);
  });

  it('carries the danger class, the costly note and the Action flag on every row', () => {
    const results = searchOperations({ query: 'create server', limit: 5 });

    expect(results.length).toBeGreaterThan(0);
    expect(results.every((row) => typeof row.danger === 'string')).toBe(true);
    expect(results.some((row) => row.costly === true)).toBe(true);
    expect(results.some((row) => row.returnsAction === true)).toBe(true);
  });

  it('returns nothing for a query that matches nothing', () => {
    expect(searchOperations({ query: 'kubernetes cluster autoscaler' })).toEqual([]);
  });

  it('never returns more rows than the limit allows', () => {
    expect(searchOperations({ limit: 3 })).toHaveLength(3);
    // Clamped rather than rejected: an over-large limit is a misjudgement, not a
    // reason to spend a turn on an error.
    expect(searchOperations({ limit: 10_000 }).length).toBeLessThanOrEqual(100);
  });
});
