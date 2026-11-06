import { z } from 'zod';

export const TrackerProviderSchema = z.enum(['azure-devops', 'github']);
export type TrackerProvider = z.infer<typeof TrackerProviderSchema>;
