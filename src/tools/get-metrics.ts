/**
 * get_metrics — Server and Load Balancer time series.
 *
 * THE PAYLOAD IS THE PROBLEM
 *
 * Hetzner returns one point per `step` seconds per series. An hour at the fine
 * end is thousands of points; a day of a Server's disk metrics is four series of
 * tens of thousands. Passed through raw that is the entire context budget spent
 * on one call, and no amount of field projection touches it — the bulk is a flat
 * array of `[unixSeconds, "value"]` pairs, not a fat object.
 *
 * So the series is thinned by `downsampleMetrics`, which STRIDES rather than
 * averages. That is a deliberate choice and not an approximation shortcut: an
 * averaged series smears the spike into its neighbours, and the spike is the
 * reason anyone opens metrics at all. Striding keeps real samples with real
 * timestamps and simply keeps fewer of them, so a peak that was in the source is
 * either present verbatim or absent, never quietly halved.
 *
 * Because the thinned series is indistinguishable from a natively coarse one
 * once it is in the transcript, `meta.hint` states that it happened, how many
 * points went in and came out, and what the effective resolution now is. A
 * silently thinned series gets read as the real one.
 *
 * ONE METRIC TYPE PER CALL
 *
 * Hetzner's `type` accepts several values at once, but the types are not the
 * same size: `cpu` is one series, `disk` is four, `network` is two. Combining
 * them multiplies the payload without making any single question easier to
 * answer, so this tool takes one type and the response stays proportional to
 * what was asked for.
 */

import { z } from 'zod';

import { request } from '../http/client.js';
import { downsampleMetrics, type MetricsPayload } from '../shaping/project.js';
import { HetznerError, SURFACE_LABELS } from '../types.js';
import type { Connection, ToolDef } from '../types.js';
import {
  connectionProperty,
  optionalNumber,
  renderEnvelope,
  requiredId,
  requiredString,
  resolveConnection,
  runTool,
  shapeResponse,
  toRecord,
  type EnvelopeMeta,
} from './shared.js';

/** Matches `downsampleMetrics`'s own default; ~120 points is a readable shape. */
const DEFAULT_MAX_POINTS = 120;
const MIN_MAX_POINTS = 10;
const MAX_MAX_POINTS = 1_000;

/** A day. Beyond this the window itself, not the resolution, is the wrong question. */
const MAX_STEP_SECONDS = 86_400;

const SERVER_METRICS = ['cpu', 'disk', 'network'] as const;
const LOAD_BALANCER_METRICS = [
  'open_connections',
  'connections_per_second',
  'requests_per_second',
  'bandwidth',
] as const;

const METRIC_TYPES = [...SERVER_METRICS, ...LOAD_BALANCER_METRICS] as [string, ...string[]];

interface MetricResource {
  readonly segment: string;
  readonly operation: string;
  readonly metrics: readonly string[];
}

const RESOURCES: ReadonlyMap<string, MetricResource> = new Map<string, MetricResource>([
  ['server', { segment: 'servers', operation: 'get_server_metrics', metrics: SERVER_METRICS }],
  [
    'load_balancer',
    {
      segment: 'load_balancers',
      operation: 'get_load_balancer_metrics',
      metrics: LOAD_BALANCER_METRICS,
    },
  ],
]);

const RESOURCE_TYPES = [...RESOURCES.keys()] as [string, ...string[]];

/**
 * RFC 3339 with an explicit offset, which is what Hetzner's spec requires.
 *
 * The offset is not optional here even though `Date.parse` would accept a bare
 * `2024-05-01T12:00:00`: a timestamp without a zone means local time to
 * whichever machine reads it, and a metrics window silently shifted by an hour
 * is a wrong answer that looks entirely plausible.
 */
const RFC3339 = /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}(:\d{2})?(\.\d+)?([Zz]|[+-]\d{2}:?\d{2})$/;

const TIME_FORMAT_HINT =
  'Hetzner requires RFC 3339 with an explicit zone, e.g. 2024-05-01T12:00:00Z or 2024-05-01T14:00:00+02:00.';

// ---------------------------------------------------------------------------
// Argument reading
// ---------------------------------------------------------------------------

function assertCloud(connection: Connection): void {
  if (connection.surface === 'cloud') return;
  throw new HetznerError(
    `Metrics are a Hetzner Cloud feature, and connection \`${connection.name}\` is on ${SURFACE_LABELS[connection.surface]}.`,
    'surface_mismatch',
    'Neither the account API nor Robot publishes a metrics endpoint: account Storage Boxes report usage on the Storage Box record itself, and Robot reports traffic per server on its own resource.',
  );
}

function readTimestamp(args: Record<string, unknown>, key: string): string {
  const raw = requiredString(args, key);
  if (!RFC3339.test(raw) || Number.isNaN(Date.parse(raw))) {
    throw new HetznerError(
      `\`${key}\` is not a valid RFC 3339 timestamp.`,
      'validation',
      TIME_FORMAT_HINT,
    );
  }
  return raw;
}

function readMetricType(args: Record<string, unknown>, resourceType: string): string {
  const resource = RESOURCES.get(resourceType);
  const metricType = requiredString(args, 'metric_type');
  if (resource === undefined) {
    throw new HetznerError(
      `\`resource_type\` "${resourceType}" has no metrics.`,
      'validation',
      `Available: ${RESOURCE_TYPES.join(', ')}.`,
    );
  }
  if (!resource.metrics.includes(metricType)) {
    // Named rather than passed through, because Hetzner's own answer to a
    // cross-typed metric is a 400 whose text does not say which set was wrong.
    throw new HetznerError(
      `\`${metricType}\` is not a ${resourceType} metric.`,
      'validation',
      `A ${resourceType} publishes ${resource.metrics.join(', ')}. The other resource type publishes the rest: ${METRIC_TYPES.filter((type) => !resource.metrics.includes(type)).join(', ')}.`,
    );
  }
  return metricType;
}

// ---------------------------------------------------------------------------
// Downsampling report
// ---------------------------------------------------------------------------

interface SeriesCount {
  readonly name: string;
  readonly points: number;
}

function countSeries(payload: MetricsPayload): SeriesCount[] {
  const series = payload.time_series ?? {};
  return Object.entries(series).map(([name, entry]) => ({
    name,
    points: Array.isArray(entry?.values) ? entry.values.length : 0,
  }));
}

/**
 * States the thinning as a fact, including the resolution the caller is actually
 * looking at.
 *
 * The stride is `ceil(points / maxPoints)` — the seam's own formula, recomputed
 * here rather than inferred from the output count, because the final point is
 * always appended whether or not the stride lands on it and a ratio derived from
 * the kept count would report a spacing that is off by one sample. Reporting the
 * ratio rather than just "downsampled" is what lets a reader tell a 2x thinning
 * from a 300x one.
 */
function downsampleNote(
  before: readonly SeriesCount[],
  after: readonly SeriesCount[],
  step: number | undefined,
  maxPoints: number,
): string | undefined {
  const kept = new Map(after.map((entry) => [entry.name, entry.points]));
  const thinned = before.filter((entry) => (kept.get(entry.name) ?? entry.points) < entry.points);
  if (thinned.length === 0) return undefined;

  const parts = thinned.map((entry) => {
    const stride = Math.ceil(entry.points / maxPoints);
    const resolution =
      step === undefined
        ? ''
        : `, an effective resolution of ${step * stride}s rather than ${step}s`;
    return `${entry.name} ${entry.points} to ${kept.get(entry.name) ?? 0} points (every ${stride}${ordinalSuffix(stride)} sample${resolution})`;
  });

  return (
    `Downsampled to fit the response budget: ${parts.join('; ')}. ` +
    'The kept points are original samples with their original timestamps — the series is thinned by taking every Nth point, not averaged — so a spike present in the source is either present here verbatim or was one of the skipped samples. The first and last points of every series are always kept.'
  );
}

function ordinalSuffix(value: number): string {
  if (value % 100 >= 11 && value % 100 <= 13) return 'th';
  switch (value % 10) {
    case 1:
      return 'st';
    case 2:
      return 'nd';
    case 3:
      return 'rd';
    default:
      return 'th';
  }
}

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

export const getMetricsTool: ToolDef = {
  name: 'get_metrics',
  description:
    'Return a time series for one Hetzner Cloud Server or Load Balancer: CPU, disk and network for a Server; open connections, connections per second, requests per second and bandwidth for a Load Balancer. ' +
    'The window is given as an RFC 3339 start and end, and Hetzner chooses or accepts a step in seconds. ' +
    `A dense window is thousands of points, so the series is thinned to ${DEFAULT_MAX_POINTS} points per series by default — by keeping every Nth original sample rather than by averaging, so peaks are not smoothed away — and meta.hint states when that happened and what the resulting resolution is.`,
  annotations: {
    title: 'Get metrics',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  surface: 'read',
  apiSurfaces: ['cloud'],
  inputSchema: (cfg) => ({
    resource_type: z
      .enum(RESOURCE_TYPES)
      .describe('Which kind of resource the id names. Both are Hetzner Cloud resources.'),
    id: z
      .union([z.number().int().positive(), z.string().regex(/^[1-9][0-9]*$/)])
      .describe('Numeric id of the Server or Load Balancer.'),
    metric_type: z
      .enum(METRIC_TYPES)
      .describe(
        `One metric type per call. A server publishes ${SERVER_METRICS.join(', ')}; a load_balancer publishes ${LOAD_BALANCER_METRICS.join(', ')}. ` +
          'cpu is a single series, disk and network expand into several (read/write, in/out), and Hetzner rejects a type that does not belong to the resource.',
      ),
    start: z
      .string()
      .describe(
        `Start of the window. ${TIME_FORMAT_HINT} Hetzner retains metrics for roughly 30 days, and a start before that returns an empty series rather than an error.`,
      ),
    end: z.string().describe(`End of the window, after start. ${TIME_FORMAT_HINT}`),
    step: z
      .number()
      .int()
      .min(1)
      .max(MAX_STEP_SECONDS)
      .describe(
        'Resolution in seconds. Optional: Hetzner picks one from the width of the window when it is omitted, and may return a coarser step than requested for a wide window. The step in the response is the one that was applied.',
      )
      .optional(),
    max_points: z
      .number()
      .int()
      .min(MIN_MAX_POINTS)
      .max(MAX_MAX_POINTS)
      .describe(
        `Most points to return per series before thinning by stride. Default ${DEFAULT_MAX_POINTS}. A series at or below this is returned whole.`,
      )
      .optional(),
    ...connectionProperty(cfg),
  }),
  handler: async (args, cfg, extra) =>
    runTool(async () => {
      const connection = resolveConnection(args, cfg);
      assertCloud(connection);

      const resourceType = requiredString(args, 'resource_type');
      const resource = RESOURCES.get(resourceType);
      if (resource === undefined) {
        throw new HetznerError(
          `\`resource_type\` "${resourceType}" has no metrics endpoint.`,
          'validation',
          `Available: ${RESOURCE_TYPES.join(', ')}.`,
        );
      }

      const id = requiredId(args, 'id');
      const metricType = readMetricType(args, resourceType);
      const start = readTimestamp(args, 'start');
      const end = readTimestamp(args, 'end');
      if (Date.parse(start) >= Date.parse(end)) {
        throw new HetznerError(
          '`start` is not before `end`.',
          'validation',
          'Hetzner refuses an inverted or empty window; the two bounds name a period, and the series is one point per step within it.',
        );
      }
      const step = optionalNumber(args, 'step');
      const maxPoints = Math.min(
        Math.max(optionalNumber(args, 'max_points') ?? DEFAULT_MAX_POINTS, MIN_MAX_POINTS),
        MAX_MAX_POINTS,
      );

      const response = await request({
        connection,
        method: 'GET',
        path: `/${resource.segment}/${id}/metrics`,
        operationId: resource.operation,
        query: { type: metricType, start, end, step },
        signal: extra.signal,
      });

      const raw = toRecord(response.data)['metrics'];
      if (raw === undefined || raw === null) {
        throw new HetznerError(
          `Hetzner returned no metrics object for ${resourceType} ${id}.`,
          'not_found',
          'A Server that was created after the requested window, or one that has never run, has no series to report.',
        );
      }

      const payload = raw as MetricsPayload;
      const before = countSeries(payload);
      const thinned = downsampleMetrics(payload, maxPoints);
      const after = countSeries(thinned);

      const appliedStep = typeof thinned.step === 'number' ? thinned.step : undefined;
      const totalBefore = before.reduce((sum, entry) => sum + entry.points, 0);
      const totalAfter = after.reduce((sum, entry) => sum + entry.points, 0);

      const notes: string[] = [
        `${metricType} for ${resourceType} ${id} from ${thinned.start ?? start} to ${thinned.end ?? end}` +
          (appliedStep === undefined ? '.' : ` at a ${appliedStep}s step.`),
      ];
      const thinningNote = downsampleNote(before, after, appliedStep, maxPoints);
      if (thinningNote !== undefined) {
        notes.push(thinningNote);
      } else if (totalBefore > 0) {
        notes.push(
          `All ${totalBefore} points across ${before.length} series are included at the step Hetzner applied; nothing was thinned.`,
        );
      } else {
        notes.push(
          'The series is empty. Hetzner returns no points for a window before the resource existed or outside its roughly 30-day retention.',
        );
      }
      if (step !== undefined && appliedStep !== undefined && appliedStep !== step) {
        notes.push(
          `The requested step of ${step}s was not the step applied; Hetzner adjusts the resolution to the width of the window.`,
        );
      }

      const meta: EnvelopeMeta = {
        connection: connection.name,
        surface: connection.surface,
        count: totalAfter,
        total: totalBefore,
        hint: notes.join(' '),
      };

      return renderEnvelope(
        shapeResponse(
          {
            resource_type: resourceType,
            id,
            metric_type: metricType,
            start: thinned.start ?? start,
            end: thinned.end ?? end,
            step: appliedStep,
            downsampled: thinningNote !== undefined,
            time_series: thinned.time_series,
          },
          meta,
        ),
      );
    }),
};
