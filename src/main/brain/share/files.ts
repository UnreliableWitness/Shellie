import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { z } from 'zod';
import {
  MembersSchema,
  OriginSchema,
  SHARED_FIELDS,
  SharedFactsSchema,
  type Members,
  type Origin,
  type SharedFacts,
} from '../../../shared/brainShare';
import { readTextIfExists, writeAtomic } from '../../fsRetry';
import { parseJsonOrNull } from './gitUtil';

const fileOf = (dir: string, name: string) => path.join(dir, 'brain', name);

async function read<T>(
  dir: string,
  name: string,
  schema: z.ZodType<T>,
): Promise<T | null> {
  // Only a missing file reads as null; a corrupt one must throw, not be overwritten.
  const text = await readTextIfExists(fileOf(dir, name));
  return text === null ? null : schema.parse(JSON.parse(text));
}

async function write(dir: string, name: string, value: unknown): Promise<void> {
  await mkdir(path.join(dir, 'brain'), { recursive: true });
  await writeAtomic(
    fileOf(dir, name),
    `${JSON.stringify(value, null, 2)}\n`,
    `.${process.pid}.tmp`,
  );
}

export const readOrigin = (dir: string): Promise<Origin | null> =>
  read(dir, 'origin.json', OriginSchema);

/** An origin.json text as an Origin; null when it is not JSON or not an origin. */
export function parseOrigin(text: string): Origin | null {
  const r = OriginSchema.safeParse(parseJsonOrNull(text));
  return r.success ? r.data : null;
}

export const writeOrigin = (dir: string, o: Origin): Promise<void> =>
  write(dir, 'origin.json', OriginSchema.parse(o));

export const readMembers = (dir: string): Promise<Members | null> =>
  read(dir, 'members.json', MembersSchema);

/** Adds the member, or replaces the one with the same install id. */
export async function upsertMember(
  dir: string,
  m: Members['members'][number],
): Promise<void> {
  const cur = (await readMembers(dir)) ?? { format: 1 as const, members: [] };
  const members = cur.members.some((x) => x.installId === m.installId)
    ? cur.members.map((x) => (x.installId === m.installId ? m : x))
    : [...cur.members, m];
  await write(dir, 'members.json', MembersSchema.parse({ ...cur, members }));
}

export async function removeMember(
  dir: string,
  installId: string,
): Promise<void> {
  const cur = await readMembers(dir);
  if (!cur) return;
  await write(dir, 'members.json', {
    ...cur,
    members: cur.members.filter((x) => x.installId !== installId),
  });
}

export const readShared = (dir: string): Promise<SharedFacts | null> =>
  read(dir, 'shared.json', SharedFactsSchema);

/** Merges the given fields into brain/shared.json and stamps `updatedAt` for exactly those fields. */
export async function writeShared(
  dir: string,
  patch: Partial<Omit<SharedFacts, 'format' | 'updatedAt'>>,
  now: Date,
): Promise<void> {
  const epoch = new Date(0).toISOString();
  const cur: SharedFacts = (await readShared(dir)) ?? {
    format: 1,
    wiki: null,
    lastRefreshAt: null,
    lastDigestAt: null,
    templatesVersion: 0,
    updatedAt: Object.fromEntries(
      SHARED_FIELDS.map((k) => [k, epoch]),
    ) as SharedFacts['updatedAt'],
  };
  const stamp = now.toISOString();
  const next: SharedFacts = { ...cur, updatedAt: { ...cur.updatedAt } };
  for (const key of Object.keys(patch) as (keyof typeof patch)[]) {
    if (patch[key] === undefined) continue;
    Object.assign(next, { [key]: patch[key] });
    next.updatedAt[key] = stamp;
  }
  await write(dir, 'shared.json', SharedFactsSchema.parse(next));
}
