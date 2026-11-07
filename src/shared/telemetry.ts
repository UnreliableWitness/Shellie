import { z } from 'zod';

/** Small, non-identifying properties. Values are short strings, numbers or booleans; main scrubs every string again. */
export type TelemetryProps = Record<string, string | number | boolean>;

const name = z
  .string()
  .regex(/^[a-zA-Z][\w.:-]{0,63}$/, 'telemetry names are short identifiers');
const props = z
  .record(
    z.string().regex(/^[a-zA-Z][\w.]{0,39}$/),
    z.union([z.string().max(200), z.number(), z.boolean()]),
  )
  .refine((p) => Object.keys(p).length <= 20, 'at most 20 properties')
  .optional();
const measurements = z
  .record(z.string().regex(/^[a-zA-Z][\w.]{0,39}$/), z.number().finite())
  .refine((m) => Object.keys(m).length <= 20, 'at most 20 measurements')
  .optional();

/** What the renderer may send over the one-way `telemetry` channel. Main validates it before anything is queued. */
export const RendererTelemetrySchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('event'), name, props, measurements }),
  z.object({ type: z.literal('pageView'), name, props }),
  z.object({
    type: z.literal('exception'),
    errorType: z.string().max(80),
    message: z.string().max(2000),
    stack: z.string().max(8000).optional(),
    props,
  }),
]);
export type RendererTelemetry = z.infer<typeof RendererTelemetrySchema>;

export const TELEMETRY_CHANNEL = 'shellie-telemetry';
