/**
 * `manage_dns` — Hetzner Cloud Zones and RRSets.
 *
 * DNS moved into the Cloud API, so a zone is a project-scoped cloud resource
 * reached with the same token as a server. Two things about Hetzner's model
 * shape this entire file, and getting either wrong is how a tool silently
 * deletes somebody's DNS.
 *
 * 1. RECORD SETS, NOT RECORDS. Hetzner has no concept of "one DNS record".
 *    The addressable thing is an RRSet, identified by the triple
 *    (zone, rr_name, rr_type), which holds a LIST of values sharing one TTL.
 *    So every RRSet route carries three path parameters, not one, and any code
 *    that assumes a single `{id}` breaks on all of them. Zones themselves are
 *    addressed by `{id_or_name}` — a domain name works directly, and forcing a
 *    numeric id for a zone would be gratuitous when the caller already knows
 *    the name and Hetzner already accepts it.
 *
 * 2. NOTHING DESTRUCTIVE IS REACHABLE FROM HERE. `set_records` replaces the
 *    whole record set in one call, so "add a subdomain" expressed as
 *    `set_records` deletes every other record of that name and type and reports
 *    success. `import_zonefile` does the same to a whole zone, and `delete_zone`
 *    destroys every record of every name and type at once. Hetzner's own catalog
 *    classifies all three as destructive, and all three are refused by name with
 *    a pointer to `execute_destructive_operation`.
 *
 *    The refusal is not a `if (name === 'set_records')` special case that a
 *    later edit can quietly drop: every operation in the table below is looked
 *    up in the catalog at dispatch time and refused if it is classified
 *    destructive, so a blind-replace verb added to the table later fails closed
 *    rather than open.
 *
 *    There is no exception, and the reason is annotation honesty rather than
 *    caution. `destructiveHint: false` is read by hosts to decide what may be
 *    auto-approved, so it has to be true of everything the tool can reach.
 *    Enforcing zone deletion at the transport would make it SAFE without making
 *    the annotation TRUE. Refusing the smaller destruction while permitting the
 *    larger one would also be incoherent: a reader would rightly conclude the
 *    classification was arbitrary.
 *
 * Secondary zones are absent for a different reason: they are configured with
 * primary nameserver addresses and TSIG keys, and no parameter in this server
 * accepts a host or a credential. `create_zone` with `primary_nameservers` is
 * reachable through the generic write door.
 */

import { z } from 'zod';

import { getOperation } from '../catalog/index.js';
import { request } from '../http/client.js';
import { HetznerError } from '../types.js';
import type {
  ActionRef,
  Connection,
  HttpMethod,
  ServerConfig,
  Surface,
  ToolDef,
  ToolExtra,
  ToolResult,
} from '../types.js';
import {
  DESTRUCTIVE_ENABLEMENT,
  attachAction,
  awaitAction,
  connectionProperty,
  optionalNumber,
  optionalString,
  readAction,
  readWaitMs,
  renderEnvelope,
  requiredString,
  resolveConnection,
  runTool,
  shapeResponse,
  toRecord,
  unsettledHint,
  validationFrom,
  waitProperty,
} from './shared.js';

// ---------------------------------------------------------------------------
// Constants read out of the vendored spec
// ---------------------------------------------------------------------------

/** Zones are cloud-surface resources; the account and Robot APIs have no DNS. */
const CLOUD: readonly Surface[] = ['cloud'];

const CONNECTION_OPTS = { requireExplicit: true, surfaces: CLOUD } as const;

/** `type` enum of an RRSet, verbatim from the OpenAPI document. */
const RECORD_TYPES = [
  'A',
  'AAAA',
  'CAA',
  'CNAME',
  'DS',
  'HINFO',
  'HTTPS',
  'MX',
  'NS',
  'PTR',
  'RP',
  'SOA',
  'SRV',
  'SVCB',
  'TLSA',
  'TXT',
] as const;

type RecordType = (typeof RECORD_TYPES)[number];

const MIN_TTL = 60;
const MAX_TTL = 2_147_483_647;

/** `maxItems` on the add/remove/update record actions. */
const MAX_RECORDS = 50;

/** Generous enough for a DKIM public key split across quoted chunks. */
const MAX_RECORD_VALUE = 4096;

const MAX_ZONE_NAME = 255;

/** The label used for the zone apex, in Hetzner's spelling. */
const APEX = '@';

/** Hetzner's documented per-page ceiling; the default is 25. */
const MAX_PER_PAGE = 50;

/**
 * Whether `GET /zones/{id_or_name}/rrsets` accepts page/per_page, read from the
 * generated catalog rather than assumed: 38 of the cloud API's 82 GETs do, and
 * sending the parameter to one that does not is at best ignored.
 */
const RRSET_LIST_PAGINATED = getOperation('list_zone_rrsets')?.paginated === true;

// ---------------------------------------------------------------------------
// The operation table
// ---------------------------------------------------------------------------

interface OperationEntry {
  /** Catalog id, so the danger class is read from the generated catalog. */
  readonly catalogId: string;
  /** Addressing this operation needs: a zone alone, or the full RRSet triple. */
  readonly addressing: 'zone' | 'rrset';
}

/**
 * Caller-facing verb -> catalog operation.
 *
 * The names are the caller's vocabulary rather than Hetzner's operation ids,
 * because "add_records" is what somebody means and `add_zone_rrset_records` is
 * what the API calls it. The mapping is one table rather than string surgery on
 * the id, so there is one place to read when the two disagree.
 */
const OPERATIONS = {
  create_zone: { catalogId: 'create_zone', addressing: 'zone' },
  change_zone_ttl: { catalogId: 'change_zone_ttl', addressing: 'zone' },
  list_rrsets: { catalogId: 'list_zone_rrsets', addressing: 'zone' },
  create_rrset: { catalogId: 'create_zone_rrset', addressing: 'zone' },
  get_rrset: { catalogId: 'get_zone_rrset', addressing: 'rrset' },
  add_records: { catalogId: 'add_zone_rrset_records', addressing: 'rrset' },
  remove_records: { catalogId: 'remove_zone_rrset_records', addressing: 'rrset' },
  update_records: { catalogId: 'update_zone_rrset_records', addressing: 'rrset' },
  change_rrset_ttl: { catalogId: 'change_zone_rrset_ttl', addressing: 'rrset' },
} as const satisfies Record<string, OperationEntry>;

type OperationName = keyof typeof OPERATIONS;

const OPERATION_NAMES = Object.keys(OPERATIONS) as OperationName[];

function isOperationName(value: string): value is OperationName {
  return Object.prototype.hasOwnProperty.call(OPERATIONS, value);
}

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

interface Refusal {
  readonly message: string;
  readonly hint: string;
}

/**
 * The verbs a caller will reach for that this tool will not run, each answered
 * by name.
 *
 * A bare "unknown operation" would be true and useless: the model would try
 * again with a synonym, and the third attempt would be `update_zone_rrset` with
 * a full `records` array, which is the same wholesale replace by another route.
 * Saying which door the operation lives behind, and what it would have done, is
 * what ends the loop.
 *
 * Both Hetzner spellings are keyed, so the refusal fires whether the caller
 * typed the friendly verb or the catalog id it read out of `search_operations`.
 */
const REFUSED: ReadonlyMap<string, Refusal> = new Map<string, Refusal>([
  [
    'set_records',
    {
      message:
        '`set_records` is not available through manage_dns. It replaces the entire record set for one name and type, so every record of that name and type that is not in the request is deleted — expressed as "add a subdomain" it removes the addresses already there, and reports success.',
      hint:
        'add_records, remove_records and update_records change a record set without touching records they do not name. A deliberate wholesale replace is the catalog operation `set_zone_rrset_records`, reachable through execute_destructive_operation. ' +
        DESTRUCTIVE_ENABLEMENT,
    },
  ],
  [
    'import_zonefile',
    {
      message:
        '`import_zonefile` is not available through manage_dns. Importing a zone file replaces every record set in the zone with the contents of the file, so anything the file omits is deleted.',
      hint:
        'The catalog operation is `import_zone_zonefile`, reachable through execute_destructive_operation. get_zone_zonefile exports the zone as it stands, which is the only copy of what an import would overwrite. ' +
        DESTRUCTIVE_ENABLEMENT,
    },
  ],
  [
    'delete_zone',
    {
      message:
        '`delete_zone` is not available through manage_dns. Deleting a zone destroys every record set it contains — every name and every type at once — and Hetzner keeps no copy.',
      hint:
        'The catalog operation is `delete_zone`, reachable through execute_destructive_operation. get_zone_zonefile exports the zone as it stands, which is the only copy of what the deletion would destroy. ' +
        DESTRUCTIVE_ENABLEMENT,
    },
  ],
  [
    'delete_rrset',
    {
      message:
        '`delete_rrset` is not available through manage_dns. Deleting an RRSet removes every record of that name and type at once, which is the same loss as a blind replace.',
      hint:
        'remove_records deletes named record values and leaves the rest of the set standing. To remove the set itself, the catalog operation is `delete_zone_rrset`, reachable through execute_destructive_operation. ' +
        DESTRUCTIVE_ENABLEMENT,
    },
  ],
]);

/** Catalog ids and near-misses that resolve to the same refusal. */
const REFUSAL_ALIASES: ReadonlyMap<string, string> = new Map([
  ['set_zone_rrset_records', 'set_records'],
  ['replace_records', 'set_records'],
  ['set_rrset_records', 'set_records'],
  ['import_zone_zonefile', 'import_zonefile'],
  ['import_zone_file', 'import_zonefile'],
  ['delete_zone_rrset', 'delete_rrset'],
  ['delete_record_set', 'delete_rrset'],
  ['remove_zone', 'delete_zone'],
  ['destroy_zone', 'delete_zone'],
]);

function refusalFor(raw: string): Refusal | undefined {
  const key = REFUSAL_ALIASES.get(raw) ?? raw;
  return REFUSED.get(key);
}

/**
 * Reads `operation`, refusing the destructive verbs by name before anything
 * else happens.
 *
 * The published schema is an enum of the reachable operations, so a client that
 * validates against it never gets here with a refused value. The check runs
 * anyway: handlers receive whatever the host passed through, and the refusal
 * text is the whole point — a schema rejection would say "invalid enum value"
 * and teach the caller nothing about where the operation actually lives.
 */
function readOperation(args: Record<string, unknown>): OperationName {
  const raw = requiredString(args, 'operation').toLowerCase();

  const refusal = refusalFor(raw);
  if (refusal !== undefined) {
    throw new HetznerError(refusal.message, 'destructive_blocked', refusal.hint);
  }

  if (!isOperationName(raw)) {
    throw new HetznerError(
      `\`${raw}\` is not an operation of manage_dns.`,
      'validation',
      `Available: ${OPERATION_NAMES.join(', ')}.`,
    );
  }
  return raw;
}

/**
 * Resolves an operation to its catalog row and refuses anything destructive.
 *
 * This is the guard that makes the additive posture structural rather than
 * conventional, and it has no exceptions. The table above is written by hand;
 * the danger class is generated from Hetzner's spec. If the two ever disagree —
 * a verb added here that turns out to replace rather than amend, or an
 * operation Hetzner reclassifies — the generated side wins and the call is
 * refused. Simplifying this away restores exactly the failure it exists to
 * prevent, and adding an opt-out to it makes `destructiveHint: false` a lie.
 */
function reachable(name: OperationName): OperationEntry {
  const entry: OperationEntry = OPERATIONS[name];
  const operation = getOperation(entry.catalogId);
  if (operation === undefined) {
    throw new HetznerError(
      `\`${name}\` maps to catalog operation \`${entry.catalogId}\`, which is not in the shipped catalog.`,
      'unknown',
      'The operation table in manage_dns and the generated catalog have drifted apart.',
    );
  }
  if (operation.danger === 'destructive') {
    throw new HetznerError(
      `\`${name}\` maps to \`${entry.catalogId}\`, which the catalog classifies as destructive; manage_dns does not run destructive operations.`,
      'destructive_blocked',
      `Destructive DNS operations are reachable through execute_destructive_operation. ${DESTRUCTIVE_ENABLEMENT}`,
    );
  }
  return entry;
}

// ---------------------------------------------------------------------------
// Addressing
// ---------------------------------------------------------------------------

/** A zone reference that is a numeric id rather than a domain name. */
const NUMERIC_ID = /^[1-9][0-9]*$/;

/**
 * A registrable domain name: at least two labels, lower case, no trailing dot.
 * Internationalized names are expected already in Punycode, which is what the
 * spec requires and what the parameter description states.
 */
const DOMAIN_NAME =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** An RRSet name label, relative to the zone. `*` is the wildcard label. */
const RRSET_NAME =
  /^(?:\*|[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?)(?:\.(?:[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?))*$/;

/**
 * Normalizes a zone reference.
 *
 * Case folding and the trailing dot are not leniency for its own sake: DNS
 * names are case-insensitive, `example.com.` is the fully-qualified spelling of
 * the same name, and Hetzner stores and requires the lower-case dotless form.
 * Rejecting either would be pedantry paid for by a round trip.
 */
function readZone(args: Record<string, unknown>): string {
  const raw = requiredString(args, 'zone').replace(/\.$/, '').toLowerCase();
  if (raw.length > MAX_ZONE_NAME) {
    throw new HetznerError(
      `\`zone\` is longer than the ${MAX_ZONE_NAME}-character maximum for a zone name.`,
      'validation',
    );
  }
  if (NUMERIC_ID.test(raw) || DOMAIN_NAME.test(raw)) return raw;
  throw new HetznerError(
    `\`zone\` must be a numeric zone id or a domain name such as example.com, and "${raw}" is neither.`,
    'validation',
    'Internationalized domain names must be given in Punycode with the ACE prefix, for example xn--mnchen-3ya.de. Subdomains are not zones: Hetzner registers the zone at the public suffix, and a subdomain lives inside it as an RRSet name.',
  );
}

/**
 * Normalizes an RRSet name and rejects the fully-qualified spelling.
 *
 * The FQDN check is the one that earns its place. Every caller's first instinct
 * is `www.example.com`, and Hetzner wants `www`; sending the long form creates
 * `www.example.com.example.com` or fails with a message that does not say why.
 */
function readRecordName(args: Record<string, unknown>, zone: string): string {
  const raw = requiredString(args, 'record_name').replace(/\.$/, '').toLowerCase();
  if (raw === APEX) return APEX;

  if (raw === zone || raw.endsWith(`.${zone}`)) {
    const relative = raw === zone ? APEX : raw.slice(0, -(zone.length + 1));
    throw new HetznerError(
      `\`record_name\` must be relative to the zone, and "${raw}" repeats the zone name "${zone}".`,
      'validation',
      `Hetzner appends the zone itself, so the name to send here is "${relative}"${
        relative === APEX ? ' — the apex label' : ''
      }.`,
    );
  }
  if (!RRSET_NAME.test(raw)) {
    throw new HetznerError(
      `\`record_name\` "${raw}" is not a valid DNS name relative to the zone.`,
      'validation',
      'Each label is 1-63 characters of letters, digits, hyphens and underscores. Use "@" for the zone apex and "*" for a wildcard.',
    );
  }
  return raw;
}

function readRecordType(args: Record<string, unknown>): RecordType {
  const raw = requiredString(args, 'record_type').toUpperCase();
  const found = RECORD_TYPES.find((type) => type === raw);
  if (found === undefined) {
    throw new HetznerError(
      `\`record_type\` "${raw}" is not a record type Hetzner stores.`,
      'validation',
      `One of: ${RECORD_TYPES.join(', ')}.`,
    );
  }
  return found;
}

/** Percent-encodes every path parameter; `@` becomes %40 rather than a bare `@`. */
function segment(value: string): string {
  return encodeURIComponent(value);
}

function zonePath(zone: string, suffix = ''): string {
  return `/zones/${segment(zone)}${suffix}`;
}

/** The three-parameter RRSet address. Nothing here takes a single `{id}`. */
function rrsetPath(zone: string, name: string, type: RecordType, suffix = ''): string {
  return `/zones/${segment(zone)}/rrsets/${segment(name)}/${segment(type)}${suffix}`;
}

// ---------------------------------------------------------------------------
// Records and TTL
// ---------------------------------------------------------------------------

const RECORD = z
  .object({
    value: z
      .string()
      .min(1)
      .max(MAX_RECORD_VALUE)
      .describe(
        'The record value, spelled for its type: A one IPv4 address (198.51.100.1); AAAA one IPv6 address (2001:db8::1); CNAME one target hostname with a trailing dot (target.example.com.); MX a priority and a host separated by a space (10 mail.example.com.); NS a nameserver hostname with a trailing dot; SRV a priority, weight, port and target (0 5 5060 sip.example.com.); CAA a flag, tag and quoted value (0 issue "letsencrypt.org"); TXT the text wrapped in double quotes, split into chunks of at most 255 characters for longer values such as DKIM keys.',
      ),
    comment: z
      .string()
      .max(255)
      .optional()
      .describe(
        'Free-text note stored alongside the record. update_records requires it on every record: that operation changes comments and nothing else.',
      ),
  })
  .meta({ additionalProperties: false });

type RecordInput = z.infer<typeof RECORD>;

const RECORDS = z.array(RECORD).min(1).max(MAX_RECORDS);

function readRecords(args: Record<string, unknown>, operation: OperationName): RecordInput[] {
  const parsed = RECORDS.safeParse(args['records']);
  if (!parsed.success) throw validationFrom(parsed.error, 'records');

  // Hetzner identifies a record inside a set BY ITS VALUE, so a repeated value
  // is not an ordering question the API resolves — it is two rows claiming to
  // be the same row. Rejected locally rather than sent.
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const record of parsed.data) {
    if (seen.has(record.value)) duplicates.add(record.value);
    seen.add(record.value);
  }
  if (duplicates.size > 0) {
    throw new HetznerError(
      `\`records\` repeats the same value: ${[...duplicates].join(', ')}.`,
      'validation',
      'Hetzner identifies a record within a set by its value, so the values in one request must be distinct.',
    );
  }

  if (operation === 'update_records') {
    const missing = parsed.data.filter((record) => record.comment === undefined);
    if (missing.length > 0) {
      throw new HetznerError(
        `update_records changes the comment on records that already exist, so every record needs a \`comment\`; ${missing.length} of ${parsed.data.length} had none.`,
        'validation',
        "To change a record value, remove_records the old value and add_records the new one — a value is the record's identity, not one of its fields.",
      );
    }
  }
  return parsed.data;
}

function readTtl(args: Record<string, unknown>, required: boolean): number | undefined {
  const ttl = optionalNumber(args, 'ttl');
  if (ttl === undefined) {
    if (!required) return undefined;
    throw new HetznerError('`ttl` is required by this operation.', 'validation');
  }
  if (!Number.isInteger(ttl) || ttl < MIN_TTL || ttl > MAX_TTL) {
    throw new HetznerError(
      `\`ttl\` must be a whole number of seconds between ${MIN_TTL} and ${MAX_TTL}, and ${ttl} is not.`,
      'validation',
    );
  }
  return ttl;
}

// ---------------------------------------------------------------------------
// Transport helpers
// ---------------------------------------------------------------------------

interface Call {
  readonly method: HttpMethod;
  readonly path: string;
  readonly body?: unknown;
  readonly query?: Record<string, string | undefined>;
}

async function send(
  connection: Connection,
  entry: OperationEntry,
  call: Call,
  extra: ToolExtra,
): Promise<unknown> {
  const response = await request({
    connection,
    method: call.method,
    path: call.path,
    ...(call.query ? { query: call.query } : {}),
    ...(call.body === undefined ? {} : { body: call.body }),
    operationId: entry.catalogId,
    ...(extra.signal ? { signal: extra.signal } : {}),
  });
  return response.data;
}

interface Settled {
  readonly action?: ActionRef;
  readonly settled: boolean;
}

/**
 * Zone and RRSet mutations return an Action rather than the finished record
 * set, so the write is accepted long before it is true. Awaiting it is what
 * makes "the record was added" a statement about DNS rather than about HTTP.
 */
async function settle(
  connection: Connection,
  data: unknown,
  extra: ToolExtra,
  waitMs: number,
): Promise<Settled> {
  const action = readAction(data);
  if (action === undefined) return { settled: true };
  const result = await awaitAction(connection, action, extra, waitMs);
  return { action: result.action, settled: result.settled };
}

/**
 * Reads the record set back after a successful mutation.
 *
 * The record actions answer with the Action and nothing else, so without this
 * the caller learns that a write was accepted and nothing about what the set
 * now contains — which is the only thing that decides whether DNS is correct.
 *
 * A failed read-back does not fail the call: the write already happened, and
 * turning a successful mutation into an error result because the confirming GET
 * raced a propagation delay would report the opposite of the truth. But it is
 * not swallowed either — a response that quietly omits the resulting record set
 * is indistinguishable from one where the write did nothing, so the failure is
 * reported as fact in `meta.hint`.
 */
interface ReadBack {
  readonly ok: boolean;
  readonly rrset?: unknown;
}

async function readBack(
  connection: Connection,
  zone: string,
  name: string,
  type: RecordType,
  extra: ToolExtra,
): Promise<ReadBack> {
  try {
    const response = await request({
      connection,
      method: 'GET',
      path: rrsetPath(zone, name, type),
      operationId: 'get_zone_rrset',
      ...(extra.signal ? { signal: extra.signal } : {}),
    });
    return { ok: true, rrset: toRecord(response.data)['rrset'] };
  } catch {
    return { ok: false };
  }
}

const READ_BACK_FAILED =
  'The change was applied — Hetzner reported the action as successful — but reading the record set back afterwards failed, so the records shown here are the request rather than the stored set. get_rrset reads the stored set.';

interface Rendered {
  readonly data: unknown;
  readonly count?: number;
  readonly hint?: string;
}

function respond(connection: Connection, rendered: Rendered, settled: Settled): ToolResult {
  const hints = [rendered.hint];
  if (settled.action !== undefined && !settled.settled) hints.push(unsettledHint(settled.action));
  const hint = hints.filter((part): part is string => part !== undefined).join(' ');

  let envelope = shapeResponse(rendered.data, {
    connection: connection.name,
    surface: connection.surface,
    ...(rendered.count === undefined ? {} : { count: rendered.count }),
    ...(hint === '' ? {} : { hint }),
  });
  if (settled.action !== undefined) {
    envelope = attachAction(envelope, settled.action, settled.settled);
  }
  return renderEnvelope(envelope);
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

const NO_ACTION: Settled = { settled: true };

async function runZoneOperation(
  operation: OperationName,
  entry: OperationEntry,
  args: Record<string, unknown>,
  connection: Connection,
  extra: ToolExtra,
  waitMs: number,
): Promise<ToolResult> {
  const zone = readZone(args);

  switch (operation) {
    case 'create_zone': {
      const ttl = readTtl(args, false);
      const data = await send(
        connection,
        entry,
        {
          method: 'POST',
          path: '/zones',
          body: { name: zone, ...(ttl === undefined ? {} : { ttl }) },
        },
        extra,
      );
      const result = await settle(connection, data, extra, waitMs);
      return respond(
        connection,
        {
          data: toRecord(data)['zone'] ?? { name: zone },
          count: 1,
          hint: "The zone exists in Hetzner's API immediately, and resolves publicly only once the domain's registrar points at Hetzner's nameservers; the assigned nameservers are in the zone record.",
        },
        result,
      );
    }

    case 'change_zone_ttl': {
      const ttl = readTtl(args, true);
      const data = await send(
        connection,
        entry,
        { method: 'POST', path: zonePath(zone, '/actions/change_ttl'), body: { ttl } },
        extra,
      );
      const result = await settle(connection, data, extra, waitMs);
      return respond(
        connection,
        {
          data: { zone, ttl },
          count: 1,
          hint: 'This is the zone default, applied to record sets that do not carry a TTL of their own; sets with an explicit TTL keep it.',
        },
        result,
      );
    }

    case 'list_rrsets': {
      const name = optionalString(args, 'record_name');
      const type = args['record_type'] === undefined ? undefined : readRecordType(args);
      const data = await send(
        connection,
        entry,
        {
          method: 'GET',
          path: zonePath(zone, '/rrsets'),
          query: {
            ...(name === undefined ? {} : { name: name.replace(/\.$/, '').toLowerCase() }),
            ...(type === undefined ? {} : { type }),
            // The catalog, not this file, is the authority on whether an
            // endpoint takes page/per_page. Hetzner's documented maximum is 50
            // and its default is 25; asking for the maximum halves the number of
            // zones whose record sets are silently cut off at the first page,
            // and the shaping ladder is what keeps the answer inside budget.
            ...(RRSET_LIST_PAGINATED ? { per_page: String(MAX_PER_PAGE) } : {}),
          },
        },
        extra,
      );
      const rrsets = toRecord(data)['rrsets'];
      const total = toRecord(toRecord(data)['meta'])['pagination'];
      const entries = toRecord(total)['total_entries'];
      const rows = Array.isArray(rrsets) ? rrsets : [];
      return respond(
        connection,
        {
          data: rows,
          hint:
            typeof entries === 'number' && entries > rows.length
              ? `The zone has ${entries} record sets; this is the first page of ${MAX_PER_PAGE}. list_zone_rrsets with a page parameter is reachable through execute_read_operation.`
              : undefined,
        },
        NO_ACTION,
      );
    }

    case 'create_rrset': {
      const name = readRecordName(args, zone);
      const type = readRecordType(args);
      const records = readRecords(args, operation);
      const ttl = readTtl(args, false);
      const data = await send(
        connection,
        entry,
        {
          method: 'POST',
          path: zonePath(zone, '/rrsets'),
          body: {
            name,
            type,
            records,
            ...(ttl === undefined ? {} : { ttl }),
          },
        },
        extra,
      );
      const result = await settle(connection, data, extra, waitMs);
      return respond(
        connection,
        {
          data: toRecord(data)['rrset'] ?? { zone, name, type, records },
          count: 1,
          hint: 'A record set already exists for a name and type if Hetzner answers with a uniqueness error; add_records extends the existing set instead of replacing it.',
        },
        result,
      );
    }

    default:
      throw new HetznerError(`\`${operation}\` is not a zone-level operation.`, 'validation');
  }
}

async function runRrsetOperation(
  operation: OperationName,
  entry: OperationEntry,
  args: Record<string, unknown>,
  connection: Connection,
  extra: ToolExtra,
  waitMs: number,
): Promise<ToolResult> {
  const zone = readZone(args);
  const name = readRecordName(args, zone);
  const type = readRecordType(args);

  if (operation === 'get_rrset') {
    const data = await send(
      connection,
      entry,
      { method: 'GET', path: rrsetPath(zone, name, type) },
      extra,
    );
    return respond(connection, { data: toRecord(data)['rrset'], count: 1 }, NO_ACTION);
  }

  const call = buildRrsetMutation(operation, args, zone, name, type);
  const data = await send(connection, entry, call, extra);
  const result = await settle(connection, data, extra, waitMs);

  // Only read back once the action settled: an unsettled action means the
  // record set is mid-change, and a snapshot taken then would be presented as
  // the outcome of a write that has not finished.
  const confirmed: ReadBack = result.settled
    ? await readBack(connection, zone, name, type, extra)
    : { ok: true };

  const notes = [MUTATION_HINTS[operation]];
  if (!confirmed.ok) notes.push(READ_BACK_FAILED);

  return respond(
    connection,
    {
      data: confirmed.rrset ?? {
        zone,
        name,
        type,
        ...(call.body === undefined ? {} : toRecord(call.body)),
      },
      count: 1,
      hint: notes.filter((note): note is string => note !== undefined).join(' '),
    },
    result,
  );
}

function buildRrsetMutation(
  operation: OperationName,
  args: Record<string, unknown>,
  zone: string,
  name: string,
  type: RecordType,
): Call {
  switch (operation) {
    case 'add_records': {
      const records = readRecords(args, operation);
      const ttl = readTtl(args, false);
      return {
        method: 'POST',
        path: rrsetPath(zone, name, type, '/actions/add_records'),
        // Only the records being added. This request body is the whole reason
        // the tool is additive: Hetzner merges it into the existing set, so the
        // records already there are neither sent nor at risk.
        body: { records, ...(ttl === undefined ? {} : { ttl }) },
      };
    }
    case 'remove_records':
      return {
        method: 'POST',
        path: rrsetPath(zone, name, type, '/actions/remove_records'),
        body: { records: readRecords(args, operation) },
      };
    case 'update_records':
      return {
        method: 'POST',
        path: rrsetPath(zone, name, type, '/actions/update_records'),
        body: { records: readRecords(args, operation) },
      };
    case 'change_rrset_ttl':
      return {
        method: 'POST',
        path: rrsetPath(zone, name, type, '/actions/change_ttl'),
        body: { ttl: readTtl(args, true) },
      };
    default:
      throw new HetznerError(`\`${operation}\` is not an RRSet-level operation.`, 'validation');
  }
}

/** Facts about what the operation did, never instructions about what to do. */
const MUTATION_HINTS: Partial<Record<OperationName, string>> = {
  add_records:
    'Records already in the set were left in place; the request carried only the additions. `data` is the record set as Hetzner reports it after the change.',
  remove_records:
    'Only the values named in the request were removed; the rest of the set is unchanged. A record is identified by its value, so a value that was not present is not an error.',
  update_records:
    "Only the comments were changed. Record values are identities in Hetzner's model and are not editable in place.",
  change_rrset_ttl:
    'The TTL applies to every record in this set. Resolvers may serve the previous value until the old TTL elapses.',
};

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

async function handler(
  args: Record<string, unknown>,
  cfg: ServerConfig,
  extra: ToolExtra,
): Promise<ToolResult> {
  return runTool(async () => {
    const operation = readOperation(args);
    const entry = reachable(operation);
    const connection = resolveConnection(args, cfg, CONNECTION_OPTS);
    const waitMs = readWaitMs(args);

    return entry.addressing === 'zone'
      ? runZoneOperation(operation, entry, args, connection, extra, waitMs)
      : runRrsetOperation(operation, entry, args, connection, extra, waitMs);
  });
}

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

export const manageDnsTool: ToolDef = {
  name: 'manage_dns',
  description:
    'Manage Hetzner Cloud DNS: create zones, list and read record sets, create a record set, and add, remove or re-comment records. Hetzner stores DNS as record SETS keyed by (zone, name, type), so a set is addressed by all three and holds a list of values sharing one TTL. Record changes are additive: add_records, remove_records and update_records touch only the values named in the request and leave the rest of the set standing. Nothing Hetzner classifies as destructive is reachable here — set_records replaces a whole record set, import_zonefile replaces a whole zone, and delete_zone destroys one; all three live behind execute_destructive_operation, and asking for them by name returns the reason and the route. Zone and record-set changes return an Action, which this tool waits for.',
  annotations: {
    title: 'Manage DNS zones and records',
    readOnlyHint: false,
    // The record operations amend a set rather than replace it, and every
    // wholesale-replace verb is refused above. Zone deletion is reachable but
    // is gated by the destructive gate in the HTTP client, which this tool
    // cannot open.
    destructiveHint: false,
    // Adding the same record twice is a no-op on Hetzner's side, but
    // create_zone and create_rrset answer with a uniqueness error the second
    // time, so the tool as a whole is not idempotent.
    idempotentHint: false,
    openWorldHint: true,
  },
  surface: 'write',
  apiSurfaces: CLOUD,
  inputSchema: (cfg: ServerConfig): Record<string, unknown> => ({
    ...connectionProperty(cfg, CONNECTION_OPTS),
    operation: z
      .enum(OPERATION_NAMES as [OperationName, ...OperationName[]])
      .describe(
        'What to do. create_zone adds a zone; change_zone_ttl sets the zone default TTL used by record sets that carry none. list_rrsets and get_rrset read record sets. create_rrset creates a set that does not exist yet; add_records, remove_records and update_records amend one that does, touching only the values named in the request; change_rrset_ttl changes the TTL of one set. Deleting a zone or a whole record set, and the wholesale replaces set_records and import_zonefile, are destructive and are not among these values.',
      ),
    zone: z
      .string()
      .min(1)
      .max(MAX_ZONE_NAME)
      .describe(
        'The zone, as a numeric zone id or as its domain name (example.com) — Hetzner accepts either. For create_zone this is the domain name to create; it must be a registrable domain at a public suffix, in lower case, without a trailing dot, and internationalized names must already be in Punycode (xn--mnchen-3ya.de).',
      ),
    record_name: z
      .string()
      .min(1)
      .max(MAX_ZONE_NAME)
      .optional()
      .describe(
        'Name of the record set, RELATIVE to the zone: "www", not "www.example.com". "@" is the zone apex and "*" is a wildcard. Required for get_rrset, create_rrset, add_records, remove_records, update_records and change_rrset_ttl; optional on list_rrsets, where it filters.',
      ),
    record_type: z
      .enum(RECORD_TYPES)
      .optional()
      .describe(
        'DNS type of the record set. Together with the zone and the name it identifies the set. Required for every record-set operation; optional on list_rrsets, where it filters.',
      ),
    records: RECORDS.optional().describe(
      `Record values, at most ${MAX_RECORDS} per request and all distinct. Required by create_rrset, add_records, remove_records and update_records. add_records adds these to the set and leaves the others alone; remove_records deletes exactly these values; update_records changes the comment on records identified by these values and requires a comment on each.`,
    ),
    ttl: z
      .number()
      .int()
      .min(MIN_TTL)
      .max(MAX_TTL)
      .optional()
      .describe(
        `Time to live in seconds, between ${MIN_TTL} and ${MAX_TTL}. Required by change_zone_ttl and change_rrset_ttl. Optional on create_zone (zone default, Hetzner uses 3600 when omitted), create_rrset and add_records; on add_records it must match the TTL the set already has.`,
      ),
    ...waitProperty(),
  }),
  handler,
};
