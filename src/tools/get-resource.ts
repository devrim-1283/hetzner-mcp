/**
 * get_resource — the complete stored configuration of one Hetzner resource.
 *
 * WHY `resource_type` IS REQUIRED, AND WHY THERE IS NO 404 PROBE
 *
 * The sibling product made `resource_type` mandatory too, and then softened the
 * cost by probing the other families on a 404 so the error could name the family
 * that really owns the uuid. That trick does not port, and porting it would be
 * actively dangerous rather than merely unhelpful.
 *
 * A Coolify uuid is globally unique: at most one family owns it, so a probe
 * either finds that family or finds nothing. A Hetzner id is a small integer
 * allocated per type, so id 42 is routinely a server AND a volume AND a network
 * at the same time — three real, unrelated resources. A probe would find one of
 * them, and the answer would read as "you meant this one" while pointing at
 * something the caller has never heard of. Worse, the same reasoning applies to
 * any tool that acted on the probe's answer.
 *
 * So the type is a required parameter, the id is interpreted strictly inside it,
 * and nothing is guessed on failure.
 *
 * THE 404
 *
 * On the cloud surface a 404 is only half a statement about existence. A Hetzner
 * Cloud token belongs to exactly one project and the API has no project
 * parameter, so a resource in another project is invisible rather than
 * forbidden — a perfectly valid token pointed one project sideways answers 404,
 * not 403. The hint says so, because the alternative is an hour spent checking
 * an id that was right all along.
 */

import { z } from 'zod';

import { request } from '../http/client.js';
import { CLOUD_PROJECT_SCOPING } from '../http/errors.js';
import { defaultShape } from '../shaping/project.js';
import type { Row } from '../shaping/project.js';
import { shapeResponse, type EnvelopeMeta } from '../shaping/envelope.js';
import { HetznerError, SURFACE_LABELS } from '../types.js';
import type { Connection, ToolDef } from '../types.js';
import {
  RESOURCE_SURFACES,
  RESOURCE_TYPES,
  readResourceType,
  specFor,
  type ResourceType,
} from './find-resources.js';
import {
  connectionProperty,
  renderEnvelope,
  requiredId,
  requiredString,
  resolveConnection,
  runTool,
  toRecord,
} from './shared.js';

// ---------------------------------------------------------------------------
// Addressing
// ---------------------------------------------------------------------------

/**
 * Characters that would turn a path parameter into something other than a path
 * parameter. The transport refuses these itself; catching them here names the
 * offending argument instead of reporting a malformed URL.
 */
const UNSAFE_IN_PATH = /[/?#\\\s]/;

/**
 * The `{id}` — or, for a DNS zone, the `{id_or_name}`.
 *
 * `GET /zones/{id_or_name}` accepts the domain name directly, and a caller who
 * has "example.com" in hand should not have to spend a list call turning it into
 * 4711. Every other type is addressed by the integer only, and accepting a name
 * there would mean inventing a lookup this tool does not do.
 */
function readAddress(args: Record<string, unknown>, type: ResourceType): string {
  if (specFor(type).addressableByName !== true) return String(requiredId(args, 'id'));

  const raw = requiredString(args, 'id');
  if (/^[1-9][0-9]*$/.test(raw)) return raw;
  if (UNSAFE_IN_PATH.test(raw)) {
    throw new HetznerError(
      '`id` must be a zone id or a domain name.',
      'validation',
      'A zone is addressed by its numeric id or by the domain itself, e.g. "example.com". It never contains a slash, a space or a query string.',
    );
  }
  return raw;
}

/**
 * The 404 copy this tool exists to get right.
 *
 * Only the opening sentence is written here — the resource type, the id and the
 * connection are things the transport cannot know, and naming them is what turns
 * a generic 404 into an answer. The project-scoping paragraph comes from
 * {@link CLOUD_PROJECT_SCOPING} rather than being restated: it is the most
 * valuable diagnostic in the product, and a second copy in this layer would
 * eventually drift from the transport's copy, leaving a user with two different
 * explanations of one phenomenon depending on which layer answered.
 *
 * The account surface has no project concept, so it gets the shorter true
 * version instead of a scoped hint that would not apply to it.
 */
function notFound(
  type: ResourceType,
  address: string,
  connection: Connection,
  cause: HetznerError,
): HetznerError {
  const message = `No ${type} with id ${address} on connection \`${connection.name}\`.`;
  const explanation =
    connection.surface === 'cloud'
      ? `On Hetzner Cloud a 404 does not only mean the id is wrong. ${CLOUD_PROJECT_SCOPING}`
      : `${SURFACE_LABELS[connection.surface]} has no projects, so a 404 there means no ${type} with this id exists on the account connection \`${connection.name}\` authenticates as.`;
  return new HetznerError(
    message,
    'not_found',
    `${explanation} find_resources lists the ids this token can see.`,
    cause.status ?? 404,
    cause.apiCode,
  );
}

// ---------------------------------------------------------------------------
// The tool
// ---------------------------------------------------------------------------

export const getResourceTool: ToolDef = {
  name: 'get_resource',
  description:
    'Return the full stored configuration of one Hetzner resource: every field the API holds for it, not the projected row find_resources returns. ' +
    `resource_type is one of ${RESOURCE_TYPES.join(', ')} and is required, because a Hetzner id is a plain integer allocated per type — the same id can be a server and a volume at the same time, so the id alone does not identify a resource. ` +
    'A DNS zone may be addressed by its domain name instead of its id. ' +
    'Oversized records are degraded rather than dropped, and meta.truncation reports it when that happens.',
  annotations: {
    title: 'Get resource',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  surface: 'read',
  apiSurfaces: RESOURCE_SURFACES,
  inputSchema: (cfg) => ({
    resource_type: z
      .enum(RESOURCE_TYPES)
      .describe(
        'Which type the id belongs to. Required — Hetzner ids are per-type integers, so reading id 42 as the wrong type either 404s or returns a different, real resource. find_resources reports the type of everything it lists.',
      ),
    id: z
      .union([z.number().int().positive(), z.string()])
      .describe(
        'Numeric resource id, as returned by find_resources. For resource_type "zone" the domain name is accepted too, e.g. "example.com", because Hetzner addresses zones by id or name.',
      ),
    ...connectionProperty(cfg, { surfaces: RESOURCE_SURFACES }),
  }),
  handler: async (args, cfg, extra) =>
    runTool(async () => {
      const type = readResourceType(args);
      const spec = specFor(type);
      const connection = resolveConnection(args, cfg, { surfaces: RESOURCE_SURFACES });

      // Checked before the request so the refusal names the mismatch. Sending it
      // anyway would produce a 404 from an API that has never heard of this type
      // and a hint about project scoping that has nothing to do with it.
      if (connection.surface !== spec.surface) {
        throw new HetznerError(
          `\`${type}\` lives on ${SURFACE_LABELS[spec.surface]}, and connection \`${connection.name}\` is on ${SURFACE_LABELS[connection.surface]}.`,
          'surface_mismatch',
          'Each Hetzner API is a separate host with its own credential, so a connection can only read the types its own surface serves.',
        );
      }

      const address = readAddress(args, type);
      const response = await request({
        connection,
        method: 'GET',
        path: `${spec.listPath}/${encodeURIComponent(address)}`,
        operationId: spec.getOperationId,
        signal: extra.signal,
      }).catch((error: unknown) => {
        if (error instanceof HetznerError && error.kind === 'not_found') {
          throw notFound(type, address, connection, error);
        }
        throw error;
      });

      const body = toRecord(response.data);
      const record = body[spec.itemKey];
      if (!isRow(record)) {
        throw new HetznerError(
          `Hetzner returned no ${type} record for id ${address}.`,
          'not_found',
          `The request succeeded but the body carried no \`${spec.itemKey}\` object, which usually means something on the network path answered instead of Hetzner.`,
        );
      }

      const meta: EnvelopeMeta = {
        connection: connection.name,
        surface: connection.surface,
        count: 1,
        hint: `Every field Hetzner returned for this ${type} is present unless meta.truncation says otherwise.`,
      };

      // Full detail, but not unbounded. No `fields` allowlist — a caller reaches
      // for this tool precisely because the projected find_resources row was not
      // enough — while `prunable` gives the ladder the same sacrifice order the
      // list projections use, so an oversized record degrades in a known order
      // instead of hitting the whole-payload backstop.
      return renderEnvelope(
        shapeResponse(record, meta, { prunable: defaultShape(spec.family).prunable }),
      );
    }),
};

function isRow(value: unknown): value is Row {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
