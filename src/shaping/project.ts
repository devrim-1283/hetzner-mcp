/**
 * Field projection — the cheap 95% of response shaping.
 *
 * Hetzner's cloud objects are composed by embedding, not by reference. One
 * server carries the whole `image` record, the whole `datacenter` record
 * (including its `location`, and its three arrays of available server-type
 * ids), and the whole `server_type` record — and a `server_type` carries a
 * `prices` entry for EVERY location Hetzner operates. A single server is 6-10 KB
 * of JSON and the majority of it is a price table nobody asked for. Twenty
 * servers is a quarter of the response budget spent on the same price table
 * repeated twenty times.
 *
 * So projection here is not a nicety the way it was for a flat Eloquent model:
 * it is the difference between a page of servers fitting and not fitting.
 * Everything in envelope.ts is the fallback for when projection alone is not
 * enough; this module is what keeps that fallback rare.
 */

import type { OperationFamily, ShapeOptions } from '../types.js';

/** A JSON object as it comes off a Hetzner API. */
export type Row = Record<string, unknown>;

/**
 * Field specs are dotted paths: `server_type.cores`, `datacenter.location.name`.
 *
 * Hetzner's embedding is the reason. A flat allowlist could only choose between
 * "the entire server_type including its price table" and "no server_type at
 * all", and both answers are wrong — the caller wants the cores and the memory.
 * A path spec makes "the shape of the machine, without the price of the machine
 * in every datacenter" expressible, which is the actual requirement.
 *
 * A path that names a container keeps the whole subtree, so `labels` still
 * means all labels. Arrays are traversed elementwise, so `private_net.ip`
 * projects each entry of the array rather than failing on it.
 */
interface FieldNode {
  /** No deeper spec was given, so the entire subtree is kept. */
  leaf: boolean;
  children: Map<string, FieldNode>;
}

type FieldTree = Map<string, FieldNode>;

function buildTree(fields: readonly string[]): FieldTree {
  const root: FieldTree = new Map();
  for (const spec of fields) {
    const segments = spec.split('.').filter((s) => s.length > 0);
    if (segments.length === 0) continue;

    let level = root;
    for (let i = 0; i < segments.length; i++) {
      const key = segments[i] as string;
      const last = i === segments.length - 1;
      let node = level.get(key);
      if (node === undefined) {
        node = { leaf: last, children: new Map() };
        level.set(key, node);
      } else if (last) {
        // A broader spec wins over a narrower one: declaring both `image` and
        // `image.name` means the caller asked for the whole image somewhere,
        // and silently honouring only the narrow one would lose data the
        // allowlist explicitly named.
        node.leaf = true;
      }
      level = node.children;
    }
  }
  return root;
}

/**
 * Keep only `fields`, in the order given.
 *
 * An allowlist by design. A denylist would start leaking every field a future
 * Hetzner release adds, so the budget would regress on someone else's release
 * schedule with no change on our side. An allowlist can only ever be smaller
 * than the upstream payload.
 */
export function project(rows: readonly Row[], fields: readonly string[]): Row[] {
  const tree = buildTree(fields);
  return rows.map((row) => applyKeep(row, tree) as Row);
}

/** Single-object form, for the `get_*` tools that return one record. */
export function projectOne(row: Row, fields: readonly string[]): Row {
  return applyKeep(row, buildTree(fields)) as Row;
}

/** Array- and object-tolerant form, used by the degradation ladder. */
export function projectValue(value: unknown, fields: readonly string[]): unknown {
  return applyKeep(value, buildTree(fields));
}

function applyKeep(value: unknown, tree: FieldTree): unknown {
  if (Array.isArray(value)) return value.map((item) => applyKeep(item, tree));
  if (!isPlainObject(value)) return value;

  const out: Row = {};
  for (const [key, node] of tree) {
    const child = value[key];
    // Absent stays absent. Emitting `"field": null` for something this Hetzner
    // API version does not send reads to a model as "the value is null", which
    // is a different and wrong claim.
    if (child === undefined) continue;
    out[key] = node.leaf ? child : applyKeep(child, node.children);
  }
  return out;
}

/**
 * Drop `prunable` paths.
 *
 * The degradation ladder calls this with progressively longer prefixes of the
 * tool's prunable list, so the order a tool declares is the order in which its
 * fields are sacrificed under budget pressure.
 */
export function prune(rows: readonly Row[], prunable: readonly string[]): Row[] {
  const tree = buildTree(prunable);
  return rows.map((row) => applyDrop(row, tree) as Row);
}

/** Single-object form of {@link prune}. */
export function pruneOne(row: Row, prunable: readonly string[]): Row {
  return applyDrop(row, buildTree(prunable)) as Row;
}

/** Array- and object-tolerant form, used by the degradation ladder. */
export function pruneValue(value: unknown, prunable: readonly string[]): unknown {
  return applyDrop(value, buildTree(prunable));
}

/** Builds a copy rather than deleting keys: callers hand us live response objects. */
function applyDrop(value: unknown, tree: FieldTree): unknown {
  if (Array.isArray(value)) return value.map((item) => applyDrop(item, tree));
  if (!isPlainObject(value)) return value;

  const out: Row = {};
  for (const key of Object.keys(value)) {
    const node = tree.get(key);
    if (node === undefined) {
      out[key] = value[key];
      continue;
    }
    if (node.leaf) continue;
    out[key] = applyDrop(value[key], node.children);
  }
  return out;
}

/** True when `path` resolves to something present, so a hint can only name real losses. */
export function pathPresent(value: unknown, path: string): boolean {
  const segments = path.split('.').filter((s) => s.length > 0);
  const visit = (node: unknown, depth: number): boolean => {
    if (depth === segments.length) return node !== undefined;
    if (Array.isArray(node)) return node.some((item) => visit(item, depth));
    if (!isPlainObject(node)) return false;
    return visit(node[segments[depth] as string], depth + 1);
  };
  if (Array.isArray(value)) return value.some((item) => visit(item, 0));
  return visit(value, 0);
}

// ---------------------------------------------------------------------------
// Default shapes
// ---------------------------------------------------------------------------

/**
 * The default projection for a cloud server.
 *
 * Chosen to answer the questions someone actually asks a fleet tool — what is
 * it, is it up, how big is it, where is it, how do I reach it — and nothing
 * else. The three deliberate omissions are the whole point:
 *
 *   server_type.prices   an entry per location, ~20 of them, per server. This
 *                        is the single largest term in a server list and it is
 *                        the same table on every row. Pricing is its own
 *                        family; asking a server for it is how the budget dies.
 *   datacenter.server_types  three arrays of ~120 numeric ids each, identical
 *                        on every server in that datacenter.
 *   image.description / image.build_id / deprecation notices — prose and
 *                        provenance that restate `name` and `os_flavor`.
 */
export const SERVER_FIELDS: readonly string[] = [
  'id',
  'name',
  'status',
  'created',
  'public_net.ipv4.ip',
  'public_net.ipv6.ip',
  'public_net.floating_ips',
  'private_net.ip',
  'private_net.network',
  'server_type.name',
  'server_type.cores',
  'server_type.memory',
  'server_type.disk',
  'server_type.architecture',
  'image.name',
  'image.os_flavor',
  'image.os_version',
  'datacenter.name',
  'datacenter.location.name',
  'datacenter.location.country',
  'primary_disk_size',
  'locked',
  'labels',
];

/**
 * Sacrificed in this order once the allowlist alone is not enough.
 *
 * Ordered by how far each field is from the question a fleet tool is asked:
 * labels and the OS point release go before the IP address and the status,
 * because a list of servers with no addresses is not a list of servers.
 */
export const SERVER_PRUNABLE: readonly string[] = [
  'labels',
  'image.os_version',
  'primary_disk_size',
  'datacenter.location.country',
  'public_net.floating_ips',
  'private_net',
  'server_type.architecture',
  'server_type.disk',
  'image',
  'created',
  'public_net.ipv6.ip',
  'datacenter',
];

const DEFAULTS: Readonly<
  Partial<Record<OperationFamily, { fields: readonly string[]; prunable: readonly string[] }>>
> = {
  servers: { fields: SERVER_FIELDS, prunable: SERVER_PRUNABLE },
  'server-types': {
    // `prices` survives here and only here: on this family it is the answer
    // rather than the noise.
    fields: [
      'id',
      'name',
      'cores',
      'cpu_type',
      'memory',
      'disk',
      'architecture',
      'deprecated',
      'prices',
    ],
    prunable: ['deprecated', 'architecture', 'prices'],
  },
  images: {
    fields: [
      'id',
      'type',
      'status',
      'name',
      'description',
      'os_flavor',
      'os_version',
      'architecture',
      'image_size',
      'disk_size',
      'created',
      'labels',
    ],
    prunable: ['labels', 'image_size', 'created', 'description'],
  },
  'load-balancers': {
    fields: [
      'id',
      'name',
      'public_net.ipv4.ip',
      'public_net.ipv6.ip',
      'private_net.ip',
      'load_balancer_type.name',
      'algorithm.type',
      'services.protocol',
      'services.listen_port',
      'services.destination_port',
      'services.health_check.protocol',
      'targets.type',
      'targets.server.id',
      'targets.health_status',
      'location.name',
      'created',
      'labels',
    ],
    prunable: ['labels', 'created', 'services.health_check.protocol', 'targets', 'private_net'],
  },
  volumes: {
    fields: [
      'id',
      'name',
      'status',
      'size',
      'format',
      'server',
      'location.name',
      'linux_device',
      'created',
      'labels',
    ],
    prunable: ['labels', 'created', 'format'],
  },
  actions: {
    fields: ['id', 'command', 'status', 'progress', 'started', 'finished', 'error', 'resources'],
    prunable: ['started', 'resources'],
  },
};

/**
 * The shaping options a family gets when the caller did not name fields.
 *
 * Returned empty for families with no entry, which means "pass through and let
 * the ladder handle it" rather than "invent an allowlist". A guessed allowlist
 * on an unfamiliar payload silently deletes the field the caller wanted; the
 * ladder at worst reports that it truncated.
 */
export function defaultShape(family: OperationFamily): ShapeOptions {
  const entry = DEFAULTS[family];
  if (entry === undefined) return {};
  return { fields: entry.fields, prunable: entry.prunable };
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

/** One `time_series` entry: `values` is `[unixSeconds, "value"]` pairs. */
export interface MetricsPayload {
  start?: string;
  end?: string;
  step?: number;
  time_series?: Record<string, { values?: unknown }>;
}

/**
 * Hetzner's server and Load Balancer metrics endpoints return one point per
 * `step` seconds per series. A day of CPU, disk and network at the default step
 * is tens of thousands of points, and a model reading a time series is looking
 * for a shape and an outlier, not for the value at 03:14:20.
 *
 * So this thins by a stride rather than averaging: an averaged series hides the
 * spike, which is the one thing anyone opens metrics to find. The first and
 * last points are always kept so the window the data covers still reads
 * correctly off the series itself.
 */
export function downsampleMetrics(metrics: MetricsPayload, maxPoints = 120): MetricsPayload {
  const series = metrics.time_series;
  if (!isPlainObject(series)) return metrics;

  const out: Record<string, { values?: unknown }> = {};
  for (const [name, entry] of Object.entries(series)) {
    const values = isPlainObject(entry) ? entry['values'] : undefined;
    if (!Array.isArray(values) || values.length <= maxPoints) {
      out[name] = entry;
      continue;
    }
    out[name] = { ...(entry as Row), values: stride(values, maxPoints) };
  }
  return { ...metrics, time_series: out };
}

function stride(values: readonly unknown[], maxPoints: number): unknown[] {
  const step = Math.ceil(values.length / maxPoints);
  const kept: unknown[] = [];
  for (let i = 0; i < values.length; i += step) kept.push(values[i]);
  const last = values[values.length - 1];
  if (kept[kept.length - 1] !== last) kept.push(last);
  return kept;
}

function isPlainObject(value: unknown): value is Row {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
