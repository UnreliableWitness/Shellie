import { StateSchema, type State } from '../../shared/types';
import { JsonFileStore } from '../usage/JsonFileStore';

export type LoadResult = { recovered: boolean; backup?: string };

const emptyState = (): State => ({
  version: 1,
  repos: [],
  tasks: [],
  discardedCleanup: [],
});

/** Persists repos and tasks to one JSON file. Writes are atomic (temp file, then rename) and serialised. */
export class TaskStore {
  private readonly store: JsonFileStore<State>;

  constructor(filePath: string) {
    this.store = new JsonFileStore(filePath, StateSchema, emptyState);
  }

  get state(): State {
    return this.store.value;
  }

  load(): Promise<LoadResult> {
    return this.store.load();
  }

  update(mutate: (s: State) => void): Promise<State> {
    return this.store.update((s) => {
      mutate(s);
    });
  }
}
