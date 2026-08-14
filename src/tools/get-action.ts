/**
 * get_action — the tool that turns "accepted" into "done".
 *
 * 144 of this API's 221 operations answer with an Action rather than a result:
 * the HTTP call returns `{action: {id, status: 'running', progress: 0}}` and the
 * work happens afterwards. Every write in this product therefore lands in one of
 * two states — finished, or accepted and still running — and without a tool that
 * can tell those apart every write ends in ambiguity.
 *
 * TWO QUESTIONS, ONE TOOL
 *
 * "Did action 42 finish?" and "what has been happening to server 7?" are the
 * same lookup at two cardinalities: the same Action record, the same projection,
 * the same surface-dependent path table, the same envelope. A second tool would
 * duplicate all four and add a second name for the model to disambiguate on
 * every call, in exchange for one absent parameter. So `id` reads one Action,
 * `resource_type` + `resource_id` lists the recent Actions of one resource, and
 * naming neither is refused with both forms spelled out.
 *
 * WHERE AN ACTION IS READ FROM DEPENDS ON THE SURFACE
 *
 * This is not incidental. The cloud API has a global `GET /actions/{id}` and
 * `actionPollPath` returns it. The account API has no global Actions endpoint at
 * all: its Actions belong to the Storage Box product and are readable either
 * across that product (`/storage_boxes/actions/{id}`, which is what the seam
 * returns) or under the Storage Box that produced them
 * (`/storage_boxes/{id}/actions/{action_id}`). Naming the resource selects the
 * second form; omitting it uses the seam's. Robot has no Action model at all,
 * and is refused by name rather than left to answer 404.
 *
 * A FAILED ACTION IS AN ERROR
 *
 * Hetzner reports asynchronous failure inside the Action rather than in the HTTP
 * status, so a 201 followed by a failed Action reads as success to anything that
 * only looked at the response code. `awaitAction` throws for exactly that
 * reason. The listing path deliberately does NOT: a history of what happened to
 * a machine is expected to contain failures, and refusing to show it because one
 * row failed answers a different question than the one asked.
 */

import { z } from 'zod';

import { getOperation } from '../catalog/index.js';
import { request } from '../http/client.js';
import { defaultShape } from '../shaping/project.js';
import { HetznerError, SURFACE_LABELS } from '../types.js';
import type { ActionRef, Connection, Surface, ToolDef, ToolExtra, ToolResult } from '../types.js';
import {
  FIND_RESOURCES_REPORTS_IDS,
  actionPollPath,
  attachAction,
  awaitAction,
  connectionProperty,
  optionalNumber,
  optionalString,
  readAction,
  readWaitMs,
  renderEnvelope,
  requiredId,
  resolveConnection,
  runTool,
  shapeResponse,
  toRecord,
  unsettledHint,
  waitProperty,
  type EnvelopeMeta,
} from './shared.js';

/** Hetzner caps `per_page` at 50 on every paginated collection. */
const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 10;

interface ResourceKind {
  /** Collection segment of the path, e.g. `servers` in `/servers/7/actions`. */
  readonly segment: string;
  readonly surface: Surface;
  /** Catalog id, so the transport classifies the call from the catalog rather than the baseline. */
  readonly listOperation: string;
}

/**
 * The resources that publish an Action history.
 *
 * Derived from the catalog's `/{family}/{id}/actions` rows rather than invented.
 * Zones are the one deliberate omission: their path key is `{id_or_name}` and
 * accepts a domain name, so `resource_id` would have to stop being an id — a
 * different parameter type for one family, in a tool whose other ten families
 * are numeric.
 */
const RESOURCE_KINDS: ReadonlyMap<string, ResourceKind> = new Map<string, ResourceKind>([
  ['server', { segment: 'servers', surface: 'cloud', listOperation: 'list_server_actions' }],
  ['volume', { segment: 'volumes', surface: 'cloud', listOperation: 'list_volume_actions' }],
  ['image', { segment: 'images', surface: 'cloud', listOperation: 'list_image_actions' }],
  [
    'load_balancer',
    {
      segment: 'load_balancers',
      surface: 'cloud',
      listOperation: 'list_load_balancer_actions',
    },
  ],
  [
    'floating_ip',
    { segment: 'floating_ips', surface: 'cloud', listOperation: 'list_floating_ip_actions' },
  ],
  [
    'primary_ip',
    { segment: 'primary_ips', surface: 'cloud', listOperation: 'list_primary_ip_actions' },
  ],
  ['network', { segment: 'networks', surface: 'cloud', listOperation: 'list_network_actions' }],
  ['firewall', { segment: 'firewalls', surface: 'cloud', listOperation: 'list_firewall_actions' }],
  [
    'certificate',
    { segment: 'certificates', surface: 'cloud', listOperation: 'list_certificate_actions' },
  ],
  [
    'storage_box',
    {
      segment: 'storage_boxes',
      surface: 'hetzner',
      listOperation: 'list_storage_box_actions',
    },
  ],
]);

const RESOURCE_TYPES = [...RESOURCE_KINDS.keys()] as [string, ...string[]];

const ACTION_STATUSES = ['running', 'success', 'error'] as const;

/** Ids arrive as numbers from the API and as strings when read back out of a transcript. */
const ID_SCHEMA = z.union([z.number().int().positive(), z.string().regex(/^[1-9][0-9]*$/)]);

interface ResourceScope {
  readonly type: string;
  readonly kind: ResourceKind;
  readonly id: number;
}

// ---------------------------------------------------------------------------
// Argument reading
// ---------------------------------------------------------------------------

function assertActionSurface(connection: Connection): void {
  if (connection.surface !== 'robot') return;
  throw new HetznerError(
    `Connection \`${connection.name}\` is on the Robot surface, which has no Action model: its calls complete before they answer and return their result directly.`,
    'surface_mismatch',
    `Actions exist on ${SURFACE_LABELS.cloud} and ${SURFACE_LABELS.hetzner}.`,
  );
}

/**
 * The `resource_type` / `resource_id` pair, validated against the connection.
 *
 * Half a pair is refused rather than ignored: a caller who named the type and
 * omitted the id asked for one resource's history and would otherwise be
 * answered about a different thing entirely.
 */
function readScope(
  args: Record<string, unknown>,
  connection: Connection,
): ResourceScope | undefined {
  const type = optionalString(args, 'resource_type');
  const hasId = args['resource_id'] !== undefined && args['resource_id'] !== null;

  if (type === undefined) {
    if (!hasId) return undefined;
    throw new HetznerError(
      '`resource_id` was given without `resource_type`.',
      'validation',
      `A resource is named by both: one of ${RESOURCE_TYPES.join(', ')}, plus its numeric id.`,
    );
  }

  const kind = RESOURCE_KINDS.get(type);
  if (kind === undefined) {
    throw new HetznerError(
      `\`resource_type\` "${type}" is not a resource that publishes an Action history.`,
      'validation',
      `Available: ${RESOURCE_TYPES.join(', ')}.`,
    );
  }
  if (kind.surface !== connection.surface) {
    throw new HetznerError(
      `\`${type}\` lives on ${SURFACE_LABELS[kind.surface]}, and connection \`${connection.name}\` is on ${SURFACE_LABELS[connection.surface]}.`,
      'surface_mismatch',
      'The surface travels with the connection; a cloud Server and an account Storage Box are reachable only through their own.',
    );
  }
  if (!hasId) {
    throw new HetznerError(
      `\`resource_id\` is required alongside \`resource_type: "${type}"\`.`,
      'validation',
      FIND_RESOURCES_REPORTS_IDS,
    );
  }
  return { type, kind, id: requiredId(args, 'resource_id') };
}

/**
 * Where one Action is read from.
 *
 * Naming the resource selects the per-resource form, which is the only form the
 * account API documents per Storage Box; omitting it falls back to the seam,
 * which knows the global cloud endpoint and the account API's product-wide one.
 */
function actionReadPath(
  surface: Surface,
  actionId: number,
  scope: ResourceScope | undefined,
): string {
  if (scope === undefined) return actionPollPath(surface, actionId);
  return `/${scope.kind.segment}/${scope.id}/actions/${actionId}`;
}

function actionRows(payload: unknown): ActionRef[] {
  const rows = toRecord(payload)['actions'];
  if (!Array.isArray(rows)) return [];
  const out: ActionRef[] = [];
  for (const row of rows) {
    // `readAction` unwraps `{action: ...}`, which is the single-Action shape.
    const action = readAction({ action: row });
    if (action !== undefined) out.push(action);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The two modes
// ---------------------------------------------------------------------------

async function readOneAction(
  args: Record<string, unknown>,
  connection: Connection,
  scope: ResourceScope | undefined,
  extra: ToolExtra,
): Promise<ToolResult> {
  const actionId = requiredId(args, 'id');
  const path = actionReadPath(connection.surface, actionId, scope);

  const response = await request({
    connection,
    method: 'GET',
    path,
    operationId: scope === undefined && connection.surface === 'cloud' ? 'get_action' : undefined,
    signal: extra.signal,
  });

  const action = readAction(response.data);
  if (action === undefined) {
    throw new HetznerError(
      `${path} returned no Action for id ${actionId}.`,
      'not_found',
      "Action ids are project-scoped on the cloud surface, so an id from one project reads as absent through another project's token.",
    );
  }

  const waitMs = readWaitMs(args);
  // Handles both cases: an Action that is already terminal returns immediately,
  // a running one is polled with the seam's backoff. A failed Action throws, and
  // `errorResult` renders Hetzner's own `error.code` alongside the message, so
  // the closed-vocabulary reason reaches the transcript without being repeated
  // into the message here.
  const outcome = await awaitAction(connection, action, extra, waitMs);
  const current = outcome.action;
  const settled = outcome.settled;

  const notes: string[] = [
    settled
      ? `The ${current.command} action (id ${current.id}) finished with status ${current.status}.`
      : unsettledHint(current),
  ];
  if (settled && waitMs === 0) {
    notes.push('It was already in a terminal state on the first read; nothing was waited for.');
  }
  if (connection.surface === 'hetzner') {
    notes.push(
      'The account API publishes no global Actions endpoint; this Action was read under the Storage Box product.',
    );
  }

  const meta: EnvelopeMeta = {
    connection: connection.name,
    surface: connection.surface,
    count: 1,
    hint: notes.join(' '),
  };
  // `awaited` is `settled` and nothing else. A running Action reported as
  // finished is worse than one that was never waited for, because the caller
  // cannot tell the difference from the outside.
  return renderEnvelope(
    attachAction(shapeResponse(current, meta, defaultShape('actions')), current, settled),
  );
}

async function listResourceActions(
  args: Record<string, unknown>,
  connection: Connection,
  scope: ResourceScope,
  signal?: AbortSignal,
): Promise<ToolResult> {
  const status = optionalString(args, 'status');
  if (
    status !== undefined &&
    !ACTION_STATUSES.includes(status as (typeof ACTION_STATUSES)[number])
  ) {
    throw new HetznerError(
      `\`status\` "${status}" is not an Action status.`,
      'validation',
      `An Action is one of: ${ACTION_STATUSES.join(', ')}.`,
    );
  }
  const limit = Math.min(Math.max(optionalNumber(args, 'limit') ?? DEFAULT_LIMIT, 1), MAX_LIMIT);

  // The catalog is the authority on whether an endpoint takes page/per_page,
  // rather than an assumption that every collection does. Sending `per_page` to
  // an endpoint that does not accept it is a silently ignored parameter at best.
  const paginated = getOperation(scope.kind.listOperation)?.paginated === true;

  const response = await request({
    connection,
    method: 'GET',
    path: `/${scope.kind.segment}/${scope.id}/actions`,
    operationId: scope.kind.listOperation,
    // Newest first: the question this form answers is "what has been happening",
    // and Hetzner's default order puts the oldest Action of the resource's whole
    // life on page one.
    query: { sort: 'started:desc', status, per_page: paginated ? limit : undefined },
    signal,
  });

  const rows = actionRows(response.data);
  const failed = rows.filter((row) => row.status === 'error').length;
  const running = rows.filter((row) => row.status === 'running').length;

  const notes: string[] = [
    `The ${limit === rows.length ? 'most recent ' : ''}${rows.length} Action(s) of ${scope.type} ${scope.id}, newest first${status === undefined ? '' : `, status ${status}`}.`,
  ];
  if (failed > 0) {
    notes.push(
      `${failed} of them failed; each carries its own error.code and error.message, which is where Hetzner records an asynchronous failure.`,
    );
  }
  if (running > 0) {
    notes.push(
      `${running} are still running. Passing that Action's id as \`id\` reads it on its own and can wait for it.`,
    );
  }
  if (rows.length === 0) {
    notes.push('Hetzner retains Actions for a limited period, so an old history reads as empty.');
  }

  const meta: EnvelopeMeta = {
    connection: connection.name,
    surface: connection.surface,
    total: response.pagination?.totalEntries,
    hint: notes.join(' '),
  };
  return renderEnvelope(shapeResponse(rows, meta, defaultShape('actions')));
}

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

export const getActionTool: ToolDef = {
  name: 'get_action',
  description:
    'Read one Hetzner Action, optionally waiting for it to finish, or list the recent Actions of one resource. ' +
    'Most Hetzner mutations are asynchronous: the call returns an Action with status "running" and the work completes afterwards, so the Action is where the outcome of a write is recorded. ' +
    'With `id` this returns that single Action and meta.action.awaited states whether it actually reached a terminal state within the wait. ' +
    "With `resource_type` and `resource_id` it returns that resource's recent Actions, newest first — what has been happening to one machine, volume or Load Balancer. " +
    'An Action that failed is returned as an error carrying the code and message Hetzner recorded on it.',
  annotations: {
    title: 'Get action',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  surface: 'read',
  apiSurfaces: ['cloud', 'hetzner'],
  inputSchema: (cfg) => ({
    id: ID_SCHEMA.describe(
      'Action id — the value reported as meta.action.id by any call that returned an Action. Reads that one Action.',
    ).optional(),
    resource_type: z
      .enum(RESOURCE_TYPES)
      .describe(
        `The kind of resource whose Action history to list, with resource_id. ${RESOURCE_TYPES.slice(0, -1).join(', ')} are Hetzner Cloud; storage_box is the account API. ` +
          'Given together with `id`, it instead selects the per-resource read path for that one Action, which is the form the account API documents per Storage Box.',
      )
      .optional(),
    resource_id: ID_SCHEMA.describe(
      'Numeric id of the resource named by resource_type.',
    ).optional(),
    status: z
      .enum(ACTION_STATUSES)
      .describe(
        'Restricts a resource listing to Actions in this state. Ignored when `id` names a single Action.',
      )
      .optional(),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_LIMIT)
      .describe(
        `How many Actions a resource listing returns, newest first. Default ${DEFAULT_LIMIT}, and Hetzner caps a page at ${MAX_LIMIT}.`,
      )
      .optional(),
    ...waitProperty(),
    ...connectionProperty(cfg),
  }),
  handler: async (args, cfg, extra) =>
    runTool(async () => {
      const connection = resolveConnection(args, cfg);
      assertActionSurface(connection);

      const scope = readScope(args, connection);
      const hasActionId = args['id'] !== undefined && args['id'] !== null;

      if (hasActionId) return readOneAction(args, connection, scope, extra);
      if (scope !== undefined) {
        return listResourceActions(args, connection, scope, extra.signal);
      }

      throw new HetznerError(
        'Name either an Action or a resource.',
        'validation',
        `\`id\` reads one Action; \`resource_type\` plus \`resource_id\` lists one resource's recent Actions. Resource types: ${RESOURCE_TYPES.join(', ')}.`,
      );
    }),
};
