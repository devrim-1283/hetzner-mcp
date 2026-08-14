/**
 * The one envelope every tool returns, and the graded degradation ladder that
 * keeps it inside the host's context budget.
 *
 * The threat is arithmetic, not theory. A single Hetzner cloud server embeds
 * its whole image, its whole datacenter (with that datacenter's three arrays of
 * available server-type ids) and its whole server_type — and a server_type
 * carries a `prices` entry for every location Hetzner operates. That is 6-10 KB
 * per server, of which the majority is a price table repeated identically on
 * every row. A default page of 25 servers is past the budget before anything
 * unusual has happened. Metrics are worse: one server's CPU, disk and network
 * series over a day is tens of thousands of points and no amount of field
 * projection touches it.
 *
 * Routing every return through here is what makes forgetting to shape a payload
 * impossible. A tool that returns raw JSON would blow the host's cap instead of
 * degrading, and the failure mode of blowing the cap is a dropped turn — the
 * user gets nothing, not less.
 */

import {
  type ActionRef,
  type ResponseMeta,
  type ShapeOptions,
  type Surface,
  type ToolEnvelope,
  type ToolResult,
  type TruncationKind,
} from '../types.js';
import { type CursorState, resumeSamePageCursor } from './cursor.js';
import { pathPresent, projectValue, pruneValue, type Row } from './project.js';
import { findOneTimeSecrets, redact, redactObject } from './redact.js';

/**
 * Sits under the ~150,000-character cap claude.ai and Claude Desktop apply,
 * with headroom for the JSON envelope and multibyte characters. Claude Code's
 * ~25k-token ceiling binds first in practice; this is the hard backstop.
 */
export const MAX_RESPONSE_BYTES = 130_000;

/**
 * Headroom held back while measuring. The truncation note and a recomputed
 * cursor are both written after the last measurement, so without a reserve a
 * payload that just fit could be pushed back over budget by its own
 * explanation.
 */
const META_RESERVE = 1024;

/** Floor for the measurement budget, so an absurd `maxBytes` cannot go negative. */
const MIN_BUDGET = 1024;

/** Bounds the value-capping search; each pass is one walk plus one serialize. */
const MAX_CAP_PASSES = 8;

/**
 * An array shorter than this is never capped. A three-element list of ports is
 * not a time series, and replacing it with a marker costs the caller the answer
 * to save nothing.
 */
const MIN_CAPPABLE_ARRAY = 8;

function stringMarker(bytes: number): string {
  return `<truncated: ${bytes} bytes>`;
}

function arrayMarker(count: number, bytes: number): string {
  return `<truncated: ${count} values, ${bytes} bytes>`;
}

/** Replacing a value shorter than the marker would grow the payload. */
const MARKER_FLOOR = Buffer.byteLength(stringMarker(0), 'utf8');

// ---------------------------------------------------------------------------
// The envelope
// ---------------------------------------------------------------------------

export interface EnvelopeMeta {
  connection?: string;
  surface?: Surface;
  /** Overrides the derived row count, for tools whose payload is not a list. */
  count?: number;
  total?: number;
  next_cursor?: string;
  /** Factual statement of available next steps. Never a directive about model behaviour. */
  hint?: string;
  /** Partial failures from a `connection: "*"` fan-out. */
  errors?: Array<{ connection: string; message: string }>;
  /**
   * The cursor state this page was fetched under.
   *
   * When the ladder drops rows, `next_cursor` is recomputed from this so the
   * dropped rows come back on the next call instead of being skipped. A
   * caller-supplied `next_cursor` was computed before shaping and would step
   * straight over them.
   */
  cursor?: CursorState;
  billing?: ResponseMeta['billing'];
  action?: ResponseMeta['action'];
}

/**
 * Serialize, and if it does not fit, degrade in graded steps:
 *
 *   1. under budget            -> returned as is
 *   2. drop declared fields    -> truncation: 'field_prune'
 *   3. drop rows               -> truncation: 'row_limit',  truncated: <n>
 *   4. cap oversized values    -> truncation: 'field_value'
 *
 * Each step is strictly more destructive than the last, so the cheapest one
 * that fits is the one that ships, and `meta.truncation` names the rung that
 * fired. A caller that cannot tell shaped output from complete output will
 * eventually report the shaped list as the whole fleet.
 */
export function shapeResponse<T>(
  data: T,
  meta: EnvelopeMeta = {},
  opts: ShapeOptions = {},
): ToolEnvelope<T> {
  const maxBytes = opts.maxBytes ?? MAX_RESPONSE_BYTES;
  const budget = Math.max(maxBytes - META_RESERVE, MIN_BUDGET);

  // Projection first, redaction second: projection is what removes most of the
  // payload, and redacting fields that are about to be dropped is work for
  // nothing. Redaction is unconditional rather than a caller opt-in, for the
  // same reason shaping is — a security property that every tool has to
  // remember to invoke is a security property one tool will forget.
  const projected = opts.fields ? projectValue(data, opts.fields) : data;
  let payload: unknown = redactObject(projected, { audience: 'model' });

  const oneTimeSecrets = findOneTimeSecrets(payload);
  const rowsBefore = Array.isArray(payload) ? payload.length : 0;
  let droppedRows = 0;
  let prunedFields: readonly string[] = [];
  let cappedValues = 0;
  let truncation: TruncationKind = null;

  const measure = (candidate: unknown): number =>
    byteLength(serialize(provisional(candidate, meta)));
  const fits = (candidate: unknown): boolean => measure(candidate) <= budget;

  // 1. Fields. The cheapest degradation: every row survives, in order.
  if (!fits(payload)) {
    const prunable = opts.prunable ?? [];
    // Each pass prunes from the unpruned payload rather than from the previous
    // pass's output. Pruning incrementally would work, but presence has to be
    // tested against the payload that still had the field — a second pass over
    // an already-pruned object reports every earlier field as "was not there".
    const intact = payload;
    for (let take = 1; take <= prunable.length; take++) {
      const dropping = prunable.slice(0, take);
      // Only claim a field was omitted if it was actually there. A tool's
      // prunable list is written against the newest API; a field this account
      // never receives must not show up in the hint as a loss.
      prunedFields = dropping.filter((field) => pathPresent(intact, field));
      payload = pruneValue(intact, dropping);
      if (prunedFields.length > 0) truncation = 'field_prune';
      if (fits(payload)) break;
    }
  }

  // 2. Rows. Keep at least one even when it does not fit: the model still needs
  // to see the shape of a record, and step 3 cuts inside it.
  if (!fits(payload) && Array.isArray(payload)) {
    const rows: readonly unknown[] = payload;
    const keep = Math.max(1, largestFittingPrefix(rows, fits));
    if (keep < rows.length) {
      droppedRows = rows.length - keep;
      payload = rows.slice(0, keep);
      truncation = 'row_limit';
    }
  }

  // 3. Values. One metrics time series, or one cloud-init user_data blob, can
  // be the entire overage on its own.
  if (!fits(payload)) {
    const capped = capLargeValues(payload, measure, budget);
    if (capped.count > 0) {
      payload = capped.payload;
      cappedValues = capped.count;
      truncation = 'field_value';
    }
  }

  const build = (): ToolEnvelope<T> => {
    const count =
      meta.count ??
      (Array.isArray(payload) ? payload.length : payload === null || payload === undefined ? 0 : 1);

    let nextCursor = meta.next_cursor;
    if (droppedRows > 0 && meta.cursor) {
      nextCursor = resumeSamePageCursor(meta.cursor, Array.isArray(payload) ? payload.length : 0);
    }

    const responseMeta: ResponseMeta = {
      count,
      total: meta.total ?? meta.cursor?.total,
      next_cursor: nextCursor,
      truncated: droppedRows,
      truncation,
      hint: composeHint({
        base: meta.hint,
        maxBytes,
        prunedFields,
        droppedRows,
        rowsBefore,
        cappedValues,
        hasCursor: nextCursor !== undefined,
        oneTimeSecrets,
      }),
      errors: meta.errors,
      billing: meta.billing,
      action: meta.action,
      one_time_secrets: oneTimeSecrets.length > 0 ? oneTimeSecrets : undefined,
    };

    return {
      connection: meta.connection,
      surface: meta.surface,
      data: payload as T,
      meta: responseMeta,
    };
  };

  let envelope = build();

  // Backstop. The reserve should cover the note and the recomputed cursor, but
  // callers rely on "never larger than maxBytes" as an invariant, so verify it
  // rather than assume it. Reaching here means structural bulk — thousands of
  // small fields — which no earlier rung can shrink.
  if (byteLength(serialize(envelope)) > maxBytes) {
    payload = stringMarker(byteLength(serialize(payload)));
    cappedValues = Math.max(cappedValues, 1);
    truncation = 'field_value';
    envelope = build();
  }

  return envelope;
}

/**
 * Serialize an envelope into the MCP tool result.
 *
 * The last redaction throat: every byte a tool emits passes through here, so a
 * bearer token cannot reach the transcript via a code path that forgot to
 * redact. Replacement happens inside existing JSON strings, so the document
 * stays valid.
 */
export function renderEnvelope(envelope: ToolEnvelope<unknown>): ToolResult {
  return { content: [{ type: 'text', text: redact(serialize(envelope)) }] };
}

// ---------------------------------------------------------------------------
// Meta helpers
// ---------------------------------------------------------------------------

/** Hetzner's price shape, as it appears in `server_type.prices[]` and friends. */
export interface HetznerPrice {
  location?: string;
  price_hourly?: { net?: string; gross?: string };
  price_monthly?: { net?: string; gross?: string };
  /** Load Balancers and Storage Boxes use this key instead. */
  price?: { net?: string; gross?: string };
  currency?: string;
}

/**
 * Attach a price statement to a response.
 *
 * Exists so that thirty tools do not each invent their own phrasing for "this
 * costs money". `costly` operations are not gated — the brief keeps everything
 * non-destructive open — so the only thing standing between a user and a
 * surprise on the invoice is the cost being stated next to the act. A helper
 * makes that one line; without one it is thirty chances to leave it out.
 *
 * Gross rather than net, because gross is what the user is charged. Net is the
 * number a price comparison uses and the wrong number to show someone who just
 * created a machine.
 */
export function attachBilling<T>(
  envelope: ToolEnvelope<T>,
  billing: NonNullable<ResponseMeta['billing']>,
): ToolEnvelope<T> {
  return { ...envelope, meta: { ...envelope.meta, billing } };
}

/**
 * Pull the billing statement for one location out of a Hetzner price array.
 *
 * The default projection drops `server_type.prices` precisely because it is a
 * table of every location; this is how the one row that matters survives that.
 * Returns undefined rather than a zero price when the location is absent — a
 * confidently wrong price is worse than no price.
 */
export function billingFromPrices(
  prices: readonly HetznerPrice[] | undefined,
  location: string | undefined,
  currency = 'EUR',
): ResponseMeta['billing'] | undefined {
  if (!Array.isArray(prices) || prices.length === 0) return undefined;
  const entry =
    (location === undefined ? undefined : prices.find((p) => p?.location === location)) ??
    (prices.length === 1 ? prices[0] : undefined);
  if (entry === undefined) return undefined;

  const hourly = entry.price_hourly?.gross ?? entry.price?.gross;
  const monthly = entry.price_monthly?.gross ?? entry.price?.gross;
  if (hourly === undefined && monthly === undefined) return undefined;

  return { monthly, hourly, currency: entry.currency ?? currency };
}

/**
 * Attach action status, including whether the tool waited for it.
 *
 * `awaited` is the load-bearing half. Nearly every Hetzner cloud mutation
 * returns `{ action: { status: 'running' } }` and completes later, so a tool
 * that reports the action and stops has said nothing about whether the work
 * happened. Recording whether we waited is what lets the response distinguish
 * "it is done" from "it was accepted" — and those are the two answers a user
 * actually cares about telling apart.
 */
export function attachAction<T>(
  envelope: ToolEnvelope<T>,
  action: Pick<ActionRef, 'id' | 'status'>,
  awaited: boolean,
): ToolEnvelope<T> {
  return {
    ...envelope,
    meta: { ...envelope.meta, action: { id: action.id, status: action.status, awaited } },
  };
}

// ---------------------------------------------------------------------------
// Ladder internals
// ---------------------------------------------------------------------------

function provisional(payload: unknown, meta: EnvelopeMeta): ToolEnvelope<unknown> {
  return {
    connection: meta.connection,
    surface: meta.surface,
    data: payload,
    meta: {
      count: Array.isArray(payload) ? payload.length : 1,
      total: meta.total,
      next_cursor: meta.next_cursor,
      truncated: 0,
      truncation: null,
      hint: meta.hint,
      errors: meta.errors,
      billing: meta.billing,
      action: meta.action,
    },
  };
}

/** Serialized size is monotonic in row count, so binary search is exact. */
function largestFittingPrefix(
  rows: readonly unknown[],
  fits: (candidate: unknown) => boolean,
): number {
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(rows.slice(0, mid))) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function capLargeValues(
  payload: unknown,
  measure: (candidate: unknown) => number,
  budget: number,
): { payload: unknown; count: number } {
  const sizes = collectCappableSizes(payload).sort((a, b) => b - a);
  if (sizes.length === 0) return { payload, count: 0 };

  // Analytic first guess: replacing a node of B bytes with its marker frees
  // (B - marker) bytes, so take the fewest largest nodes that cover the
  // overage. JSON escaping only ever makes the real saving larger, so the guess
  // cannot overshoot — and destroying more values than necessary is the thing
  // worth avoiding here.
  const overBy = measure(payload) - budget;
  let take = 0;
  let saved = 0;
  while (take < sizes.length && saved < overBy) {
    saved += Math.max((sizes[take] ?? 0) - MARKER_FLOOR, 0);
    take++;
  }
  if (take === 0) take = 1;

  let result: { payload: unknown; count: number } = { payload, count: 0 };
  for (let pass = 0; pass < MAX_CAP_PASSES; pass++) {
    const threshold = sizes[Math.min(take, sizes.length) - 1] ?? MARKER_FLOOR + 1;
    result = replaceCappableFrom(payload, threshold);
    if (measure(result.payload) <= budget || take >= sizes.length) break;
    take = Math.min(sizes.length, take * 2);
  }
  return result;
}

/**
 * A node worth replacing with a marker: a long string, or a long array of
 * scalars.
 *
 * The array case is the Hetzner addition. The sibling product only ever had one
 * shape of overage — a giant string, a compose file or a build log — so capping
 * strings was enough. Here the worst offender is `metrics.time_series.*.values`,
 * thousands of `[timestamp, "value"]` pairs, which is structurally an array and
 * would slip through a string-only rung entirely and force the whole-payload
 * backstop instead.
 */
function cappableBytes(node: unknown): number | undefined {
  if (typeof node === 'string') {
    const bytes = byteLength(node);
    return bytes > MARKER_FLOOR ? bytes : undefined;
  }
  if (Array.isArray(node) && node.length >= MIN_CAPPABLE_ARRAY && node.every(isScalarish)) {
    const bytes = byteLength(serialize(node));
    return bytes > MARKER_FLOOR ? bytes : undefined;
  }
  return undefined;
}

/** A scalar, or a flat tuple of scalars — a time-series point is the latter. */
function isScalarish(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return true;
  return Array.isArray(value) && value.every((v) => v === null || typeof v !== 'object');
}

function collectCappableSizes(value: unknown): number[] {
  const sizes: number[] = [];
  const walk = (node: unknown): void => {
    const bytes = cappableBytes(node);
    if (bytes !== undefined) {
      sizes.push(bytes);
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (isPlainObject(node)) {
      for (const child of Object.values(node)) walk(child);
    }
  };
  walk(value);
  return sizes;
}

/** Replaces every cappable node at or above `threshold` bytes with its marker. */
function replaceCappableFrom(
  value: unknown,
  threshold: number,
): { payload: unknown; count: number } {
  let count = 0;
  const walk = (node: unknown): unknown => {
    const bytes = cappableBytes(node);
    if (bytes !== undefined) {
      if (bytes < threshold) return node;
      count++;
      return Array.isArray(node) ? arrayMarker(node.length, bytes) : stringMarker(bytes);
    }
    if (Array.isArray(node)) return node.map(walk);
    if (isPlainObject(node)) {
      const out: Row = {};
      for (const [key, child] of Object.entries(node)) out[key] = walk(child);
      return out;
    }
    return node;
  };
  const payload = walk(value);
  return { payload, count };
}

// ---------------------------------------------------------------------------
// Hint
// ---------------------------------------------------------------------------

/**
 * The sentence that turns a one-time credential from "another field" into
 * "write this down".
 *
 * `root_password` passes through redaction on purpose — see redact.ts for why —
 * but passing it through is only half the job. A password rendered as one more
 * key in a JSON blob gets summarized away, and the user finds out it was the
 * only copy when they try to log in. So the envelope states the fact, and the
 * model has something true to relay.
 */
const ONE_TIME_SECRET_NOTE =
  'Hetzner returns this value once and has no endpoint that reads it back; it is not recoverable after this response.';

interface HintParts {
  base?: string;
  maxBytes: number;
  prunedFields: readonly string[];
  droppedRows: number;
  rowsBefore: number;
  cappedValues: number;
  hasCursor: boolean;
  oneTimeSecrets: readonly string[];
}

/**
 * Facts only. A hint that told the model what to do next would be a directive
 * embedded in tool output, which Directory review treats as prompt injection —
 * so every sentence here states what is true or what exists, never what to do.
 */
function composeHint(parts: HintParts): string | undefined {
  const notes: string[] = [];
  if (parts.base) notes.push(parts.base);
  if (parts.oneTimeSecrets.length > 0) {
    notes.push(`${parts.oneTimeSecrets.join(', ')}: ${ONE_TIME_SECRET_NOTE}`);
  }
  if (parts.prunedFields.length > 0) {
    notes.push(
      `Fields omitted to fit the ${parts.maxBytes}-byte response budget: ${parts.prunedFields.join(', ')}. ` +
        'The complete record is available from the single-resource read for this type.',
    );
  }
  if (parts.droppedRows > 0) {
    // Phrased as a loss rather than "showing N of M": the caller's own hint
    // already reports a page position, and two different "showing" counts in
    // one string is how a reader ends up with the wrong total.
    notes.push(
      `${parts.droppedRows} of ${parts.rowsBefore} rows on this page were dropped to fit the ` +
        `${parts.maxBytes}-byte response budget.` +
        (parts.hasCursor ? ' next_cursor resumes at the first dropped row.' : ''),
    );
  }
  if (parts.cappedValues > 0) {
    notes.push(
      `${parts.cappedValues} oversized value(s) replaced with a size marker to fit the ` +
        `${parts.maxBytes}-byte response budget.`,
    );
  }
  return notes.length > 0 ? notes.join(' ') : undefined;
}

function serialize(value: unknown): string {
  return JSON.stringify(value) ?? '';
}

function byteLength(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

function isPlainObject(value: unknown): value is Row {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
