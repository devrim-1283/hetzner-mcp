/**
 * Hetzner response -> HetznerError mapping.
 *
 * Every word of failure text the transport can produce lives in this file, so
 * the wording is reviewable in one place and no two hints drift apart.
 *
 * The mapping keys off Hetzner's own `error.code`, not off the status code.
 * That vocabulary is closed and far more specific than the status: `locked`,
 * `protected`, `resource_unavailable` and `uniqueness_error` all arrive as 409
 * or 423 and mean four completely different things to whoever has to fix the
 * call. The status is only the fallback for bodies that carry no code at all.
 *
 * Verified cloud envelope:
 *
 *   {"error":{"code":"invalid_input","message":"invalid input in field 'name'",
 *             "details":{"fields":[{"name":"name","messages":["is too long"]}]}}}
 *
 * Robot's envelope is the same key with a different inside — `error.status`
 * carries the HTTP status again and the code is UPPER_SNAKE (`SERVER_NOT_FOUND`).
 * Codes are compared case-insensitively for that reason, and `apiCode` keeps the
 * original spelling so a report never launders what the API actually said.
 */

import { HetznerError } from '../types.js';
import type { HttpMethod, Surface } from '../types.js';

export type HetznerErrorKind = HetznerError['kind'];

export interface ValidationField {
  name: string;
  messages: string[];
}

export interface HttpErrorContext {
  status: number;
  /** Parsed JSON when the body was JSON, the raw text when it was not. */
  body: unknown;
  method: HttpMethod;
  /** Path as the caller wrote it, e.g. `/servers/42`. */
  path: string;
  connection: string;
  surface: Surface;
  /** Parsed `Retry-After`, in seconds. Only meaningful on 429 and 503. */
  retryAfterSeconds?: number;
  rateLimit?: { limit: number; remaining: number; resetAt?: number };
  /** How many times the request was actually sent, for the rate-limit wording. */
  attempts?: number;
}

export interface NetworkErrorContext {
  connection: string;
  /** Origin only — the full URL is never needed to explain a transport failure. */
  origin: string;
  timeoutMs: number;
  timedOut: boolean;
  cancelled: boolean;
  attempts: number;
}

export interface NonJsonBodyContext {
  status: number;
  contentType: string;
  text: string;
  origin: string;
  connection: string;
  surface: Surface;
}

/** Bounded so a proxy's HTML error page cannot flood the model's context. */
const MAX_SNIPPET = 200;

// ---------------------------------------------------------------------------
// Code vocabulary
// ---------------------------------------------------------------------------

/**
 * Hetzner's `error.code` -> our kind. Lower-cased keys; Robot's UPPER_SNAKE
 * codes normalize into the same table.
 *
 * Deliberately not exhaustive. An unlisted code falls through to the status
 * fallback and lands on `unknown` with `apiCode` preserved verbatim, which is
 * strictly better than guessing: a wrong kind sends the caller down the wrong
 * recovery path, whereas `unknown` plus the real code sends them to the docs.
 */
export const API_CODE_KINDS: Readonly<Record<string, HetznerErrorKind>> = {
  // Cloud + account API, documented vocabulary.
  unauthorized: 'unauthenticated',
  forbidden: 'forbidden',
  token_readonly: 'forbidden',
  not_found: 'not_found',
  invalid_input: 'validation',
  unsupported_error: 'validation',
  uniqueness_error: 'conflict',
  conflict: 'conflict',
  locked: 'locked',
  protected: 'protected',
  resource_limit_exceeded: 'resource_limit',
  resource_unavailable: 'resource_unavailable',
  unavailable: 'resource_unavailable',
  robot_unavailable: 'resource_unavailable',
  rate_limit_exceeded: 'rate_limited',
  maintenance: 'maintenance',
  action_failed: 'action_failed',
  // Server-side faults. `unknown` is the honest kind: nothing about the request
  // needs changing, so none of the actionable kinds would be true.
  json_error: 'unknown',
  service_error: 'unknown',
  server_error: 'unknown',
  internal_error: 'unknown',
};

/**
 * Suffix rules for Robot, which names the resource in the code rather than
 * using one generic value: SERVER_NOT_FOUND, IP_NOT_FOUND, SUBNET_NOT_FOUND,
 * BOOT_NOT_AVAILABLE. Enumerating them would rot every time Robot gains a
 * resource type; the suffix is the part that carries the meaning.
 *
 * UNVERIFIED against the live Robot API. The UPPER_SNAKE casing and the
 * resource-prefixed shape come from Robot's published error tables, but the
 * generalisation to "every code ending in _NOT_FOUND" is ours. Confirmed by
 * running any Robot endpoint against a nonexistent resource of two different
 * types and checking both codes end in the same suffix. Getting it wrong is
 * cheap in one direction only: an unmatched code still lands on `unknown` with
 * `apiCode` intact, so the failure mode is a vaguer hint, never a wrong one.
 */
const CODE_SUFFIX_KINDS: ReadonlyArray<readonly [string, HetznerErrorKind]> = [
  ['_not_found', 'not_found'],
  ['_not_available', 'resource_unavailable'],
  ['_unavailable', 'resource_unavailable'],
  ['_conflict', 'conflict'],
];

function kindForCode(code: string | undefined): HetznerErrorKind | undefined {
  if (!code) return undefined;
  const normalized = code.trim().toLowerCase();
  const exact = API_CODE_KINDS[normalized];
  if (exact) return exact;
  for (const [suffix, kind] of CODE_SUFFIX_KINDS) {
    if (normalized.endsWith(suffix)) return kind;
  }
  return undefined;
}

function kindForStatus(status: number): HetznerErrorKind {
  if (status === 401) return 'unauthenticated';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 423) return 'locked';
  if (status === 429) return 'rate_limited';
  if (status === 400 || status === 422) return 'validation';
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Body reading
// ---------------------------------------------------------------------------

interface ParsedBody {
  code?: string;
  message?: string;
  fields?: ValidationField[];
}

function snippet(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  return trimmed.length > MAX_SNIPPET ? `${trimmed.slice(0, MAX_SNIPPET)}…` : trimmed;
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Cloud's `details.fields`, kept verbatim.
 *
 * The per-field messages are never reworded: Hetzner knows why it rejected the
 * value and we do not. Only the container is normalized, so a field carrying a
 * bare string instead of an array still satisfies the contract.
 */
function readFields(details: unknown): ValidationField[] | undefined {
  const raw = record(details)?.['fields'];
  if (!Array.isArray(raw)) return undefined;

  const fields: ValidationField[] = [];
  for (const entry of raw) {
    const field = record(entry);
    const name = stringOf(field?.['name']);
    if (!name) continue;
    const messages = field?.['messages'];
    if (typeof messages === 'string') {
      fields.push({ name, messages: [messages] });
      continue;
    }
    const list = Array.isArray(messages)
      ? messages.filter((message): message is string => typeof message === 'string')
      : [];
    fields.push({ name, messages: list });
  }
  return fields.length > 0 ? fields : undefined;
}

/**
 * Robot reports validation failures as `missing` and `invalid` arrays of field
 * names rather than as cloud's `fields`. Lifting them into the same shape means
 * the tool layer renders one thing instead of branching on the surface.
 *
 * UNVERIFIED against the live Robot API. The `{error:{status,code,message}}`
 * envelope and the `missing`/`invalid` arrays are read off Robot's published
 * examples; nobody has seen a real one. Confirmed by POSTing to any Robot
 * endpoint with a required parameter omitted and comparing the body to this
 * shape — in particular whether the arrays hold bare field names (assumed here)
 * or objects. If they hold objects, `validationErrors` silently comes back
 * empty rather than wrong, which is the failure mode this was written for.
 */
function readRobotFields(error: Record<string, unknown>): ValidationField[] | undefined {
  const fields: ValidationField[] = [];
  for (const [key, label] of [
    ['missing', 'is required'],
    ['invalid', 'is invalid'],
  ] as const) {
    const raw = error[key];
    if (!Array.isArray(raw)) continue;
    for (const name of raw) {
      if (typeof name === 'string' && name.trim()) fields.push({ name, messages: [label] });
    }
  }
  return fields.length > 0 ? fields : undefined;
}

function parseBody(body: unknown): ParsedBody {
  // A non-JSON body reached us as raw text: a proxy error page, or Robot's
  // occasional plain-text refusal. All we can honestly report is what it said.
  if (typeof body === 'string') {
    const text = snippet(body);
    return text ? { message: text } : {};
  }

  const envelope = record(body);
  if (!envelope) return {};

  const error = record(envelope['error']);
  if (!error) {
    // No `error` key at all. Some Robot endpoints answer with a bare object and
    // a non-2xx status; `message` is the only thing worth salvaging.
    return { message: stringOf(envelope['message']) };
  }

  const parsed: ParsedBody = {
    code: stringOf(error['code']),
    message: stringOf(error['message']),
  };
  const fields = readFields(error['details']) ?? readRobotFields(error);
  if (fields) parsed.fields = fields;
  return parsed;
}

// ---------------------------------------------------------------------------
// Wording
// ---------------------------------------------------------------------------

function formatDuration(seconds: number): string {
  if (seconds <= 1) return 'about a second';
  if (seconds < 90) return `about ${Math.round(seconds)} seconds`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `about ${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.round(minutes / 60);
  return `about ${hours} hour${hours === 1 ? '' : 's'}`;
}

/**
 * "when the quota resets" in words a person can act on, plus the absolute time
 * so a transcript read an hour later is still interpretable.
 */
function resetPhrase(ctx: HttpErrorContext): string {
  const resetAt = ctx.rateLimit?.resetAt;
  if (resetAt !== undefined) {
    const seconds = Math.max(0, resetAt - Date.now() / 1000);
    return `The quota resets in ${formatDuration(seconds)}, at ${new Date(resetAt * 1000).toISOString()}.`;
  }
  if (ctx.retryAfterSeconds !== undefined) {
    return `Hetzner asked for a wait of ${formatDuration(ctx.retryAfterSeconds)} (Retry-After: ${ctx.retryAfterSeconds}s).`;
  }
  return 'Hetzner sent neither RateLimit-Reset nor Retry-After, so the reset time is unknown — treat it as up to an hour.';
}

function summarize(parsed: ParsedBody, fallback: string): string {
  return parsed.message ?? fallback;
}

const CLOUD_PROJECT_SCOPING =
  'A Hetzner Cloud token belongs to exactly ONE project and there is no project parameter in the API, ' +
  "so a perfectly valid token pointed at another project's resource answers 404, not 403. " +
  'Confirm the token in this connection was created inside the project that owns the resource; ' +
  'a second project needs a second token, which is a second connection.';

function unauthenticatedHint(ctx: HttpErrorContext): string {
  if (ctx.surface === 'cloud') {
    return (
      `Hetzner rejected the credential for connection \`${ctx.connection}\`. ` +
      `Check first that the token is present and not revoked — then check the project. ` +
      CLOUD_PROJECT_SCOPING
    );
  }
  if (ctx.surface === 'robot') {
    return (
      `Robot rejected the HTTP Basic credentials for connection \`${ctx.connection}\`. ` +
      'Robot does not accept your Hetzner account login: it needs a dedicated webservice user, ' +
      'created under Robot → Settings → Webservice and app users, and a newly created one can take ' +
      'a few minutes before it starts working.'
    );
  }
  return (
    `Hetzner rejected the token for connection \`${ctx.connection}\`. ` +
    'The account-scoped API at api.hetzner.com uses its own tokens — a Cloud project token issued ' +
    'in the Cloud Console is not accepted here.'
  );
}

function notFoundHint(ctx: HttpErrorContext): string {
  const base = `Nothing at \`${ctx.path}\` on connection \`${ctx.connection}\`.`;
  if (ctx.surface === 'cloud') {
    return `${base} Either the id is wrong or the resource lives in another project. ${CLOUD_PROJECT_SCOPING}`;
  }
  return `${base} Confirm the id with the matching list operation before retrying.`;
}

function validationHint(parsed: ParsedBody): string {
  const names = parsed.fields?.map((field) => field.name) ?? [];
  if (names.length > 0) {
    return (
      `Hetzner rejected these fields: ${names.join(', ')}. The per-field messages in ` +
      '`validationErrors` come from Hetzner and are authoritative — fix the values and retry. ' +
      'Nothing was created, so this is safe to repeat.'
    );
  }
  return (
    'Hetzner rejected the request body or a query parameter. Its message names the problem; ' +
    'nothing was created, so a corrected request is safe to send.'
  );
}

/**
 * The hint that saves a rebuild.
 *
 * Protection is not a permission problem and not a lock that clears on its own —
 * somebody switched it on deliberately, and the only way past it is to switch it
 * off. Naming the action matters: without it the obvious next move is to hunt
 * for a token permission that does not exist.
 */
function protectedHint(): string {
  return (
    'This resource has protection enabled, and Hetzner refuses delete and rebuild while it is on. ' +
    'It is not a token permission and it does not expire — protection must be removed first, with ' +
    'the `change_protection` action on the resource (POST /<resource>/{id}/actions/change_protection, ' +
    'setting `delete: false`, and `rebuild: false` as well for servers). Protection was switched on ' +
    'deliberately by someone; confirm with them before removing it, then retry the original call.'
  );
}

function hintFor(kind: HetznerErrorKind, ctx: HttpErrorContext, parsed: ParsedBody): string {
  switch (kind) {
    case 'unauthenticated':
      return unauthenticatedHint(ctx);
    case 'forbidden':
      return (
        `The credential for connection \`${ctx.connection}\` is valid but not allowed to do this. ` +
        'Cloud token permissions are fixed when the token is created — a read-only token cannot be ' +
        'upgraded, so issue a new token with read-write access and update the connection. On Robot, ' +
        'the webservice user must own the server it is acting on.'
      );
    case 'not_found':
      return notFoundHint(ctx);
    case 'validation':
      return validationHint(parsed);
    case 'conflict':
      return (
        'A resource with that name already exists. Hetzner requires names to be unique per project ' +
        'and per resource type. Pick a different name, or look up the existing resource and use it ' +
        'instead of creating a second one.'
      );
    case 'locked':
      return (
        'The resource is locked because another Action is still running on it. Locks are temporary ' +
        'and clear themselves: poll `GET /actions/{id}` for the Action that holds it, then retry. ' +
        'Nothing needs to be changed about this request.'
      );
    case 'protected':
      return protectedHint();
    case 'resource_limit':
      return (
        'The project is at a Hetzner quota, not at a token permission. Limits apply per project to ' +
        'servers, volumes, floating IPs, networks and traffic, and new accounts start low. Free ' +
        'something up, or ask Hetzner support to raise the limit — retrying will not help.'
      );
    case 'resource_unavailable':
      return (
        'Hetzner has no capacity for this combination right now. A server type is routinely sold out ' +
        'in one location while available in another, so try a different location or datacenter, or a ' +
        'different server type. Retrying the same combination immediately will keep failing.'
      );
    case 'rate_limited':
      return rateLimitedHint(ctx);
    case 'maintenance':
      return (
        'Hetzner is performing maintenance on this resource or API. Nothing is wrong with the ' +
        'request; it will succeed once the maintenance window ends. Check https://status.hetzner.com ' +
        'for the window.'
      );
    case 'action_failed':
      return (
        'The Action Hetzner started for this call finished with an error. The Action carries its own ' +
        '`error.code` and `error.message` — read those rather than re-sending the request, since the ' +
        'request itself was accepted.'
      );
    default:
      return unknownHint(ctx);
  }
}

function rateLimitedHint(ctx: HttpErrorContext): string {
  const attempts =
    ctx.attempts && ctx.attempts > 1
      ? ` ${ctx.attempts} attempts were made and all were refused.`
      : '';
  const quota =
    ctx.surface === 'robot'
      ? // UNVERIFIED: the per-endpoint hourly limits are documented, but whether
        // Robot sends Retry-After alongside its 429 is not, so `resetPhrase`
        // may well fall through to "unknown". Confirmed by exhausting one cheap
        // Robot endpoint and reading the response headers.
        'Robot limits per endpoint per hour, and some are as low as 50/hour (resets, for example).'
      : 'Hetzner Cloud allows 3600 requests per hour and the whole project shares one bucket, ' +
        'so every other tool using this token is blocked too.';
  return (
    `${resetPhrase(ctx)}${attempts} ${quota} Stop calling until the reset — retrying sooner extends ` +
    'the block and starves the other clients on the same token.'
  );
}

function unknownHint(ctx: HttpErrorContext): string {
  if (ctx.status >= 500) {
    return (
      `Hetzner returned ${ctx.status}. This is a failure on their side, not a problem with the ` +
      'request. Check https://status.hetzner.com, then retry — but verify state first if the call ' +
      'was a POST, because a 5xx does not prove the work did not happen.'
    );
  }
  return (
    `Hetzner returned ${ctx.status} with a code this client does not recognise. The \`apiCode\` ` +
    'field carries it verbatim; look it up in the Hetzner API docs rather than inferring from the ' +
    'status alone.'
  );
}

// ---------------------------------------------------------------------------
// HTTP failures
// ---------------------------------------------------------------------------

export function mapHttpError(ctx: HttpErrorContext): HetznerError {
  const parsed = parseBody(ctx.body);
  // The code wins over the status whenever we recognise it: `protected` and
  // `locked` are both 423, `uniqueness_error` and `resource_unavailable` are
  // both 409, and each pair needs a different thing done about it.
  const kind = kindForCode(parsed.code) ?? kindForStatus(ctx.status);

  return new HetznerError(
    summarize(parsed, `Hetzner returned ${ctx.status} for ${ctx.method} ${ctx.path}.`),
    kind,
    hintFor(kind, ctx, parsed),
    ctx.status,
    parsed.code,
    parsed.fields,
  );
}

/**
 * A 2xx whose body is not JSON.
 *
 * Reported as a mapped error rather than allowed to surface as a JSON parse
 * exception: `Unexpected token < in JSON at position 0` tells the reader
 * nothing, while the content type and the first line of the body usually name
 * the proxy or captive portal that answered instead of Hetzner.
 */
export function mapNonJsonBody(ctx: NonJsonBodyContext): HetznerError {
  const what = ctx.contentType ? `\`${ctx.contentType}\`` : 'a body with no content type';
  const body = snippet(ctx.text);
  return new HetznerError(
    `${ctx.origin} answered ${ctx.status} with ${what} instead of JSON${body ? `: ${body}` : ''}.`,
    'unknown',
    `Every Hetzner ${ctx.surface} endpoint answers JSON, so something else answered this request — ` +
      'usually a proxy, a captive portal, or a network appliance intercepting TLS on the path from ' +
      `the machine running connection \`${ctx.connection}\`.`,
    ctx.status,
  );
}

// ---------------------------------------------------------------------------
// Transport failures
// ---------------------------------------------------------------------------

/** Walks the `cause` chain for a Node error code. Depth-bounded against cycles. */
export function errorCode(error: unknown, depth = 0): string | undefined {
  if (depth > 5 || typeof error !== 'object' || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string') return code;
  return errorCode((error as { cause?: unknown }).cause, depth + 1);
}

/**
 * Failures where the request provably never reached Hetzner's application.
 *
 * DNS never resolved, or the TCP handshake was refused outright — in both cases
 * no request bytes were delivered to anything that could act on them. This is
 * the ONLY class of transport failure a POST may be retried on; see the retry
 * policy in client.ts for why that distinction is worth a dedicated predicate.
 *
 * ECONNRESET and ETIMEDOUT are deliberately absent: a reset can arrive after the
 * server read and acted on the request.
 */
export function isDefinitePreSendFailure(error: unknown): boolean {
  const code = errorCode(error);
  return code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'ECONNREFUSED';
}

const TLS_TRUST_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

export function mapNetworkError(cause: unknown, ctx: NetworkErrorContext): HetznerError {
  // Checked before the timeout, and kept distinct from it.
  //
  // Both end in an aborted socket, and they mean opposite things. A request that
  // ran out of ITS OWN budget failed and the user should see it. A caller that
  // went away did not fail at all, and rendering it as a fault sends someone to
  // check their DNS over a turn that was simply cancelled.
  if (ctx.cancelled) {
    return new HetznerError(
      `Request to ${ctx.origin} was cancelled by the caller.`,
      'cancelled',
      'The MCP host cancelled this tool call. Nothing is wrong with the connection or the ' +
        'credential. If the call was a POST, the request may still have been delivered — check ' +
        'state before re-sending it.',
    );
  }
  if (ctx.timedOut) {
    return new HetznerError(
      `Request to ${ctx.origin} timed out after ${ctx.timeoutMs} ms.`,
      'network',
      `Raise \`timeoutMs\` for connection \`${ctx.connection}\`, or check that the host is ` +
        'reachable. The timeout covers all attempts including any retry wait, so a long ' +
        'Retry-After can consume it on its own.',
    );
  }

  const code = errorCode(cause);
  if (code && TLS_TRUST_CODES.has(code)) {
    return new HetznerError(
      `TLS certificate for ${ctx.origin} was not trusted (${code}).`,
      'network',
      'Hetzner serves a publicly trusted certificate, so this almost always means a TLS-inspecting ' +
        'proxy sits on the path. Point NODE_EXTRA_CA_CERTS at that proxy CA. There is deliberately ' +
        'no setting that turns certificate checking off, because doing so would expose the ' +
        'credential to anyone on the network path.',
    );
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return new HetznerError(
      `Could not resolve ${ctx.origin} (${code}).`,
      'network',
      `DNS did not answer for the Hetzner API host used by connection \`${ctx.connection}\`. ` +
        'The host name is derived from the surface and is never user-supplied, so suspect local DNS ' +
        'or an offline machine rather than a typo.',
    );
  }
  if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'EHOSTUNREACH') {
    return new HetznerError(
      `Could not reach ${ctx.origin} (${code}) after ${ctx.attempts} attempt(s).`,
      'network',
      'Nothing accepted the connection. Check outbound network access from the machine running the ' +
        'server; a corporate egress proxy is the usual cause.',
    );
  }

  const detail = cause instanceof Error ? snippet(cause.message) : 'unknown transport failure';
  return new HetznerError(
    `Request to ${ctx.origin} failed after ${ctx.attempts} attempt(s): ${detail}`,
    'network',
  );
}
