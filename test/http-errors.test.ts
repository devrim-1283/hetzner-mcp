/**
 * The error mapper is the part of the transport a person actually reads.
 *
 * Two things are asserted here that a looser suite would skip, and both are
 * load-bearing:
 *
 *   1. The CONTENT of the hints, not just their presence. A hint that decays
 *      into "check your credentials" still passes `toBeDefined()` while costing
 *      its reader the hour it was written to save. The two that matter most —
 *      `protected` and an unauthenticated `cloud` connection — are asserted on
 *      the specific fact they exist to convey.
 *
 *   2. That an UNRECOGNISED code survives. Hetzner's vocabulary is closed but
 *      not frozen, and the failure mode of a mapper is to quietly swallow the
 *      one code that would have explained everything. `apiCode` must come back
 *      verbatim even when the kind is `unknown`.
 */

import { describe, expect, it } from 'vitest';

import { HetznerError } from '../src/types.js';
import {
  API_CODE_KINDS,
  errorCode,
  isDefinitePreSendFailure,
  mapHttpError,
  mapNetworkError,
  mapNonJsonBody,
} from '../src/http/errors.js';
import type { HetznerErrorKind, HttpErrorContext } from '../src/http/errors.js';

function ctx(overrides: Partial<HttpErrorContext> = {}): HttpErrorContext {
  return {
    status: 400,
    body: undefined,
    method: 'GET',
    path: '/servers/42',
    connection: 'main',
    surface: 'cloud',
    ...overrides,
  };
}

/** The cloud envelope, as Hetzner actually spells it. */
function cloudError(code: string, message = 'something went wrong', details?: unknown): unknown {
  return { error: details === undefined ? { code, message } : { code, message, details } };
}

// ---------------------------------------------------------------------------
// The code vocabulary
// ---------------------------------------------------------------------------

/** The mapping the brief pins down, asserted one row at a time. */
const CODE_CASES: Array<[code: string, status: number, kind: HetznerErrorKind]> = [
  ['unauthorized', 401, 'unauthenticated'],
  ['forbidden', 403, 'forbidden'],
  ['not_found', 404, 'not_found'],
  ['invalid_input', 422, 'validation'],
  ['uniqueness_error', 409, 'conflict'],
  ['locked', 423, 'locked'],
  ['protected', 423, 'protected'],
  ['resource_limit_exceeded', 403, 'resource_limit'],
  ['resource_unavailable', 409, 'resource_unavailable'],
  ['rate_limit_exceeded', 429, 'rate_limited'],
  ['maintenance', 503, 'maintenance'],
  ['json_error', 400, 'unknown'],
  ['service_error', 500, 'unknown'],
];

const STATUS_FALLBACK_CASES: Array<[status: number, kind: HetznerErrorKind]> = [
  [401, 'unauthenticated'],
  [403, 'forbidden'],
  [404, 'not_found'],
  [409, 'conflict'],
  [423, 'locked'],
  [429, 'rate_limited'],
  [422, 'validation'],
  [500, 'unknown'],
  [502, 'unknown'],
];

describe('error.code drives the kind', () => {
  it.each(CODE_CASES)('maps %s to %s', (code, status, kind) => {
    const error = mapHttpError(ctx({ status, body: cloudError(code) }));

    expect(error).toBeInstanceOf(HetznerError);
    expect(error.kind).toBe(kind);
    expect(error.apiCode).toBe(code);
    expect(error.status).toBe(status);
    expect(error.hint).toBeTruthy();
  });

  it('lets the code win over the status when the two disagree', () => {
    // `locked` and `protected` are both 423 and need opposite things done about
    // them: one clears itself, the other never does.
    const locked = mapHttpError(ctx({ status: 423, body: cloudError('locked') }));
    const isProtected = mapHttpError(ctx({ status: 423, body: cloudError('protected') }));

    expect(locked.kind).toBe('locked');
    expect(isProtected.kind).toBe('protected');
  });

  it("normalizes Robot's UPPER_SNAKE codes into the same table", () => {
    const error = mapHttpError(
      ctx({
        status: 404,
        surface: 'robot',
        body: { error: { status: 404, code: 'SERVER_NOT_FOUND', message: 'server not found' } },
      }),
    );

    expect(error.kind).toBe('not_found');
    // The original spelling survives — a report must not launder what Robot said.
    expect(error.apiCode).toBe('SERVER_NOT_FOUND');
  });

  it('resolves an unlisted Robot code by its suffix', () => {
    const error = mapHttpError(
      ctx({ status: 404, surface: 'robot', body: { error: { code: 'SUBNET_NOT_FOUND' } } }),
    );

    expect(error.kind).toBe('not_found');
  });
});

describe('an unrecognised code is never swallowed', () => {
  it('falls back to unknown while preserving the code verbatim', () => {
    const error = mapHttpError(ctx({ status: 418, body: cloudError('some_future_code', 'nope') }));

    expect(error.kind).toBe('unknown');
    expect(error.apiCode).toBe('some_future_code');
    expect(error.message).toBe('nope');
    expect(error.hint).toContain('apiCode');
  });

  it('does not invent a code when the body carries none', () => {
    const error = mapHttpError(ctx({ status: 404, body: { message: 'gone' } }));

    expect(error.kind).toBe('not_found');
    expect(error.apiCode).toBeUndefined();
  });

  it.each(STATUS_FALLBACK_CASES)('falls back to the status: %i -> %s', (status, kind) => {
    expect(mapHttpError(ctx({ status, body: {} })).kind).toBe(kind);
  });
});

// ---------------------------------------------------------------------------
// details.fields
// ---------------------------------------------------------------------------

describe('validation details', () => {
  it('lifts details.fields into validationErrors', () => {
    const error = mapHttpError(
      ctx({
        status: 422,
        method: 'POST',
        path: '/servers',
        body: cloudError('invalid_input', 'invalid input in fields', {
          fields: [
            { name: 'name', messages: ['is too long', 'must be a valid hostname'] },
            { name: 'server_type', messages: ['is unknown'] },
          ],
        }),
      }),
    );

    expect(error.kind).toBe('validation');
    expect(error.validationErrors).toEqual([
      { name: 'name', messages: ['is too long', 'must be a valid hostname'] },
      { name: 'server_type', messages: ['is unknown'] },
    ]);
    // The hint names the fields so the reader does not have to open the object.
    expect(error.hint).toContain('name');
    expect(error.hint).toContain('server_type');
  });

  it('normalizes a field whose messages arrived as a bare string', () => {
    const error = mapHttpError(
      ctx({
        status: 422,
        body: cloudError('invalid_input', 'bad', {
          fields: [{ name: 'ssh_keys', messages: 'nope' }],
        }),
      }),
    );

    expect(error.validationErrors).toEqual([{ name: 'ssh_keys', messages: ['nope'] }]);
  });

  it("lifts Robot's missing/invalid arrays into the same shape", () => {
    const error = mapHttpError(
      ctx({
        status: 400,
        surface: 'robot',
        body: {
          error: {
            status: 400,
            code: 'INVALID_INPUT',
            message: 'invalid input',
            missing: ['ip'],
            invalid: ['lang'],
          },
        },
      }),
    );

    expect(error.kind).toBe('validation');
    expect(error.validationErrors).toEqual([
      { name: 'ip', messages: ['is required'] },
      { name: 'lang', messages: ['is invalid'] },
    ]);
  });

  it('leaves validationErrors undefined when there are none', () => {
    expect(
      mapHttpError(ctx({ status: 422, body: cloudError('invalid_input') })).validationErrors,
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The two hints that earn their keep
// ---------------------------------------------------------------------------

describe('the `protected` hint', () => {
  const error = mapHttpError(
    ctx({ status: 423, method: 'DELETE', body: cloudError('protected', 'resource is protected') }),
  );

  it('says protection must be removed first', () => {
    expect(error.hint).toMatch(/protection must be removed first/i);
  });

  it('names the action that removes it', () => {
    expect(error.hint).toContain('change_protection');
  });

  it('says it is not a permission problem, which is where the reader would otherwise go', () => {
    expect(error.hint).toMatch(/not a token permission/i);
  });
});

describe('the `unauthenticated` hint on a cloud connection', () => {
  const error = mapHttpError(
    ctx({ status: 401, body: cloudError('unauthorized', 'unable to authenticate') }),
  );

  it('explains that a cloud token is scoped to ONE project', () => {
    expect(error.hint).toMatch(/belongs to exactly ONE project/);
  });

  it('warns that another project answers 404 rather than 403', () => {
    // This is the actual cause the user would otherwise chase for an hour: the
    // symptom of a cross-project id is a 404, which reads like a wrong id.
    expect(error.hint).toMatch(/answers 404, not 403/);
  });

  it('says a second project needs a second connection', () => {
    expect(error.hint).toMatch(/second connection/);
  });

  it('does not say any of that on a robot connection', () => {
    const robot = mapHttpError(
      ctx({ status: 401, surface: 'robot', body: { error: { code: 'UNAUTHORIZED' } } }),
    );

    expect(robot.kind).toBe('unauthenticated');
    expect(robot.hint).toMatch(/webservice user/i);
    expect(robot.hint).not.toMatch(/project/i);
  });

  it('points an account-surface failure at the right token type', () => {
    const account = mapHttpError(ctx({ status: 401, surface: 'hetzner', body: {} }));

    expect(account.hint).toMatch(/api\.hetzner\.com/);
  });
});

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

describe('the rate_limited hint states when the quota resets', () => {
  it('converts RateLimit-Reset into human terms and an absolute time', () => {
    const resetAt = Math.round(Date.now() / 1000) + 240;
    const error = mapHttpError(
      ctx({
        status: 429,
        body: cloudError('rate_limit_exceeded', 'limit exceeded'),
        rateLimit: { limit: 3600, remaining: 0, resetAt },
        attempts: 3,
      }),
    );

    expect(error.kind).toBe('rate_limited');
    expect(error.hint).toMatch(/resets in about 4 minutes/);
    expect(error.hint).toContain(new Date(resetAt * 1000).toISOString());
    expect(error.hint).toContain('3 attempts');
  });

  it('falls back to Retry-After when no reset header arrived', () => {
    const error = mapHttpError(ctx({ status: 429, body: {}, retryAfterSeconds: 30 }));

    expect(error.hint).toMatch(/about 30 seconds/);
  });

  it('says plainly that the reset time is unknown when Hetzner sent neither', () => {
    const error = mapHttpError(ctx({ status: 429, body: {} }));

    expect(error.hint).toMatch(/reset time is unknown/);
  });

  it('names the shared cloud quota, because exhausting it breaks other clients', () => {
    expect(mapHttpError(ctx({ status: 429, body: {} })).hint).toContain('3600 requests per hour');
  });

  it("names Robot's much lower per-endpoint limit instead, on robot", () => {
    const error = mapHttpError(ctx({ status: 429, surface: 'robot', body: {} }));

    expect(error.hint).toMatch(/50\/hour/);
  });
});

// ---------------------------------------------------------------------------
// Bodies that are not the envelope
// ---------------------------------------------------------------------------

describe('non-envelope bodies', () => {
  it('salvages a plain-text body as the message', () => {
    const error = mapHttpError(ctx({ status: 502, body: '<html><body>Bad Gateway</body></html>' }));

    expect(error.kind).toBe('unknown');
    expect(error.message).toContain('Bad Gateway');
  });

  it('truncates a body long enough to flood the context', () => {
    const error = mapHttpError(ctx({ status: 502, body: 'x'.repeat(5_000) }));

    expect(error.message.length).toBeLessThan(300);
  });

  it('reports what a non-JSON success body actually was', () => {
    const error = mapNonJsonBody({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      text: '<html>captive portal</html>',
      origin: 'https://api.hetzner.cloud',
      connection: 'main',
      surface: 'cloud',
    });

    expect(error.kind).toBe('unknown');
    expect(error.message).toContain('text/html');
    expect(error.message).toContain('captive portal');
    expect(error.hint).toMatch(/proxy|captive portal/i);
  });
});

// ---------------------------------------------------------------------------
// Transport failures
// ---------------------------------------------------------------------------

describe('mapNetworkError', () => {
  const base = {
    connection: 'main',
    origin: 'https://api.hetzner.cloud',
    timeoutMs: 30_000,
    attempts: 1,
  };

  it('maps a caller cancellation to `cancelled`, never to `network`', () => {
    const error = mapNetworkError(new Error('aborted'), {
      ...base,
      cancelled: true,
      timedOut: false,
    });

    expect(error.kind).toBe('cancelled');
    expect(error.message).toMatch(/cancelled by the caller/);
  });

  it('reports a timeout as a timeout, with the budget that was exceeded', () => {
    const error = mapNetworkError(new Error('aborted'), {
      ...base,
      cancelled: false,
      timedOut: true,
    });

    expect(error.kind).toBe('network');
    expect(error.message).toContain('30000 ms');
    expect(error.hint).toContain('timeoutMs');
  });

  it('recognises a DNS failure through the cause chain', () => {
    const cause = Object.assign(new Error('getaddrinfo'), { code: 'ENOTFOUND' });
    const error = mapNetworkError(new TypeError('fetch failed', { cause }), {
      ...base,
      cancelled: false,
      timedOut: false,
    });

    expect(error.message).toContain('ENOTFOUND');
  });

  it('refuses to suggest disabling TLS verification', () => {
    const cause = Object.assign(new Error('self signed'), { code: 'SELF_SIGNED_CERT_IN_CHAIN' });
    const error = mapNetworkError(new TypeError('fetch failed', { cause }), {
      ...base,
      cancelled: false,
      timedOut: false,
    });

    expect(error.hint).toContain('NODE_EXTRA_CA_CERTS');
    expect(error.hint).not.toMatch(/insecure|rejectUnauthorized|skip verification/i);
  });
});

describe('errorCode', () => {
  it('walks the cause chain', () => {
    const inner = Object.assign(new Error('inner'), { code: 'ECONNREFUSED' });
    expect(errorCode(new Error('outer', { cause: inner }))).toBe('ECONNREFUSED');
  });

  it('gives up rather than looping on a cycle', () => {
    const looped: { cause?: unknown } = {};
    looped.cause = looped;
    expect(errorCode(looped)).toBeUndefined();
  });
});

describe('isDefinitePreSendFailure', () => {
  it.each(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED'])('accepts %s', (code) => {
    expect(isDefinitePreSendFailure(Object.assign(new Error('x'), { code }))).toBe(true);
  });

  it.each(['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'UND_ERR_SOCKET'])(
    'rejects %s, where the request may already have been acted on',
    (code) => {
      expect(isDefinitePreSendFailure(Object.assign(new Error('x'), { code }))).toBe(false);
    },
  );

  it('rejects an error with no code at all', () => {
    expect(isDefinitePreSendFailure(new Error('mystery'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The table itself
// ---------------------------------------------------------------------------

describe('API_CODE_KINDS', () => {
  it('is keyed in lower case, since Robot arrives in upper', () => {
    for (const code of Object.keys(API_CODE_KINDS)) {
      expect(code).toBe(code.toLowerCase());
    }
  });
});
