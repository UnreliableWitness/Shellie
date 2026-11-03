import {
  BrainsFileSchema,
  type Brain,
  type BrainsFile,
} from '../../shared/brain';
import { JsonFileStore } from '../usage/JsonFileStore';

/** Persists the brains (one local git folder per Azure DevOps project) to brains.json. */
export class BrainStore {
  private readonly store: JsonFileStore<BrainsFile>;

  constructor(filePath: string) {
    this.store = new JsonFileStore(filePath, BrainsFileSchema, () => ({
      brains: [],
    }));
  }

  async load(): Promise<void> {
    await this.store.load();
  }

  list(): Brain[] {
    return this.store.value.brains;
  }

  get(id: string): Brain | undefined {
    return this.list().find((b) => b.id === id);
  }

  forProject(connectionId: string, project: string): Brain[] {
    return this.list().filter(
      (b) => b.connectionId === connectionId && b.project === project,
    );
  }

  async add(b: Brain): Promise<void> {
    await this.store.update((v) => {
      v.brains.push(b);
    });
  }

  async patch(id: string, patch: Partial<Brain>): Promise<Brain> {
    let updated: Brain | undefined;
    await this.store.update((v) => {
      const i = v.brains.findIndex((b) => b.id === id);
      if (i < 0) throw new Error(`Brain ${id} not found`);
      updated = { ...v.brains[i], ...patch, id };
      v.brains[i] = updated;
    });
    return this.get(id) ?? (updated as Brain);
  }

  async remove(id: string): Promise<void> {
    await this.store.update((v) => {
      v.brains = v.brains.filter((b) => b.id !== id);
    });
  }
}
