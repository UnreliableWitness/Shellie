import { z } from 'zod';
import type { BrainHome, BrainHomeInput } from '../../../shared/brainShare';
import { AdoClient } from '../../services/AdoClient';
import {
  normalizeOrganizationUrl,
  TokenUnavailableError,
  type TokenCrypto,
} from '../../services/ConnectionStore';
import { JsonFileStore } from '../../usage/JsonFileStore';

/** The id git sign-in uses for the brain home's token (see createGitAuth). Never a real connection's id. */
export const BRAIN_HOME_CONNECTION_ID = 'brain-home';

const FileSchema = z.object({
  version: z.literal(1),
  home: z
    .object({
      organizationUrl: z.string(),
      project: z.string(),
      user: z.string().nullable(),
      tokenCiphertext: z.string(),
    })
    .nullable(),
});
type File = z.infer<typeof FileSchema>;

/** Checks the token and that the project exists; gives the user and the project as the organization spells it. */
export type VerifyHome = (
  organizationUrl: string,
  pat: string,
  project: string,
) => Promise<{ user: string; project: string }>;

export const verifyWithAdo: VerifyHome = async (
  organizationUrl,
  pat,
  project,
) => {
  const client = new AdoClient(organizationUrl, async () => pat);
  const who = await client.verify(project);
  const found = (await client.projects()).find(
    (p) => p.name.toLowerCase() === project.toLowerCase(),
  );
  if (!found)
    throw new Error(`The project "${project}" is not in that organization`);
  return { user: who.user, project: found.name };
};

/** The company's Azure DevOps organization and project that shared brains live in, with a PAT, per person (`brain-home.json`). */
export class BrainHomeStore {
  private readonly store: JsonFileStore<File>;

  constructor(
    filePath: string,
    private readonly crypto: TokenCrypto,
    private readonly verify: VerifyHome = verifyWithAdo,
  ) {
    this.store = new JsonFileStore(filePath, FileSchema, () => ({
      version: 1,
      home: null,
    }));
  }

  async load(): Promise<{ recovered: boolean; backup?: string }> {
    return this.store.load();
  }

  /** The home without its token; null until one is set. */
  get(): BrainHome | null {
    const h = this.store.value.home;
    return h
      ? { organizationUrl: h.organizationUrl, project: h.project, user: h.user }
      : null;
  }

  /** Verifies the token and the project first; nothing is saved when either fails. */
  async save(input: BrainHomeInput): Promise<BrainHome> {
    const organizationUrl = normalizeOrganizationUrl(input.organizationUrl);
    const project = input.project.trim();
    const pat = input.pat.trim();
    if (!project) throw new Error('Enter the project name');
    if (!pat) throw new Error('Enter a personal access token');
    if (!(await this.crypto.available()))
      throw new TokenUnavailableError(
        'Token encryption is not available on this machine; the home was not saved',
      );
    const checked = await this.verify(organizationUrl, pat, project);
    const tokenCiphertext = (await this.crypto.encrypt(pat)).toString('base64');
    const home = {
      organizationUrl,
      project: checked.project,
      user: checked.user,
      tokenCiphertext,
    };
    await this.store.update((f) => {
      f.home = home;
    });
    return this.get() as BrainHome;
  }

  async token(): Promise<string> {
    const h = this.store.value.home;
    if (!h) throw new Error('No brain home is set');
    try {
      return await this.crypto.decrypt(
        Buffer.from(h.tokenCiphertext, 'base64'),
      );
    } catch {
      throw new TokenUnavailableError(
        'Stored token could not be decrypted; enter it again',
      );
    }
  }

  async remove(): Promise<void> {
    await this.store.update((f) => {
      f.home = null;
    });
  }
}
