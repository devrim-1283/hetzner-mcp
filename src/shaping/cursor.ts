/**
 * Opaque pagination cursors over Hetzner's `page` / `per_page`.
 *
 * Unlike the sibling product, we are not inventing pagination — Hetzner already
 * paginates and returns `meta.pagination` with page, per_page, total_entries
 * and last_page. So a cursor here is a mapping, not a fiction, and it exists
 * for three reasons that a bare page number does not cover:
 *
 *  1. A model handles "pass this token back" far more reliably than it handles
 *     offset arithmetic. An opaque string cannot be off by one.
 *  2. Resuming must not require the caller to re-supply the original arguments.
 *     A page number alone means the model has to remember the label selector,
 *     the sort and the per_page it used three turns ago, and reconstruct them
 *     exactly. So the cursor carries them.
 *  3. The response shaper can drop rows from a page it already fetched. Page
 *     numbers cannot express "page 3, but you already saw the first eleven
 *     rows", and without that the dropped rows are skipped forever. `skip`
 *     exists for exactly that case.
 *
 * Dependency-free on purpose: base64url via Buffer and a hand-rolled FNV-1a.
 * Nothing here needs a crypto guarantee — the checksum's job is to make a
 * hand-typed or foreign string fail loudly, not to resist an adversary who can
 * already see everything in the cursor.
 */

import { HetznerError, type Pagination } from '../types.js';

/** Version tag. A bump here invalidates every outstanding cursor by design. */
const CURSOR_PREFIX = 'htz1';

/** Hetzner's own ceiling on `per_page`. Sending more is a validation error upstream. */
export const MAX_PER_PAGE = 50;

/** Hetzner's default, and a sensible page size for a model reading a list. */
export const DEFAULT_PER_PAGE = 25;

/**
 * Everything needed to fetch the next page without the caller re-supplying
 * anything.
 *
 * `query` is the frozen non-paging arguments — filters, sort, label_selector,
 * status. It is stored rather than hashed: a hash would let us detect that the
 * caller changed the filters, but it would not let us *resume*, and resuming
 * without re-supplied arguments is the requirement.
 */
export interface CursorState {
  /** Catalog operation id this cursor was minted for, e.g. "list_servers". */
  op: string;
  /** Hetzner page to request next. 1-based, as the API numbers them. */
  page: number;
  perPage: number;
  /**
   * Rows to discard from the front of `page` before returning any.
   *
   * Non-zero only when the degradation ladder cut a page short: the remaining
   * rows live on the same upstream page, so resuming means re-fetching it and
   * stepping over what the model already saw.
   */
  skip?: number;
  /** Connection the cursor was minted against. A cloud token sees one project. */
  connection?: string;
  /** Frozen non-paging arguments. */
  query?: Record<string, string | number | boolean>;
  /** `total_entries` as of the page that minted this cursor, for meta.total. */
  total?: number;
}

/** What the caller expects a resumed cursor to belong to. */
export interface CursorExpectation {
  op: string;
  connection?: string;
}

// ---------------------------------------------------------------------------
// Encode / decode
// ---------------------------------------------------------------------------

/**
 * `htz1.<base64url payload>.<8 hex checksum>`
 *
 * The prefix is what distinguishes "this is not a cursor" from "this is a
 * cursor for something else", which are two different errors with two different
 * fixes. The checksum is what stops a plausible-looking hand-assembled string
 * from being accepted and paginating through the wrong result set — the model
 * must not be invited to construct one, and the cheapest way to decline the
 * invitation is to make hand-construction fail.
 */
export function encodeCursor(state: CursorState): string {
  const json = stableStringify(normalize(state));
  const body = Buffer.from(json, 'utf8').toString('base64url');
  return `${CURSOR_PREFIX}.${body}.${checksum(json)}`;
}

/**
 * Decode, or throw.
 *
 * Never falls back to page 1. A cursor that silently resets restarts the list
 * from the top while the model believes it is advancing, which is an infinite
 * loop that looks like progress — strictly worse than an error, because an
 * error is recoverable and a loop burns the context window.
 */
export function decodeCursor(raw: string): CursorState {
  const parts = raw.split('.');
  if (parts.length !== 3 || parts[0] !== CURSOR_PREFIX) throw notACursor(raw);

  let json: string;
  try {
    json = Buffer.from(parts[1] as string, 'base64url').toString('utf8');
  } catch {
    throw notACursor(raw);
  }
  if (checksum(json) !== parts[2]) throw notACursor(raw);

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw notACursor(raw);
  }
  if (!isPlainObject(parsed)) throw notACursor(raw);

  const { op, page, perPage, skip, connection, query, total } = parsed;
  if (typeof op !== 'string' || op === '') throw notACursor(raw);
  if (!isPositiveInt(page)) throw notACursor(raw);
  if (!isPositiveInt(perPage) || perPage > MAX_PER_PAGE) throw notACursor(raw);
  if (skip !== undefined && !isNonNegativeInt(skip)) throw notACursor(raw);
  if (connection !== undefined && typeof connection !== 'string') throw notACursor(raw);
  if (total !== undefined && !isNonNegativeInt(total)) throw notACursor(raw);
  if (query !== undefined && !isScalarRecord(query)) throw notACursor(raw);

  return normalize({ op, page, perPage, skip, connection, query, total });
}

/**
 * Decode and confirm the cursor belongs to the call being made.
 *
 * A cursor from `list_servers` replayed against `list_volumes`, or one minted
 * on a different connection, decodes perfectly well and would page through a
 * completely different result set while reporting success. Detecting it here is
 * the difference between a clear error and a wrong answer.
 */
export function resumeCursor(raw: string, expect: CursorExpectation): CursorState {
  const cursor = decodeCursor(raw);

  if (cursor.op !== expect.op) {
    throw new HetznerError(
      `This cursor was issued by ${cursor.op} and does not belong to ${expect.op}.`,
      'validation',
      `${expect.op} accepts a cursor from its own previous page. Calling ${expect.op} without a cursor starts at the first page.`,
    );
  }

  if (
    expect.connection !== undefined &&
    cursor.connection !== undefined &&
    cursor.connection !== expect.connection
  ) {
    throw new HetznerError(
      `This cursor was issued for connection "${cursor.connection}" and does not belong to connection "${expect.connection}".`,
      'validation',
      'A Hetzner Cloud token is scoped to one project, so a cursor is only meaningful against the connection that produced it.',
    );
  }

  return cursor;
}

function notACursor(raw: string): HetznerError {
  const looksTruncated = raw.startsWith(`${CURSOR_PREFIX}.`);
  return new HetznerError(
    looksTruncated
      ? 'This cursor value is damaged — it carries the right prefix but fails its checksum.'
      : 'This is not a hetzner-mcp cursor value.',
    'validation',
    'Cursors are opaque and are only valid as returned verbatim in meta.next_cursor. The same call without a cursor argument starts at the first page.',
  );
}

// ---------------------------------------------------------------------------
// Paging arithmetic
// ---------------------------------------------------------------------------

/** The cursor state a first (uncursored) call operates under. */
export function firstPage(init: {
  op: string;
  connection?: string;
  perPage?: number;
  query?: Record<string, string | number | boolean>;
}): CursorState {
  return normalize({
    op: init.op,
    page: 1,
    perPage: clampPerPage(init.perPage ?? DEFAULT_PER_PAGE),
    connection: init.connection,
    query: init.query,
  });
}

/** The `page` / `per_page` query a cursor translates into. */
export function toQuery(cursor: CursorState): { page: number; per_page: number } {
  return { page: cursor.page, per_page: cursor.perPage };
}

/**
 * Discard the rows a previous, ladder-truncated page already showed.
 *
 * Applied by the caller after fetching, because only the caller knows whether
 * what came back is the row array or an envelope around it.
 */
export function applySkip<T>(rows: readonly T[], cursor?: CursorState): T[] {
  const skip = cursor?.skip ?? 0;
  return skip > 0 ? rows.slice(skip) : [...rows];
}

/**
 * The cursor for the page after this one, or undefined when there is none.
 *
 * `last_page` is authoritative when Hetzner sends it. When it does not, a short
 * page is the end of the list — asking for the page after a short page returns
 * an empty array, and an empty final page is a wasted round trip and a wasted
 * turn.
 */
export function nextPageCursor(
  cursor: CursorState,
  pagination: Pagination | undefined,
  rowsOnPage?: number,
): string | undefined {
  if (pagination === undefined) return undefined;

  const perPage = clampPerPage(pagination.perPage || cursor.perPage);
  const page = pagination.page > 0 ? pagination.page : cursor.page;
  const lastPage = pagination.lastPage ?? derivedLastPage(pagination.totalEntries, perPage);

  if (lastPage !== undefined) {
    if (page >= lastPage) return undefined;
  } else if (rowsOnPage !== undefined && rowsOnPage < perPage) {
    return undefined;
  }

  return encodeCursor({
    ...cursor,
    page: page + 1,
    perPage,
    skip: 0,
    total: pagination.totalEntries,
  });
}

/**
 * The cursor that resumes inside the page just returned.
 *
 * Minted when the degradation ladder dropped rows: `kept` rows of this page
 * were shown, the rest were not, and they are still on this upstream page.
 * Advancing the page number here would skip them permanently, which is the
 * quiet data-loss bug this whole `skip` field exists to prevent.
 */
export function resumeSamePageCursor(cursor: CursorState, kept: number): string {
  return encodeCursor({ ...cursor, skip: (cursor.skip ?? 0) + Math.max(kept, 0) });
}

function derivedLastPage(totalEntries: number | undefined, perPage: number): number | undefined {
  if (totalEntries === undefined || perPage <= 0) return undefined;
  return Math.max(1, Math.ceil(totalEntries / perPage));
}

function clampPerPage(value: number): number {
  if (!Number.isFinite(value) || value < 1) return DEFAULT_PER_PAGE;
  return Math.min(Math.floor(value), MAX_PER_PAGE);
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Drops absent fields and normalizes defaults, so that encoding a decoded
 * cursor reproduces the original string byte for byte. Without this,
 * `skip: 0` and `skip: undefined` would be two encodings of one state and a
 * round-trip assertion would be a coin flip.
 */
function normalize(state: CursorState): CursorState {
  const out: CursorState = {
    op: state.op,
    page: state.page,
    perPage: clampPerPage(state.perPage),
  };
  if (state.skip !== undefined && state.skip > 0) out.skip = state.skip;
  if (state.connection !== undefined) out.connection = state.connection;
  if (state.query !== undefined && Object.keys(state.query).length > 0) {
    const query: Record<string, string | number | boolean> = {};
    for (const key of Object.keys(state.query).sort()) {
      const value = state.query[key];
      if (value !== undefined) query[key] = value;
    }
    if (Object.keys(query).length > 0) out.query = query;
  }
  if (state.total !== undefined) out.total = state.total;
  return out;
}

/** Key order must not affect the checksum, or the same state could fail its own check. */
function stableStringify(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

/** FNV-1a, 32-bit. Integrity against typos and truncation, not against an adversary. */
function checksum(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isScalarRecord(value: unknown): value is Record<string, string | number | boolean> {
  if (!isPlainObject(value)) return false;
  return Object.values(value).every(
    (v) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean',
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
