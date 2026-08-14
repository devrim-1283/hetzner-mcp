/**
 * `create_server` — POST /servers. The one tool in this server that opens a
 * bill.
 *
 * Every other write is reversible by another call in the same session: a
 * powered-off server can be powered on, a detached volume reattached. This one
 * is not, in the only sense that matters to the person paying — the meter starts
 * when Hetzner accepts the request and runs until the server is deleted, and no
 * later call refunds the hours in between.
 *
 * The product deliberately does not gate costly operations behind a flag (see
 * `CatalogOperation.costly` in types.ts for why: a gate everybody switches on
 * during setup protects nobody). Making the consequence VISIBLE is what that
 * trade buys, so the visibility is this file's job rather than a nicety:
 *
 *   - the description states, as fact, that the call provisions billable
 *     infrastructure;
 *   - `meta.billing` carries the price Hetzner itself publishes for the server
 *     type in the location it was actually placed in;
 *   - when that price cannot be read, `meta.billing` is ABSENT and the hint says
 *     so. A confidently wrong number is worse than no number, because a reader
 *     has no way to tell one from the other.
 *
 * None of that instructs the model to seek confirmation. Whether a create needs
 * a human in the loop is the host's decision and the host has its own machinery
 * for it; a tool description that issued behavioural directives would be a
 * directive embedded in tool output, which is the shape of prompt injection.
 */

import { z } from 'zod';

import { getPricingCategory } from '../catalog/index.js';
import { request } from '../http/client.js';
import { SERVER_FIELDS, SERVER_PRUNABLE } from '../shaping/project.js';
import { HetznerError } from '../types.js';
import type {
  ActionRef,
  Connection,
  ResponseMeta,
  ServerConfig,
  Surface,
  ToolDef,
  ToolExtra,
  ToolResult,
} from '../types.js';
import {
  SERVER_BILLED_UNTIL_DELETED,
  attachAction,
  attachBilling,
  awaitAction,
  billingFromPrices,
  connectionProperty,
  noActionHint,
  readAction,
  readWaitMs,
  renderEnvelope,
  resolveConnection,
  runTool,
  shapeResponse,
  toRecord,
  unsettledHint,
  validationFrom,
  waitProperty,
  type HetznerPrice,
} from './shared.js';

const OPERATION_ID = 'create_server';
const PRICING_OPERATION_ID = 'get_pricing';

/** Cloud only: `POST /servers` exists on no other Hetzner API. */
const API_SURFACES: readonly Surface[] = ['cloud'];

/**
 * RFC 1123 host name, which is what Hetzner validates `name` against.
 *
 * Encoded here rather than left to the API because the failure is expensive in
 * the wrong direction: the request is rejected AFTER the model has committed to
 * a create, and the returned `invalid_input` says which field is wrong without
 * saying what a valid one looks like. Labels are 1-63 characters of
 * alphanumerics and hyphens, may not begin or end with a hyphen, and the whole
 * name is capped at 253.
 */
const HOSTNAME =
  /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

/** Hetzner's own documented ceiling on cloud-init user data. */
const MAX_USER_DATA_BYTES = 32 * 1024;

/**
 * The projection for the created server, plus the two things that exist only in
 * this response.
 *
 * `SERVER_FIELDS` is reused rather than restated so a server reads the same here
 * as it does everywhere else. It is prefixed because the payload is an envelope
 * around the server, not the server itself.
 */
const CREATED_FIELDS: readonly string[] = [
  ...SERVER_FIELDS.map((field) => `server.${field}`),
  'root_password',
  'next_actions.id',
  'next_actions.command',
  'next_actions.status',
];

/**
 * `root_password` is deliberately absent from this list.
 *
 * The prunable ladder drops fields to fit the response budget, and dropping this
 * one would destroy the only copy of a credential that Hetzner will never return
 * again — to save roughly twenty bytes.
 */
const CREATED_PRUNABLE: readonly string[] = SERVER_PRUNABLE.map((field) => `server.${field}`);

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const ARGS = z.object({
  name: z
    .string()
    .min(1)
    .max(253)
    .regex(
      HOSTNAME,
      'must be a valid host name (RFC 1123): letters, digits and hyphens, dot-separated labels of at most 63 characters, and no leading or trailing hyphen',
    )
    .describe(
      'Name for the new server. Must be unique within the project and a valid host name as per RFC 1123: dot-separated labels of letters, digits and hyphens, each 1-63 characters, neither starting nor ending with a hyphen. Underscores and spaces are rejected by Hetzner.',
    ),
  server_type: z
    .string()
    .min(1)
    .describe(
      'Name or id of the server type, for example "cpx21" or "cax11". The type fixes the cores, memory, disk and CPU architecture, and it is the main term in the price. list_server_types reports what exists and what each one costs.',
    ),
  image: z
    .string()
    .min(1)
    .describe(
      'Name or id of the image the disk is created from, for example "ubuntu-24.04" or a snapshot id. The image architecture must match the server type: an arm64 type (cax*) cannot boot an x86 image.',
    ),
  location: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Name or id of the location to create the server in, for example "fsn1", "hel1" or "ash". Mutually exclusive with `datacenter`. When neither is given, Hetzner chooses. The location changes the price and is fixed for the life of the server.',
    ),
  datacenter: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Name or id of a specific datacenter, for example "fsn1-dc14". A datacenter is one facility inside a location; naming one pins the placement more tightly than `location` does. Mutually exclusive with `location`.',
    ),
  ssh_keys: z
    .array(z.union([z.string().min(1), z.number().int().positive()]))
    .optional()
    .describe(
      'SSH keys to install for root, by name or by numeric id, as already uploaded to the project. When at least one key is given Hetzner generates no root password at all; when this is empty or omitted it generates one and returns it exactly once in this response.',
    ),
  user_data: z
    .string()
    .max(MAX_USER_DATA_BYTES)
    .optional()
    .describe(
      'Cloud-init user data run on first boot, at most 32 KiB. Usually a "#cloud-config" document. It is stored on the server and readable by anything running there, so it is not a place for secrets.',
    ),
  labels: z
    .record(z.string(), z.string())
    .optional()
    .describe(
      'User-defined key/value labels on the server. Label selectors reference these, including the ones a Load Balancer or a Firewall uses to pick up targets automatically.',
    ),
  networks: z
    .array(z.number().int().positive())
    .optional()
    .describe(
      'Ids of existing private networks to attach at creation time. The networks must already exist; this does not create them.',
    ),
  firewalls: z
    .array(z.number().int().positive())
    .optional()
    .describe(
      'Ids of existing firewalls to apply to the public interface at creation time. Applying at creation closes the gap between the server booting and a firewall being attached afterwards.',
    ),
  placement_group: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      'Id of a placement group to join. A spread placement group keeps its members on different physical hosts, so a single host failure cannot take all of them down at once.',
    ),
  start_after_create: z
    .boolean()
    .optional()
    .describe(
      'Whether Hetzner powers the server on once it is built. Defaults to true. When false the server is created, billed and left off; control_resource with action "poweron" starts it.',
    ),
  public_net: z
    .object({
      enable_ipv4: z
        .boolean()
        .optional()
        .describe(
          'Attach a public IPv4 address. Defaults to true. A public IPv4 is billed on top of the server price; without one the server is reachable only over IPv6 or a private network.',
        ),
      enable_ipv6: z
        .boolean()
        .optional()
        .describe('Attach a public IPv6 address. Defaults to true.'),
    })
    .optional()
    .describe('Public network options. Omitted, the server gets both a public IPv4 and an IPv6.'),
});

type CreateArgs = z.infer<typeof ARGS>;

function parseArgs(raw: Record<string, unknown>): CreateArgs {
  const parsed = ARGS.safeParse(raw);
  if (parsed.success) return parsed.data;
  throw validationFrom(parsed.error, 'arguments');
}

/**
 * A datacenter is one facility inside a location, so naming both can only ever
 * agree or contradict. Hetzner rejects the pair too; refusing here saves the
 * round trip and, unlike the API's `invalid_input`, says which one to keep.
 */
function assertPlacement(args: CreateArgs): void {
  if (args.location !== undefined && args.datacenter !== undefined) {
    throw new HetznerError(
      '`location` and `datacenter` cannot both be given.',
      'validation',
      'Pass `location` (for example "fsn1") to place the server anywhere in that location, or `datacenter` (for example "fsn1-dc14") to pin one facility inside it.',
    );
  }
}

function buildBody(args: CreateArgs): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: args.name,
    server_type: args.server_type,
    image: args.image,
  };
  if (args.location !== undefined) body['location'] = args.location;
  if (args.datacenter !== undefined) body['datacenter'] = args.datacenter;
  if (args.ssh_keys !== undefined) body['ssh_keys'] = args.ssh_keys;
  if (args.user_data !== undefined) body['user_data'] = args.user_data;
  if (args.labels !== undefined) body['labels'] = args.labels;
  if (args.networks !== undefined) body['networks'] = args.networks;
  // Hetzner takes firewalls as objects, one key each. The tool takes plain ids:
  // a single-key wrapper object is a shape the model has to get right for no
  // information gain, and the mapping is total.
  if (args.firewalls !== undefined) {
    body['firewalls'] = args.firewalls.map((firewall) => ({ firewall }));
  }
  if (args.placement_group !== undefined) body['placement_group'] = args.placement_group;
  if (args.start_after_create !== undefined) body['start_after_create'] = args.start_after_create;
  if (args.public_net !== undefined) body['public_net'] = args.public_net;
  return body;
}

// ---------------------------------------------------------------------------
// Billing
// ---------------------------------------------------------------------------

function locationOf(server: Record<string, unknown>): string | undefined {
  const location = toRecord(toRecord(server['datacenter'])['location']);
  return typeof location['name'] === 'string' ? location['name'] : undefined;
}

function serverTypeOf(server: Record<string, unknown>): string | undefined {
  const serverType = toRecord(server['server_type']);
  return typeof serverType['name'] === 'string' ? serverType['name'] : undefined;
}

/**
 * The published price for what was just created.
 *
 * Read from `GET /pricing` rather than from the `server_type.prices` table the
 * create response already embeds, for one reason: that table carries no
 * currency. Hetzner invoices some accounts in EUR and others in USD, and a
 * correct number under the wrong symbol is exactly the confidently-wrong output
 * this tool exists to avoid. `/pricing` states the project's currency alongside
 * the same per-location table, and the category to read it from is the
 * catalog's, not one invented here.
 *
 * Failures are swallowed on purpose. The server exists and is being billed by
 * the time this runs; turning a pricing lookup into an error would report a
 * successful create as a failure, which is the more expensive mistake. An
 * unreadable price becomes an absent `meta.billing` and a sentence saying so.
 */
async function billingFor(
  connection: Connection,
  server: Record<string, unknown>,
  location: string | undefined,
  extra: ToolExtra,
): Promise<ResponseMeta['billing'] | undefined> {
  const category = getPricingCategory(OPERATION_ID);
  const typeName = serverTypeOf(server);
  if (category === undefined || typeName === undefined || location === undefined) return undefined;

  let data: unknown;
  try {
    const response = await request<unknown>({
      connection,
      method: 'GET',
      path: '/pricing',
      operationId: PRICING_OPERATION_ID,
      signal: extra.signal,
    });
    data = response.data;
  } catch {
    return undefined;
  }

  const pricing = toRecord(toRecord(data)['pricing']);
  const rows = pricing[category];
  if (!Array.isArray(rows)) return undefined;

  const row = rows
    .map(toRecord)
    .find((entry) => entry['name'] === typeName || String(entry['id']) === typeName);
  if (row === undefined) return undefined;

  const prices = Array.isArray(row['prices']) ? (row['prices'] as HetznerPrice[]) : undefined;
  const currency = typeof pricing['currency'] === 'string' ? pricing['currency'] : undefined;
  return billingFromPrices(prices, location, currency);
}

// ---------------------------------------------------------------------------
// Hint
// ---------------------------------------------------------------------------

/**
 * Complements the one-time-secret note the envelope adds on its own (see
 * shaping/redact.ts). That note says the value is returned once and cannot be
 * read back; this says why there is a password at all, and how to not have one
 * next time.
 */
const PASSWORD_FACT =
  'The server was created without an SSH key, so Hetzner generated the root password shown here. A server created with `ssh_keys` gets no password at all.';

interface HintParts {
  hasPassword: boolean;
  priced: boolean;
  serverType: string;
  location: string | undefined;
  action: ActionRef | undefined;
  settled: boolean;
  pending: readonly string[];
}

function composeHint(parts: HintParts): string {
  // "It costs money" is the fact a summary of this response is most likely to
  // drop, and the one the user most needs kept — so it leads, and it is the
  // seam's sentence rather than a second wording of it.
  const notes: string[] = [SERVER_BILLED_UNTIL_DELETED];

  if (!parts.priced) {
    notes.push(
      `No published price could be read for server type ${parts.serverType} in ${parts.location ?? 'the chosen location'}, so meta.billing is absent from this response.`,
    );
  }
  if (parts.hasPassword) notes.push(PASSWORD_FACT);
  if (parts.action === undefined) {
    notes.push(noActionHint(OPERATION_ID));
  } else if (!parts.settled) {
    notes.push(unsettledHint(parts.action));
  }
  if (parts.pending.length > 0) {
    notes.push(
      `Hetzner queued ${parts.pending.length} follow-up action(s) that were still running and were not waited for: ${parts.pending.join(', ')}. They are listed in next_actions with their ids, and get_action reports their current state.`,
    );
  }
  return notes.join(' ');
}

/**
 * The follow-up Actions Hetzner queues alongside the create — powering the
 * server on, attaching the networks and firewalls that were named here — and why
 * this tool reports them instead of awaiting them.
 *
 * The primary Action is what "the server exists and is billed" means, and it is
 * the question this call was asked. The follow-ups are a different question with
 * a different timescale: `poweron` completes in seconds, but a firewall
 * application waits on the firewall's own queue, and blocking the create on the
 * slowest of them would turn a 15-second call into a multi-minute one for
 * information the caller can read whenever they want.
 *
 * Reporting them by name is the part that cannot be skipped. A response that
 * said only "created" while the machine was still being wired up would be read
 * as "finished", and the first symptom would be a server that is unreachable on
 * the private network nobody was told was still attaching.
 */
function pendingCommands(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(toRecord)
    .filter((row) => row['status'] === 'running')
    .map((row) => (typeof row['command'] === 'string' ? row['command'] : 'unknown'));
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

async function handler(
  rawArgs: Record<string, unknown>,
  cfg: ServerConfig,
  extra: ToolExtra,
): Promise<ToolResult> {
  return runTool(async () => {
    const args = parseArgs(rawArgs);
    assertPlacement(args);
    // Required with no default, enforced here as well as in the schema: a client
    // that ignores the published schema must not be able to create a billed
    // machine in an unnamed project.
    const connection = resolveConnection(rawArgs, cfg, {
      requireExplicit: true,
      surfaces: API_SURFACES,
    });

    const response = await request<unknown>({
      connection,
      method: 'POST',
      path: '/servers',
      body: buildBody(args),
      operationId: OPERATION_ID,
      signal: extra.signal,
    });

    const payload = toRecord(response.data);
    const server = toRecord(payload['server']);

    let action = readAction(payload);
    let settled = true;
    if (action !== undefined) {
      const outcome = await awaitAction(connection, action, extra, readWaitMs(rawArgs));
      action = outcome.action;
      settled = outcome.settled;
    }

    // Read once, placed once. Copying it into a second field — a summary, an
    // echo of the request — would put a live credential in the transcript twice
    // for no gain, and only one of the copies would be flagged.
    const rawPassword = payload['root_password'];
    const password =
      typeof rawPassword === 'string' && rawPassword !== '' ? rawPassword : undefined;

    // The location the server LANDED in, not the one that was asked for: a
    // `datacenter` argument, or no placement argument at all, still has to price
    // correctly.
    const location = locationOf(server) ?? args.location;
    const billing = await billingFor(connection, server, location, extra);

    let envelope = shapeResponse(
      { server, root_password: password, next_actions: payload['next_actions'] },
      {
        connection: connection.name,
        surface: connection.surface,
        count: 1,
        hint: composeHint({
          hasPassword: password !== undefined,
          priced: billing !== undefined,
          serverType: serverTypeOf(server) ?? args.server_type,
          location,
          action,
          settled,
          pending: pendingCommands(payload['next_actions']),
        }),
      },
      { fields: CREATED_FIELDS, prunable: CREATED_PRUNABLE },
    );

    if (billing !== undefined) envelope = attachBilling(envelope, billing);
    if (action !== undefined) envelope = attachAction(envelope, action, settled);
    return renderEnvelope(envelope);
  });
}

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

export const createServerTool: ToolDef = {
  name: 'create_server',
  description:
    'Create a Hetzner Cloud server. This provisions billable infrastructure: Hetzner charges for the server from the moment it is created until it is deleted, and powering it off does not stop the charge. meta.billing carries the published hourly and monthly price for the chosen server type in the location the server was placed in. The call returns once Hetzner has finished building the server, or reports that it was still working when the wait ended. Creating a server without `ssh_keys` makes Hetzner generate a root password and return it in this one response; creating it with `ssh_keys` generates no password at all.',
  annotations: {
    title: 'Create a server',
    readOnlyHint: false,
    // Nothing existing is altered or removed. The cost is real and is stated in
    // the description and in meta.billing; `destructiveHint` answers a different
    // question — whether something the user already had is being taken away —
    // and overloading it would devalue it on the tools that genuinely destroy.
    destructiveHint: false,
    // Server names are unique per project, so a repeat is not a second machine —
    // it is a `uniqueness_error`. Not a no-op either way.
    idempotentHint: false,
    openWorldHint: true,
  },
  surface: 'write',
  apiSurfaces: API_SURFACES,
  inputSchema: (cfg: ServerConfig): Record<string, unknown> => ({
    ...connectionProperty(cfg, { requireExplicit: true, surfaces: API_SURFACES }),
    name: ARGS.shape.name,
    server_type: ARGS.shape.server_type,
    image: ARGS.shape.image,
    location: ARGS.shape.location,
    datacenter: ARGS.shape.datacenter,
    ssh_keys: ARGS.shape.ssh_keys,
    user_data: ARGS.shape.user_data,
    labels: ARGS.shape.labels,
    networks: ARGS.shape.networks,
    firewalls: ARGS.shape.firewalls,
    placement_group: ARGS.shape.placement_group,
    start_after_create: ARGS.shape.start_after_create,
    public_net: ARGS.shape.public_net,
    ...waitProperty(),
  }),
  handler,
};
