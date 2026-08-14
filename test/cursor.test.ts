import { describe, expect, it } from 'vitest';

import { HetznerError } from '../src/types.js';
import {
  applySkip,
  decodeCursor,
  DEFAULT_PER_PAGE,
  encodeCursor,
  firstPage,
  MAX_PER_PAGE,
  nextPageCursor,
  resumeCursor,
  resumeSamePageCursor,
  toQuery,
  type CursorState,
} from '../src/shaping/cursor.js';

function captureError(fn: () => unknown): HetznerError {
  try {
    fn();
  } catch (error: unknown) {
    if (error instanceof HetznerError) return error;
    throw error;
  }
  throw new Error('expected the call to throw');
}

const LIST_SERVERS: CursorState = {
  op: 'list_servers',
  page: 3,
  perPage: 25,
  connection: 'prod',
  query: { label_selector: 'env=prod', sort: 'name:asc' },
  total: 412,
};

// ---------------------------------------------------------------------------
// Round trip
// ---------------------------------------------------------------------------

describe('cursor round trip', () => {
  it('restores every field exactly', () => {
    expect(decodeCursor(encodeCursor(LIST_SERVERS))).toEqual(LIST_SERVERS);
  });

  it('re-encodes to the identical string, so a cursor is stable across hops', () => {
    const encoded = encodeCursor(LIST_SERVERS);

    expect(encodeCursor(decodeCursor(encoded))).toBe(encoded);
  });

  it('does not depend on the key order of the frozen query', () => {
    const a = encodeCursor({ ...LIST_SERVERS, query: { sort: 'name:asc', label_selector: 'x' } });
    const b = encodeCursor({ ...LIST_SERVERS, query: { label_selector: 'x', sort: 'name:asc' } });

    expect(a).toBe(b);
  });

  it('carries the filters, so resuming needs no re-supplied arguments', () => {
    const resumed = decodeCursor(encodeCursor(LIST_SERVERS));

    expect(resumed.query).toEqual({ label_selector: 'env=prod', sort: 'name:asc' });
    expect(resumed.connection).toBe('prod');
  });

  it('is opaque — the page number is not readable from the cursor text', () => {
    const encoded = encodeCursor(LIST_SERVERS);

    expect(encoded).toMatch(/^htz1\.[A-Za-z0-9_-]+\.[0-9a-f]{8}$/);
    expect(encoded).not.toContain('list_servers');
    expect(encoded).not.toContain('page');
  });

  it('maps onto Hetzner page/per_page', () => {
    expect(toQuery(LIST_SERVERS)).toEqual({ page: 3, per_page: 25 });
  });

  it('clamps per_page to what the API accepts', () => {
    expect(firstPage({ op: 'list_servers', perPage: 5000 }).perPage).toBe(MAX_PER_PAGE);
    expect(firstPage({ op: 'list_servers' }).perPage).toBe(DEFAULT_PER_PAGE);
  });
});

// ---------------------------------------------------------------------------
// Invalid cursors
// ---------------------------------------------------------------------------

describe('invalid cursor', () => {
  it.each([
    ['empty', ''],
    ['arbitrary text', 'page 2 please'],
    ['a bare page number', '2'],
    ['base64 without the prefix', Buffer.from('{"page":2}', 'utf8').toString('base64url')],
    ['the right prefix with a garbage body', 'htz1.$$$$.deadbeef'],
    ['a foreign product cursor', 'eyJvZmZzZXQiOjIwLCJxdWVyeUhhc2giOiJhYmMxMjMifQ'],
  ])('rejects %s rather than resetting to page 1', (_label, raw) => {
    const error = captureError(() => decodeCursor(raw));

    expect(error.kind).toBe('validation');
    expect(error.hint).toContain('first page');
  });

  it('rejects a cursor whose payload was tampered with, even with a valid prefix', () => {
    const encoded = encodeCursor(LIST_SERVERS);
    const [prefix, body, sum] = encoded.split('.');
    const forged = JSON.stringify({ ...LIST_SERVERS, page: 999 });
    const tampered = `${prefix}.${Buffer.from(forged, 'utf8').toString('base64url')}.${sum}`;

    expect(tampered).not.toBe(encoded);
    expect(captureError(() => decodeCursor(tampered)).message).toContain('damaged');
    expect(body).toBeDefined();
  });

  it('rejects a structurally valid cursor with an impossible page', () => {
    const json = JSON.stringify({ op: 'list_servers', page: 0, perPage: 25 });
    const body = Buffer.from(json, 'utf8').toString('base64url');
    // Checksum computed the same way the module does, so only the page is wrong.
    const encoded = encodeCursor({ op: 'list_servers', page: 1, perPage: 25 });

    expect(
      captureError(() => decodeCursor(`htz1.${body}.${encoded.split('.')[2] ?? ''}`)).kind,
    ).toBe('validation');
  });
});

// ---------------------------------------------------------------------------
// Foreign cursors
// ---------------------------------------------------------------------------

describe('foreign cursor', () => {
  it('refuses a cursor minted by a different operation', () => {
    const error = captureError(() =>
      resumeCursor(encodeCursor(LIST_SERVERS), { op: 'list_volumes' }),
    );

    expect(error.kind).toBe('validation');
    expect(error.message).toContain('list_servers');
    expect(error.message).toContain('list_volumes');
  });

  it('refuses a cursor minted against a different connection', () => {
    const error = captureError(() =>
      resumeCursor(encodeCursor(LIST_SERVERS), { op: 'list_servers', connection: 'staging' }),
    );

    expect(error.kind).toBe('validation');
    expect(error.message).toContain('"prod"');
    expect(error.message).toContain('"staging"');
  });

  it('accepts a cursor for the same operation and connection', () => {
    const resumed = resumeCursor(encodeCursor(LIST_SERVERS), {
      op: 'list_servers',
      connection: 'prod',
    });

    expect(resumed.page).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Paging arithmetic
// ---------------------------------------------------------------------------

describe('nextPageCursor', () => {
  it('advances while last_page says there is more', () => {
    const raw = nextPageCursor(LIST_SERVERS, { page: 3, perPage: 25, lastPage: 17 });

    expect(raw).toBeDefined();
    expect(decodeCursor(raw as string).page).toBe(4);
  });

  it('stops on the last page', () => {
    expect(nextPageCursor(LIST_SERVERS, { page: 17, perPage: 25, lastPage: 17 })).toBeUndefined();
  });

  it('derives the last page from total_entries when Hetzner omits last_page', () => {
    expect(
      nextPageCursor(LIST_SERVERS, { page: 2, perPage: 25, totalEntries: 40 }),
    ).toBeUndefined();
    expect(nextPageCursor(LIST_SERVERS, { page: 1, perPage: 25, totalEntries: 40 })).toBeDefined();
  });

  it('treats a short page as the end when neither total is known', () => {
    expect(nextPageCursor(LIST_SERVERS, { page: 3, perPage: 25 }, 11)).toBeUndefined();
    expect(nextPageCursor(LIST_SERVERS, { page: 3, perPage: 25 }, 25)).toBeDefined();
  });

  it('carries the filters forward onto the next page', () => {
    const raw = nextPageCursor(LIST_SERVERS, { page: 3, perPage: 25, lastPage: 17 }) as string;

    expect(decodeCursor(raw).query).toEqual(LIST_SERVERS.query);
  });

  it('clears skip once the page advances', () => {
    const raw = nextPageCursor(
      { ...LIST_SERVERS, skip: 11 },
      {
        page: 3,
        perPage: 25,
        lastPage: 17,
      },
    ) as string;

    expect(decodeCursor(raw).skip).toBeUndefined();
  });
});

describe('resuming inside a truncated page', () => {
  it('stays on the same page and records how many rows were already shown', () => {
    const raw = resumeSamePageCursor(LIST_SERVERS, 11);
    const resumed = decodeCursor(raw);

    expect(resumed.page).toBe(3);
    expect(resumed.skip).toBe(11);
  });

  it('accumulates across repeated truncation of the same page', () => {
    const once = decodeCursor(resumeSamePageCursor(LIST_SERVERS, 11));
    const twice = decodeCursor(resumeSamePageCursor(once, 7));

    expect(twice.page).toBe(3);
    expect(twice.skip).toBe(18);
  });

  it('applySkip discards exactly the rows the previous page showed', () => {
    const rows = [1, 2, 3, 4, 5];

    expect(applySkip(rows, { op: 'list_servers', page: 1, perPage: 25, skip: 2 })).toEqual([
      3, 4, 5,
    ]);
    expect(applySkip(rows, { op: 'list_servers', page: 1, perPage: 25 })).toEqual(rows);
    expect(applySkip(rows)).toEqual(rows);
  });

  it('does not mutate the rows it is given', () => {
    const rows = [1, 2, 3];

    applySkip(rows, { op: 'list_servers', page: 1, perPage: 25, skip: 1 });

    expect(rows).toEqual([1, 2, 3]);
  });
});
