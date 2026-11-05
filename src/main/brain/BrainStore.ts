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

  /** The live brains of a project: an archived one is not any task's brain. */
  forProject(connectionId: string, project: string): Brain[] {
    return this.list().filter(
      (b) =>
        b.connectionId === connectionId && b.project === project && !b.archived,
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

  /** Archives every live brain of a connection (its project was removed); returns how many changed. */
  async archiveByConnection(connectionId: string): Promise<number> {
    let count = 0;
    await this.store.update((v) => {
      for (const b of v.brains)
        if (b.connectionId === connectionId && !b.archived) {
          b.archived = true;
          count++;
        }
    });
    return count;
  }

  async remove(id: string): Promise<void> {
    await this.store.update((v) => {
      v.brains = v.brains.filter((b) => b.id !== id);
    });
  }
}
