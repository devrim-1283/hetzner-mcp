/**
 * `control_resource` — the operator's verbs, over Hetzner's action endpoints.
 *
 * One tool rather than twenty. Hetzner exposes each verb as its own endpoint —
 * `POST /servers/{id}/actions/poweron`, `.../shutdown`, `.../attach_iso` — and a
 * tool per endpoint would spend twenty schemas of context every turn to express
 * two enums with an id between them. The cross product is regular enough that
 * one table describes all of it.
 *
 * Two properties are load-bearing and are enforced here rather than left to the
 * API:
 *
 *   Legality is per resource type. `resize` is a volume verb; `poweroff` is a
 *   server verb. A wrong pair is refused with the list of what IS legal for that
 *   type, which turns a guess into a one-turn fix instead of a search.
 *
 *   `rebuild` is not reachable. It wipes every disk on the server and is
 *   classified destructive in the catalog, so it belongs behind the destructive
 *   gate. Asking for it here answers where it lives and why, rather than failing
 *   with a schema error that teaches nothing.
 *
 * The hard-power verbs (`poweroff`, `reset`) are NOT gated as destructive, and
 * that is deliberate: they are the standard recovery for a machine that has
 * stopped responding, and a switch everybody turns on during setup protects
 * nobody. What they cost is unflushed writes, and the only place that can be
 * said is the copy — so the description and the hints say it plainly, next to
 * the graceful verbs they are one letter away from being confused with.
 */

import { z } from 'zod';

import { request } from '../http/client.js';
import { HetznerError } from '../types.js';
import type { ServerConfig, Surface, ToolDef, ToolExtra, ToolResult } from '../types.js';
import {
  DESTRUCTIVE_ENABLEMENT,
  RESERVED_AND_BILLED_UNTIL_DELETED,
  SERVER_BILLED_UNTIL_DELETED,
  assertDanger,
  attachAction,
  availableDangerClasses,
  awaitAction,
  connectionProperty,
  noActionHint,
  readAction,
  readWaitMs,
  renderEnvelope,
  requiredId,
  resolveConnection,
  runTool,
  shapeResponse,
  unsettledHint,
  validationFrom,
  waitProperty,
} from './shared.js';

/** Cloud only: the action endpoints exist on no other Hetzner API. */
const API_SURFACES: readonly Surface[] = ['cloud'];

const RESOURCE_TYPES = ['server', 'volume', 'floating_ip', 'primary_ip', 'load_balancer'] as const;

/**
 * Every action name here is Hetzner's own path segment, never a synonym.
 *
 * An enum of invented verbs ("stop", "restart") would have to be translated, and
 * the translation is where "stop" quietly becomes the hard `poweroff` instead of
 * the graceful `shutdown`. Using the API's vocabulary means what the model asks
 * for and what the API runs are the same word.
 */
const ACTIONS = [
  'poweron',
  'poweroff',
  'shutdown',
  'reboot',
  'reset',
  'enable_rescue',
  'disable_rescue',
  'attach_iso',
  'detach_iso',
  'change_protection',
  'enable_backup',
  'disable_backup',
  'attach_to_network',
  'detach_from_network',
  'attach',
  'detach',
  'resize',
  'assign',
  'unassign',
  'add_target',
  'remove_target',
] as const;

type ResourceType = (typeof RESOURCE_TYPES)[number];
type Action = (typeof ACTIONS)[number];

/** Resource type to the path segment Hetzner uses for its collection. */
const SEGMENT: Record<ResourceType, string> = {
  server: 'servers',
  volume: 'volumes',
  floating_ip: 'floating_ips',
  primary_ip: 'primary_ips',
  load_balancer: 'load_balancers',
};

/**
 * Action arguments are flat and named after what they are, not nested under the
 * action that reads them.
 *
 * The alternative — one `options` object per action — is a shape the model has
 * to reconstruct from prose. Flat names plus a per-combination allowlist give
 * the same safety with none of the nesting, and the allowlist is what turns a
 * parameter sent to the wrong action into an error rather than a silent no-op.
 */
const PARAM_NAMES = [
  'network',
  'ip',
  'alias_ips',
  'ip_range',
  'iso',
  'rescue_type',
  'ssh_keys',
  'protection_delete',
  'protection_rebuild',
  'server',
  'automount',
  'size',
  'target_type',
  'target_server_id',
  'target_label_selector',
  'target_ip',
  'use_private_ip',
] as const;

type ParamName = (typeof PARAM_NAMES)[number];

/** Where each parameter is read, for the message when it is sent elsewhere. */
const PARAM_SCOPE: Record<ParamName, string> = {
  network: 'attach_to_network and detach_from_network, on a server or a load_balancer',
  ip: 'attach_to_network, to request one specific private address',
  alias_ips: 'attach_to_network on a server',
  ip_range: 'attach_to_network, to choose which subnet the address comes from',
  iso: 'attach_iso on a server',
  rescue_type: 'enable_rescue on a server',
  ssh_keys: 'enable_rescue on a server',
  protection_delete: 'change_protection on a server',
  protection_rebuild: 'change_protection on a server',
  server: 'attach on a volume, and assign on a floating_ip or a primary_ip',
  automount: 'attach on a volume',
  size: 'resize on a volume',
  target_type: 'add_target and remove_target on a load_balancer',
  target_server_id: 'add_target and remove_target on a load_balancer',
  target_label_selector: 'add_target and remove_target on a load_balancer',
  target_ip: 'add_target and remove_target on a load_balancer',
  use_private_ip: 'add_target on a load_balancer',
};

// ---------------------------------------------------------------------------
// The table
//
// Declared before the schema because the `action` parameter's description is
// generated from it: the published menu of actions cannot drift from the one
// the handler implements if there is only one list.
// ---------------------------------------------------------------------------

interface ActionSpec {
  /** Catalog id, passed to the transport so its classifier can escalate. */
  operationId: string;
  /** Parameters this combination reads. Anything else provided is refused. */
  params: readonly ParamName[];
  required: readonly ParamName[];
  body?: (args: ControlArgs) => Record<string, unknown>;
  /** Facts about what the call set in motion. Never an instruction. */
  hint: string;
}

/**
 * `rebuild` is absent from this table, and from the `action` enum, on purpose —
 * see `ELSEWHERE` below. So is every other operation the catalog classifies as
 * destructive, and the `assertDanger` call in the handler checks that claim
 * against the catalog on every call rather than trusting this table to stay true
 * after a regeneration.
 */
const SPECS: Record<ResourceType, Partial<Record<Action, ActionSpec>>> = {
  server: {
    poweron: {
      operationId: 'poweron_server',
      params: [],
      required: [],
      hint: 'The server was powered on. It boots from its disk unless a rescue system is armed or an ISO is attached, either of which takes precedence.',
    },
    poweroff: {
      operationId: 'poweroff_server',
      params: [],
      required: [],
      hint:
        'This cut power to the server without asking the operating system, the equivalent of pulling the plug: anything not yet written to disk is gone. `shutdown` is the graceful form. ' +
        SERVER_BILLED_UNTIL_DELETED,
    },
    shutdown: {
      operationId: 'shutdown_server',
      params: [],
      required: [],
      hint:
        'This sent an ACPI shutdown request, which the operating system carries out itself. A machine that is hung, or has no ACPI handler installed, ignores it and stays running — `poweroff` cuts power regardless. ' +
        SERVER_BILLED_UNTIL_DELETED,
    },
    reboot: {
      operationId: 'reboot_server',
      params: [],
      required: [],
      hint: 'This sent an ACPI restart request, which the operating system carries out itself. A hung machine ignores it; `reset` restarts it regardless, at the cost of anything not yet written to disk.',
    },
    reset: {
      operationId: 'reset_server',
      params: [],
      required: [],
      hint: 'This was a hard reset: the server was power-cycled without asking the operating system, so anything not yet written to disk is gone. `reboot` is the graceful form.',
    },
    enable_rescue: {
      operationId: 'enable_server_rescue',
      params: ['rescue_type', 'ssh_keys'],
      required: [],
      body: (args) => {
        const body: Record<string, unknown> = {};
        if (args.rescue_type !== undefined) body['type'] = args.rescue_type;
        if (args.ssh_keys !== undefined) body['ssh_keys'] = args.ssh_keys;
        return body;
      },
      hint: 'The rescue system is armed but not running: it comes up at the next boot, so the server has to be restarted to enter it, and it stays armed for that one boot.',
    },
    disable_rescue: {
      operationId: 'disable_server_rescue',
      params: [],
      required: [],
      hint: 'The rescue system is disarmed and will not come up at the next boot. A rescue system that is currently running keeps running until the server is restarted.',
    },
    attach_iso: {
      operationId: 'attach_server_iso',
      params: ['iso'],
      required: ['iso'],
      body: (args) => ({ iso: args.iso }),
      hint: 'The ISO is attached. Booting from it needs a restart, and while it stays attached the server boots the ISO in preference to its disk.',
    },
    detach_iso: {
      operationId: 'detach_server_iso',
      params: [],
      required: [],
      hint: 'The ISO is detached. The server boots from its own disk again at the next restart.',
    },
    change_protection: {
      operationId: 'change_server_protection',
      params: ['protection_delete', 'protection_rebuild'],
      required: [],
      body: (args) => protectionBody(args),
      hint: 'Protection is enforced by Hetzner itself: a protected server is refused deletion and rebuild whatever the API token is otherwise allowed to do.',
    },
    enable_backup: {
      operationId: 'enable_server_backup',
      params: [],
      required: [],
      hint: 'Backups are billed as a surcharge on the server price — Hetzner charges 20% of it, and the pricing endpoint reports the exact percentage for this project. Seven daily backups are kept on a rolling basis.',
    },
    disable_backup: {
      operationId: 'disable_server_backup',
      params: [],
      required: [],
      hint: 'The surcharge stops, and the backups that already exist are deleted with it. Backups that were converted into snapshots are separate resources and are unaffected.',
    },
    attach_to_network: {
      operationId: 'attach_server_to_network',
      params: ['network', 'ip', 'alias_ips', 'ip_range'],
      required: ['network'],
      body: (args) => {
        const body: Record<string, unknown> = { network: args.network };
        if (args.ip !== undefined) body['ip'] = args.ip;
        if (args.alias_ips !== undefined) body['alias_ips'] = args.alias_ips;
        if (args.ip_range !== undefined) body['ip_range'] = args.ip_range;
        return body;
      },
      hint: 'The server now has an interface on the private network. The operating system has to configure that interface before traffic flows over it; a reboot, or cloud-init, usually does.',
    },
    detach_from_network: {
      operationId: 'detach_server_from_network',
      params: ['network'],
      required: ['network'],
      body: (args) => ({ network: args.network }),
      hint: 'The private interface is gone and the address it held is released back to the subnet. Anything addressing this server by that private address stops reaching it.',
    },
  },
  volume: {
    attach: {
      operationId: 'attach_volume',
      params: ['server', 'automount'],
      required: ['server'],
      body: (args) => {
        const body: Record<string, unknown> = { server: args.server };
        if (args.automount !== undefined) body['automount'] = args.automount;
        return body;
      },
      hint: 'The volume is attached and appears as a block device on the server. Without automount the filesystem still has to be mounted inside the operating system. A volume attaches to one server at a time, and only to a server in the same location.',
    },
    detach: {
      operationId: 'detach_volume',
      params: [],
      required: [],
      hint: 'The volume is detached and keeps its contents. ' + RESERVED_AND_BILLED_UNTIL_DELETED,
    },
    resize: {
      operationId: 'resize_volume',
      params: ['size'],
      required: ['size'],
      body: (args) => ({ size: args.size }),
      hint: 'This cannot be undone: a Hetzner volume can grow but never shrink, and it is billed at the new size from now on. The filesystem inside the volume is not resized by this — that is done on the server.',
    },
  },
  floating_ip: {
    assign: {
      operationId: 'assign_floating_ip',
      params: ['server'],
      required: ['server'],
      body: (args) => ({ server: args.server }),
      hint: 'The floating IP now routes to this server. The server does not learn about it from this call: the address has to be configured on its interface before it answers on it.',
    },
    unassign: {
      operationId: 'unassign_floating_ip',
      params: [],
      required: [],
      hint: 'The floating IP no longer routes anywhere. ' + RESERVED_AND_BILLED_UNTIL_DELETED,
    },
  },
  primary_ip: {
    assign: {
      operationId: 'assign_primary_ip',
      params: ['server'],
      required: ['server'],
      body: (args) => ({ assignee_type: 'server', assignee_id: args.server }),
      hint: 'The primary IP is assigned to the server. Hetzner permits this only while the server is powered off, and a server holds at most one primary IP per protocol.',
    },
    unassign: {
      operationId: 'unassign_primary_ip',
      params: [],
      required: [],
      hint:
        'The primary IP is detached, leaving the server without a public address of that protocol. ' +
        RESERVED_AND_BILLED_UNTIL_DELETED,
    },
  },
  load_balancer: {
    attach_to_network: {
      operationId: 'attach_load_balancer_to_network',
      params: ['network', 'ip', 'ip_range'],
      required: ['network'],
      body: (args) => {
        const body: Record<string, unknown> = { network: args.network };
        if (args.ip !== undefined) body['ip'] = args.ip;
        if (args.ip_range !== undefined) body['ip_range'] = args.ip_range;
        return body;
      },
      hint: 'The load balancer now has an address on the private network, which is what targets added with use_private_ip are reached over.',
    },
    detach_from_network: {
      operationId: 'detach_load_balancer_from_network',
      params: ['network'],
      required: ['network'],
      body: (args) => ({ network: args.network }),
      hint: 'The load balancer is off the private network. Any target it was reaching over a private address becomes unreachable.',
    },
    add_target: {
      operationId: 'add_load_balancer_target',
      params: [
        'target_type',
        'target_server_id',
        'target_label_selector',
        'target_ip',
        'use_private_ip',
      ],
      required: ['target_type'],
      body: (args) => targetBody(args, true),
      hint: 'The target is added and starts receiving traffic once its health check passes. A label_selector target keeps matching: servers that acquire the label later are added on their own.',
    },
    remove_target: {
      operationId: 'remove_load_balancer_target',
      params: ['target_type', 'target_server_id', 'target_label_selector', 'target_ip'],
      required: ['target_type'],
      body: (args) => targetBody(args, false),
      hint: 'The target no longer receives traffic. Connections already open to it are not drained by this call.',
    },
  },
};

function protectionBody(args: ControlArgs): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (args.protection_delete !== undefined) body['delete'] = args.protection_delete;
  if (args.protection_rebuild !== undefined) body['rebuild'] = args.protection_rebuild;
  if (Object.keys(body).length === 0) {
    throw new HetznerError(
      '`change_protection` needs at least one of `protection_delete` or `protection_rebuild`.',
      'validation',
      'Hetzner currently requires the two flags to hold the same value, so setting only one can be rejected by the API.',
    );
  }
  return body;
}

/**
 * A Load Balancer target, from the flat arguments.
 *
 * `target_ip` is an address in a request BODY, never a request destination: the
 * transport builds every URL by concatenation onto the surface's own pinned
 * origin, so no value reaching this function can move where the credential goes.
 */
function targetBody(args: ControlArgs, allowPrivate: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = { type: args.target_type };

  if (args.target_type === 'server') {
    if (args.target_server_id === undefined) {
      throw missingTargetDetail('target_server_id', 'server');
    }
    body['server'] = { id: args.target_server_id };
  } else if (args.target_type === 'label_selector') {
    if (args.target_label_selector === undefined) {
      throw missingTargetDetail('target_label_selector', 'label_selector');
    }
    body['label_selector'] = { selector: args.target_label_selector };
  } else {
    if (args.target_ip === undefined) throw missingTargetDetail('target_ip', 'ip');
    body['ip'] = { ip: args.target_ip };
  }

  if (allowPrivate && args.use_private_ip !== undefined) {
    body['use_private_ip'] = args.use_private_ip;
  }
  return body;
}

function missingTargetDetail(param: ParamName, type: string): HetznerError {
  return new HetznerError(
    `\`${param}\` is required when \`target_type\` is "${type}".`,
    'validation',
    'Each target type carries exactly one detail: server takes target_server_id, label_selector takes target_label_selector, ip takes target_ip.',
  );
}

// ---------------------------------------------------------------------------
// Legality
// ---------------------------------------------------------------------------

function legalActions(resourceType: ResourceType): Action[] {
  return Object.keys(SPECS[resourceType]) as Action[];
}

/** Which resource types accept an action, for the "you wanted it over there" line. */
function typesAccepting(action: string): ResourceType[] {
  return RESOURCE_TYPES.filter((type) => (legalActions(type) as string[]).includes(action));
}

/**
 * Actions this tool deliberately does not carry, and where each one lives.
 *
 * `rebuild` is the whole reason this map exists. It is a POST that returns 201
 * and erases every disk on the server, which is why the catalog classifies it by
 * consequence rather than by HTTP method. Refusing it with a schema error would
 * leave a model retrying spellings; refusing it with the address of the door it
 * is actually behind ends the exchange in one turn.
 */
const ELSEWHERE: ReadonlyMap<string, string> = new Map([
  [
    'rebuild',
    'Rebuilding a server erases every disk on it and reinstalls from an image, so the catalog classifies it as destructive and this tool does not carry it. It is the `rebuild_server` operation, reachable through execute_destructive_operation. ' +
      DESTRUCTIVE_ENABLEMENT,
  ],
]);

function resolveSpec(resourceType: ResourceType, action: string): ActionSpec {
  const spec = SPECS[resourceType][action as Action];
  if (spec !== undefined) return spec;

  const legal = legalActions(resourceType).join(', ');
  const elsewhere = ELSEWHERE.get(action);
  if (elsewhere !== undefined) {
    throw new HetznerError(
      `\`${action}\` is not available from control_resource.`,
      'validation',
      `${elsewhere} A ${resourceType} accepts these actions here: ${legal}.`,
    );
  }

  const alsoOn = typesAccepting(action);
  const pointer =
    alsoOn.length > 0
      ? ` \`${action}\` is an action on ${alsoOn.join(' and ')}, not on a ${resourceType}.`
      : '';
  throw new HetznerError(
    `\`${action}\` is not an action on a ${resourceType}.`,
    'validation',
    `A ${resourceType} accepts: ${legal}.${pointer}`,
  );
}

/**
 * The `action` parameter's description, generated from the table.
 *
 * The last sentences are the ones that earn their tokens. `poweroff` and
 * `shutdown` are near-synonyms in English and opposites in consequence, and a
 * model choosing by name similarity will reach for either — so the difference is
 * stated where the choice is made, not only in the result.
 */
function actionDescription(): string {
  const menu = RESOURCE_TYPES.map((type) => `${type} — ${legalActions(type).join(', ')}`).join(
    '; ',
  );
  return (
    `Which Hetzner action to run. Legal actions depend on resource_type: ${menu}. ` +
    'poweroff and reset cut power immediately, losing anything the operating system has not yet ' +
    'written to disk; shutdown and reboot ask the operating system to stop or restart cleanly and ' +
    'are ignored by a machine that is hung. disable_backup deletes the backups that already exist, ' +
    'and resize on a volume cannot be undone. rebuild is not available here: it erases every disk ' +
    'on the server and lives behind execute_destructive_operation.'
  );
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const ARGS = z.object({
  resource_type: z
    .enum(RESOURCE_TYPES)
    .describe(
      'Which kind of resource `id` names. It decides which actions are legal; find_resources reports the type alongside each id.',
    ),
  action: z.enum(ACTIONS).describe(actionDescription()),
  id: z
    .union([z.number().int().positive(), z.string().regex(/^[1-9][0-9]*$/)])
    .describe('Numeric id of the resource to act on, as reported by find_resources.'),
  network: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('attach_to_network / detach_from_network: id of the existing private network.'),
  ip: z
    .string()
    .min(1)
    .optional()
    .describe(
      'attach_to_network: the private address to request inside the network. Omitted, Hetzner assigns one from the subnet.',
    ),
  alias_ips: z
    .array(z.string().min(1))
    .optional()
    .describe(
      'attach_to_network on a server: additional private addresses routed to this server, for example one shared between two servers as a failover address.',
    ),
  ip_range: z
    .string()
    .min(1)
    .optional()
    .describe(
      'attach_to_network: CIDR of the subnet the address should come from, when the network has more than one.',
    ),
  iso: z
    .string()
    .min(1)
    .optional()
    .describe('attach_iso: name or id of the ISO, as listed by the isos collection.'),
  rescue_type: z
    .enum(['linux64'])
    .optional()
    .describe('enable_rescue: which rescue system to arm. Hetzner currently offers only linux64.'),
  ssh_keys: z
    .array(z.number().int().positive())
    .optional()
    .describe(
      'enable_rescue: ids of SSH keys to inject into the rescue system. With none, the rescue system is reachable only through the generated root password returned in the response.',
    ),
  protection_delete: z
    .boolean()
    .optional()
    .describe('change_protection: whether Hetzner refuses to delete this server.'),
  protection_rebuild: z
    .boolean()
    .optional()
    .describe(
      'change_protection: whether Hetzner refuses to rebuild this server. Hetzner currently requires this to hold the same value as protection_delete.',
    ),
  server: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      'Volume attach, and floating_ip / primary_ip assign: id of the server the resource is attached or assigned to.',
    ),
  automount: z
    .boolean()
    .optional()
    .describe(
      'Volume attach: mount the volume in the running operating system as well as attaching the block device. Hetzner reboots the server to do it.',
    ),
  size: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      'Volume resize: the new size in GB. It must be larger than the current size — a volume cannot be shrunk — and the volume is billed at the new size from then on.',
    ),
  target_type: z
    .enum(['server', 'label_selector', 'ip'])
    .optional()
    .describe(
      'add_target / remove_target: server names one machine by id; label_selector names every server carrying a label expression, including ones created later; ip names a Hetzner dedicated server by address.',
    ),
  target_server_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('add_target / remove_target with target_type "server": id of that server.'),
  target_label_selector: z
    .string()
    .min(1)
    .max(1000)
    .optional()
    .describe(
      'add_target / remove_target with target_type "label_selector": the selector, for example "env=prod".',
    ),
  target_ip: z
    .string()
    .min(1)
    .optional()
    .describe(
      'add_target / remove_target with target_type "ip": address of a Hetzner dedicated server in the same account. Addresses of cloud resources are rejected by Hetzner.',
    ),
  use_private_ip: z
    .boolean()
    .optional()
    .describe(
      'add_target: reach the target over the private network the load balancer is attached to rather than over its public address.',
    ),
});

type ControlArgs = z.infer<typeof ARGS>;

/**
 * Rejects parameters the combination does not read.
 *
 * Hetzner ignores an unread body field rather than refusing it, which is the
 * worst outcome for a caller who asked for `automount` and did not get it: the
 * call reports success and the request that ran is not the request that was
 * made. Refusing locally converts that into a message naming where the parameter
 * does apply.
 */
function assertParams(args: ControlArgs, spec: ActionSpec): void {
  const accepted = new Set<ParamName>(spec.params);

  for (const param of PARAM_NAMES) {
    if (args[param] === undefined || accepted.has(param)) continue;
    throw new HetznerError(
      `\`${param}\` is not read by \`${args.action}\` on a ${args.resource_type}.`,
      'validation',
      `Hetzner reads \`${param}\` on ${PARAM_SCOPE[param]}. It would have been ignored rather than rejected, so the call was stopped here instead.`,
    );
  }

  for (const param of spec.required) {
    if (args[param] === undefined) {
      throw new HetznerError(
        `\`${param}\` is required for \`${args.action}\` on a ${args.resource_type}.`,
        'validation',
        `Hetzner reads \`${param}\` on ${PARAM_SCOPE[param]}.`,
      );
    }
  }
}

function isResourceType(value: unknown): value is ResourceType {
  return typeof value === 'string' && (RESOURCE_TYPES as readonly string[]).includes(value);
}

function parseArgs(raw: Record<string, unknown>): ControlArgs {
  const parsed = ARGS.safeParse(raw);
  if (parsed.success) return parsed.data;

  // The action is resolved by hand first. A client that validates against the
  // published schema never reaches the handler with `rebuild`, but one that does
  // not would otherwise be told "invalid enum value" and never learn that the
  // operation exists behind another door.
  const action = raw['action'];
  const resourceType = raw['resource_type'];
  if (typeof action === 'string' && isResourceType(resourceType)) {
    resolveSpec(resourceType, action);
  }

  throw validationFrom(parsed.error, 'arguments');
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
    const spec = resolveSpec(args.resource_type, args.action);
    // The catalog's verdict, read at call time rather than trusted from the
    // table above: if a regeneration reclassifies one of these ids, the door
    // closes instead of leaving a destructive operation reachable through a tool
    // annotated `destructiveHint: false`.
    assertDanger(
      spec.operationId,
      ['write'],
      'control_resource',
      availableDangerClasses(cfg).includes('destructive'),
    );
    assertParams(args, spec);

    // Required with no default, enforced here as well as in the schema: a write
    // must never happen through an omitted parameter.
    const connection = resolveConnection(rawArgs, cfg, {
      requireExplicit: true,
      surfaces: API_SURFACES,
    });
    const id = requiredId(rawArgs, 'id');

    const response = await request<unknown>({
      connection,
      method: 'POST',
      path: `/${SEGMENT[args.resource_type]}/${id}/actions/${args.action}`,
      body: spec.body?.(args),
      operationId: spec.operationId,
      signal: extra.signal,
    });

    let action = readAction(response.data);
    let settled = true;
    if (action !== undefined) {
      const outcome = await awaitAction(connection, action, extra, readWaitMs(rawArgs));
      action = outcome.action;
      settled = outcome.settled;
    }

    const notes = [spec.hint];
    if (action === undefined) {
      notes.push(noActionHint(spec.operationId));
    } else if (!settled) {
      notes.push(unsettledHint(action));
    }

    let envelope = shapeResponse(
      {
        resource_type: args.resource_type,
        action: args.action,
        id,
        result: response.data,
      },
      {
        connection: connection.name,
        surface: connection.surface,
        count: 1,
        hint: notes.join(' '),
      },
    );
    if (action !== undefined) envelope = attachAction(envelope, action, settled);
    return renderEnvelope(envelope);
  });
}

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

export const controlResourceTool: ToolDef = {
  name: 'control_resource',
  description:
    "Run Hetzner Cloud's action endpoints on a server, volume, floating IP, primary IP or load balancer: power and boot control, rescue mode, ISO and network attachment, volume attach/detach/resize, IP assignment, and load balancer targets. Which actions are legal depends on resource_type, and an illegal pair is refused with the list of what that type accepts. poweroff and reset cut power immediately and lose unflushed writes; shutdown and reboot ask the operating system to do it cleanly. enable_backup adds roughly 20% to the server price, disable_backup deletes the backups that already exist, and resizing a volume cannot be undone and re-rates it. rebuild is not available here — it erases every disk on the server and lives behind execute_destructive_operation.",
  annotations: {
    title: 'Run a Hetzner action',
    readOnlyHint: false,
    // Nothing this tool reaches is classified destructive by the catalog, and
    // `assertDanger` re-checks that against the catalog on every call. The
    // hard-power verbs risk unflushed writes, which is a cost stated in the copy
    // rather than a claim that stored data is being destroyed — see the header.
    destructiveHint: false,
    // Repeating one of these is usually a no-op, but not always: a second
    // add_target is refused, and so is powering on a server that is already up.
    idempotentHint: false,
    openWorldHint: true,
  },
  surface: 'write',
  apiSurfaces: API_SURFACES,
  inputSchema: (cfg: ServerConfig): Record<string, unknown> => ({
    ...connectionProperty(cfg, { requireExplicit: true, surfaces: API_SURFACES }),
    resource_type: ARGS.shape.resource_type,
    action: ARGS.shape.action,
    id: ARGS.shape.id,
    network: ARGS.shape.network,
    ip: ARGS.shape.ip,
    alias_ips: ARGS.shape.alias_ips,
    ip_range: ARGS.shape.ip_range,
    iso: ARGS.shape.iso,
    rescue_type: ARGS.shape.rescue_type,
    ssh_keys: ARGS.shape.ssh_keys,
    protection_delete: ARGS.shape.protection_delete,
    protection_rebuild: ARGS.shape.protection_rebuild,
    server: ARGS.shape.server,
    automount: ARGS.shape.automount,
    size: ARGS.shape.size,
    target_type: ARGS.shape.target_type,
    target_server_id: ARGS.shape.target_server_id,
    target_label_selector: ARGS.shape.target_label_selector,
    target_ip: ARGS.shape.target_ip,
    use_private_ip: ARGS.shape.use_private_ip,
    ...waitProperty(),
  }),
  handler,
};
