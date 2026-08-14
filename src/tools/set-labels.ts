/**
 * `set_labels` — labels on any labelable Hetzner Cloud resource.
 *
 * Labels are Hetzner's organizing primitive. They are what `label_selector`
 * queries, which makes them the difference between a fleet you can ask
 * questions about and a list of numeric ids, so this tool is what gives
 * `find_resources` something to find by.
 *
 * THE API'S SEMANTICS ARE NOT THIS TOOL'S SEMANTICS, and that is the one real
 * design decision here.
 *
 * Every labelable resource is written with `PUT /<resource>/{id}`, and Hetzner
 * documents plainly that "the set of Labels provided in the request will
 * overwrite the existing one". A caller who says "label this server env=prod"
 * and thereby erases `team`, `owner` and `backup-policy` has been badly served
 * by a tool that was technically faithful to the API. So the default is MERGE:
 * the current labels are read, the requested change is applied on top, and the
 * union is written. Replacing everything is still available, but only to a
 * caller who asked for it by name with `replace: true`.
 *
 * MERGE IS NOT ATOMIC, and cannot be made so. It is a read followed by a write,
 * and Hetzner offers no conditional update for labels — no ETag, no If-Match,
 * no PATCH that merges server-side. If something else edits the same resource's
 * labels between the GET and the PUT, that edit is silently overwritten. The
 * window is one round trip wide. It is stated here rather than papered over,
 * because the alternative is a comment claiming a guarantee the API does not
 * provide.
 *
 * Removal is expressed as a `null` VALUE rather than a separate `remove` list.
 * Two reasons, and the first is decisive: an empty string is a legal label
 * value that Hetzner's own examples use (`"just-a-key": ""`), so "" cannot mean
 * removal and something else has to. `null` is that something else, and putting
 * it in the same map as the sets means there is no second parameter that can
 * disagree with the first — no "the key is in both `labels` and `remove`" case
 * whose resolution the caller has to learn.
 */

import { z } from 'zod';

import { request } from '../http/client.js';
import { shapeResponse } from '../shaping/envelope.js';
import { HetznerError } from '../types.js';
import type {
  Connection,
  ServerConfig,
  Surface,
  ToolDef,
  ToolExtra,
  ToolResult,
} from '../types.js';
import {
  connectionProperty,
  optionalBoolean,
  renderEnvelope,
  requiredId,
  requiredString,
  resolveConnection,
  runTool,
  toRecord,
} from './shared.js';

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------

/** Labels exist only on the cloud surface. */
const CLOUD: readonly Surface[] = ['cloud'];

const CONNECTION_OPTS = { requireExplicit: true, surfaces: CLOUD } as const;

interface ResourceEntry {
  /** Path segment: `/servers/{id}`. */
  readonly segment: string;
  /** Key the resource sits under in Hetzner's request and response envelopes. */
  readonly key: string;
  readonly read: string;
  readonly write: string;
}

/**
 * Every labelable resource in the cloud API, and every one of them is
 * `GET|PUT /<segment>/{id}` with a `labels` object.
 *
 * The uniformity is why this is a table and not ten tools: the only thing that
 * varies between a server and a certificate here is the noun.
 */
const RESOURCES = {
  server: { segment: 'servers', key: 'server', read: 'get_server', write: 'update_server' },
  volume: { segment: 'volumes', key: 'volume', read: 'get_volume', write: 'update_volume' },
  network: { segment: 'networks', key: 'network', read: 'get_network', write: 'update_network' },
  firewall: {
    segment: 'firewalls',
    key: 'firewall',
    read: 'get_firewall',
    write: 'update_firewall',
  },
  load_balancer: {
    segment: 'load_balancers',
    key: 'load_balancer',
    read: 'get_load_balancer',
    write: 'update_load_balancer',
  },
  floating_ip: {
    segment: 'floating_ips',
    key: 'floating_ip',
    read: 'get_floating_ip',
    write: 'update_floating_ip',
  },
  primary_ip: {
    segment: 'primary_ips',
    key: 'primary_ip',
    read: 'get_primary_ip',
    write: 'update_primary_ip',
  },
  image: { segment: 'images', key: 'image', read: 'get_image', write: 'update_image' },
  certificate: {
    segment: 'certificates',
    key: 'certificate',
    read: 'get_certificate',
    write: 'update_certificate',
  },
  placement_group: {
    segment: 'placement_groups',
    key: 'placement_group',
    read: 'get_placement_group',
    write: 'update_placement_group',
  },
} as const satisfies Record<string, ResourceEntry>;

type ResourceType = keyof typeof RESOURCES;

const RESOURCE_TYPES = Object.keys(RESOURCES) as [ResourceType, ...ResourceType[]];

function readResourceType(args: Record<string, unknown>): ResourceType {
  const raw = requiredString(args, 'resource_type').toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(RESOURCES, raw)) {
    throw new HetznerError(
      `\`${raw}\` is not a labelable Hetzner Cloud resource type.`,
      'validation',
      `One of: ${RESOURCE_TYPES.join(', ')}.`,
    );
  }
  return raw as ResourceType;
}

// ---------------------------------------------------------------------------
// Label validation
//
// Rules transcribed from the "Labels" section of the Hetzner Cloud OpenAPI
// document (scripts/hetzner-cloud.openapi.json, info.description). They are
// checked here rather than left to the API because Hetzner answers an invalid
// label with a generic 400 that names neither the key nor the rule, which costs
// the caller a round trip and a guess.
// ---------------------------------------------------------------------------

const MAX_LABELS = 100;
const MAX_NAME_LENGTH = 63;
const MAX_VALUE_LENGTH = 63;
const MAX_PREFIX_LENGTH = 253;

/** Name segment, and the value: alphanumeric ends, `-` `_` `.` in between. */
const LABEL_NAME = /^[a-zA-Z0-9](?:[a-zA-Z0-9._-]{0,61}[a-zA-Z0-9])?$/;

/** One DNS label of the optional prefix. */
const PREFIX_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** Hetzner's own namespace; writing into it is rejected by the API. */
const RESERVED_PREFIX = 'hetzner.cloud';

const NAME_RULE = `must be 1-${MAX_NAME_LENGTH} characters, begin and end with a letter or digit, and contain only letters, digits, dashes, underscores and dots`;

const PREFIX_RULE = `must be a DNS subdomain of at most ${MAX_PREFIX_LENGTH} characters — lower-case DNS labels separated by dots — followed by a slash`;

const VALUE_RULE = `must be empty or 1-${MAX_VALUE_LENGTH} characters beginning and ending with a letter or digit, with only letters, digits, dashes, underscores and dots in between`;

function invalidLabel(message: string): HetznerError {
  return new HetznerError(
    message,
    'validation',
    'Rule from the Labels section of the Hetzner Cloud API reference. Hetzner rejects an invalid label with a generic 400 that names neither the key nor the rule, so it is checked before the write.',
  );
}

function assertValidKey(key: string): void {
  if (key === '') {
    throw invalidLabel('A label key must not be empty.');
  }

  const parts = key.split('/');
  if (parts.length > 2) {
    throw invalidLabel(
      `Label key "${key}" is invalid: a key is an optional prefix and a name separated by a single slash, and this one has ${parts.length - 1}.`,
    );
  }

  const name = parts[parts.length - 1] ?? '';
  const prefix = parts.length === 2 ? (parts[0] ?? '') : undefined;

  if (name.length > MAX_NAME_LENGTH || !LABEL_NAME.test(name)) {
    throw invalidLabel(`Label key name "${name}" is invalid: the name segment ${NAME_RULE}.`);
  }

  if (prefix === undefined) return;

  if (prefix === RESERVED_PREFIX) {
    throw invalidLabel(
      `Label key "${key}" is invalid: the "${RESERVED_PREFIX}/" prefix is reserved by Hetzner and cannot be used.`,
    );
  }
  if (
    prefix.length === 0 ||
    prefix.length > MAX_PREFIX_LENGTH ||
    !prefix.split('.').every((label) => PREFIX_LABEL.test(label))
  ) {
    throw invalidLabel(`Label key prefix "${prefix}" is invalid: the prefix ${PREFIX_RULE}.`);
  }
}

function assertValidValue(key: string, value: string): void {
  // The empty string is a legal value, and Hetzner's own examples use it. This
  // is also why removal is spelled `null` rather than `""`.
  if (value === '') return;
  if (value.length > MAX_VALUE_LENGTH || !LABEL_NAME.test(value)) {
    throw invalidLabel(`Label value "${value}" on key "${key}" is invalid: a value ${VALUE_RULE}.`);
  }
}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

/**
 * `null` means remove. Zod's record accepts the union so the published schema
 * says so, rather than leaving the model to discover it from prose.
 */
const LABELS = z.record(z.string(), z.union([z.string(), z.null()]));

function readLabels(args: Record<string, unknown>): Record<string, string | null> {
  const parsed = LABELS.safeParse(args['labels']);
  if (!parsed.success) {
    throw new HetznerError(
      '`labels` must be an object mapping label keys to string values, or to null to remove the key.',
      'validation',
    );
  }
  const entries = Object.entries(parsed.data);
  if (entries.length === 0) {
    throw new HetznerError(
      '`labels` was empty, so there is nothing to write.',
      'validation',
      'An empty object is not how a resource is stripped of its labels: `replace: true` with the labels to keep is, and it says so explicitly.',
    );
  }
  if (entries.length > MAX_LABELS) {
    throw new HetznerError(
      `\`labels\` carries ${entries.length} keys, past the ${MAX_LABELS} this tool sends in one request.`,
      'validation',
    );
  }

  // Validated on the way in, before the read, so an invalid key costs no
  // request at all and the caller learns which key and which rule.
  for (const [key, value] of entries) {
    assertValidKey(key);
    if (value !== null) assertValidValue(key, value);
  }
  return parsed.data;
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

interface Change {
  readonly labels: Record<string, string>;
  readonly added: string[];
  readonly updated: string[];
  readonly removed: string[];
  readonly unchanged: number;
}

/**
 * Computes the label map to write, and the diff that describes it.
 *
 * The diff is not decoration. In replace mode it is the only place a caller
 * finds out which labels the write is about to drop, and it is computed from
 * the resource as it stood a moment ago rather than from anything the caller
 * asserted.
 */
function merge(
  current: Record<string, string>,
  requested: Record<string, string | null>,
  replace: boolean,
): Change {
  const base = replace ? {} : { ...current };
  const next: Record<string, string> = { ...base };

  for (const [key, value] of Object.entries(requested)) {
    if (value === null) delete next[key];
    else next[key] = value;
  }

  const added: string[] = [];
  const updated: string[] = [];
  let unchanged = 0;
  for (const [key, value] of Object.entries(next)) {
    if (!Object.prototype.hasOwnProperty.call(current, key)) added.push(key);
    else if (current[key] !== value) updated.push(key);
    else unchanged += 1;
  }
  const removed = Object.keys(current).filter(
    (key) => !Object.prototype.hasOwnProperty.call(next, key),
  );

  return { labels: next, added, updated, removed, unchanged };
}

function labelsOf(payload: unknown, key: string): Record<string, string> {
  const resource = toRecord(toRecord(payload)[key]);
  const labels = toRecord(resource['labels']);
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(labels)) {
    // Hetzner's label values are strings; anything else in the payload is not a
    // label and must not be echoed back into the map we are about to write.
    if (typeof value === 'string') out[name] = value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/** Statements of fact about what was written. Never directives. */
const MERGE_NOTE =
  "Hetzner's PUT replaces the whole label map; the merge was performed here by reading the resource first and writing the union, so labels not named in the request were preserved. The read and the write are two requests, so a label edit made by something else in between was overwritten.";

const REPLACE_NOTE =
  'replace: true was set, so the request was written through unmerged: every label not named in it was removed.';

async function handler(
  args: Record<string, unknown>,
  cfg: ServerConfig,
  extra: ToolExtra,
): Promise<ToolResult> {
  return runTool(async () => {
    const resourceType = readResourceType(args);
    const resource: ResourceEntry = RESOURCES[resourceType];
    const id = requiredId(args);
    const requested = readLabels(args);
    const replace = optionalBoolean(args, 'replace') === true;
    const connection = resolveConnection(args, cfg, CONNECTION_OPTS);

    const current = await readCurrent(connection, resource, id, extra);
    const change = merge(current, requested, replace);

    const written = await request({
      connection,
      method: 'PUT',
      path: `/${resource.segment}/${id}`,
      body: { labels: change.labels },
      operationId: resource.write,
      ...(extra.signal ? { signal: extra.signal } : {}),
    });

    const updated = toRecord(toRecord(written.data)[resource.key]);

    const envelope = shapeResponse(
      {
        resource_type: resourceType,
        id,
        name: typeof updated['name'] === 'string' ? updated['name'] : undefined,
        mode: replace ? 'replace' : 'merge',
        labels: labelsOf(written.data, resource.key),
        added: change.added,
        updated: change.updated,
        removed: change.removed,
        unchanged: change.unchanged,
      },
      {
        connection: connection.name,
        surface: connection.surface,
        count: 1,
        hint: replace ? REPLACE_NOTE : MERGE_NOTE,
      },
    );
    return renderEnvelope(envelope);
  });
}

/**
 * Reads the resource's current labels.
 *
 * Done even in replace mode, where the merge does not need it: the read is what
 * lets the response name the labels the replace removed, and a caller who
 * discovers that from the diff can put them back. Without it a replace reports
 * only what it kept.
 */
async function readCurrent(
  connection: Connection,
  resource: ResourceEntry,
  id: number,
  extra: ToolExtra,
): Promise<Record<string, string>> {
  const response = await request({
    connection,
    method: 'GET',
    path: `/${resource.segment}/${id}`,
    operationId: resource.read,
    ...(extra.signal ? { signal: extra.signal } : {}),
  });
  return labelsOf(response.data, resource.key);
}

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

export const setLabelsTool: ToolDef = {
  name: 'set_labels',
  description:
    "Set labels on a Hetzner Cloud resource — server, volume, network, firewall, load balancer, floating IP, primary IP, image, certificate or placement group. Labels are what label_selector queries, so they are how a fleet becomes searchable. By default the change is MERGED into the labels the resource already carries: keys not named in the request keep their values. A null value removes a key. replace: true writes the request through unmerged, removing every label it does not name, which is what Hetzner's own PUT does. The merge is a read followed by a write and is not atomic; Hetzner offers no conditional label update.",
  annotations: {
    title: 'Set resource labels',
    readOnlyHint: false,
    // The default merge preserves what it does not name, and removal has to be
    // written as an explicit null or asked for with replace: true.
    destructiveHint: false,
    // Sending the same labels twice leaves the same state.
    idempotentHint: true,
    openWorldHint: true,
  },
  surface: 'write',
  apiSurfaces: CLOUD,
  inputSchema: (cfg: ServerConfig): Record<string, unknown> => ({
    ...connectionProperty(cfg, CONNECTION_OPTS),
    resource_type: z
      .enum(RESOURCE_TYPES)
      .describe('Which kind of resource the id belongs to. find_resources reports both.'),
    id: z
      .union([z.number().int().positive(), z.string()])
      .describe(
        'Numeric id of the resource. find_resources reports the id of everything it lists.',
      ),
    labels: LABELS.describe(
      `Labels to set, as key/value pairs. A null value removes that key. Keys are an optional DNS-subdomain prefix and a slash, then a name of 1-${MAX_NAME_LENGTH} characters beginning and ending with a letter or digit and otherwise letters, digits, dashes, underscores and dots (env, team.example.com/owner). Values follow the same shape and may also be empty, which is a real value and not a removal. The "${RESERVED_PREFIX}/" prefix is reserved by Hetzner.`,
    ),
    replace: z
      .boolean()
      .optional()
      .describe(
        "Default false. False merges: the resource's current labels are read and keys not named in the request keep their values. True writes the request through unmerged, so every label not named in it is removed — this is Hetzner's own PUT semantics, and the response lists the keys it dropped.",
      ),
  }),
  handler,
};
