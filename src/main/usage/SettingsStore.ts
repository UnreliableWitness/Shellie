import {
  dreamingOf,
  type DreamingAll,
  type DreamingSettings,
} from '../../shared/dreams';
import {
  AppSettingsSchema,
  defaultSettings,
  type AppSettings,
} from '../../shared/usage';
import { JsonFileStore } from './JsonFileStore';

/**
 * The app settings. `dreaming` is written only through `updateDreaming` (the `dream:*` handlers and the dream
 * scheduler): `save` and `update` keep the stored block as it is when their write runs, whatever they were given, so
 * no other writer (the renderer's settings save, a stale whole object, a boot migration) can switch dreaming on,
 * widen it, or undo a switch-off that landed first.
 */
export class SettingsStore {
  private readonly store: JsonFileStore<AppSettings>;
  constructor(file: string) {
    this.store = new JsonFileStore(file, AppSettingsSchema, defaultSettings);
  }
  load() {
    return this.store.load();
  }
  get(): AppSettings {
    return this.store.value;
  }
  /** Every setting but `dreaming`, which stays as stored. */
  save(next: AppSettings): Promise<AppSettings> {
    return this.update(() => next);
  }
  /** Like `save`, from the settings as they are when the write runs (after every queued write). */
  update(fn: (current: AppSettings) => AppSettings): Promise<AppSettings> {
    return this.store.update((cur) => {
      // Taken before `fn` runs: a caller that changes the draft in place cannot get past this.
      const dreaming = structuredClone(cur.dreaming);
      return { ...fn(cur), dreaming };
    });
  }
  /** The one way to change `dreaming`, from the blocks as they are when the write runs; every other setting stays. */
  updateDreaming(
    fn: (current: DreamingAll) => DreamingAll,
  ): Promise<AppSettings> {
    return this.store.update((cur) => ({ ...cur, dreaming: fn(cur.dreaming) }));
  }
  /** `updateDreaming` for one project's block (a project without one starts from the defaults). */
  updateDreamingOf(
    connectionId: string,
    fn: (current: DreamingSettings) => DreamingSettings,
  ): Promise<AppSettings> {
    return this.updateDreaming((all) => ({
      ...all,
      projects: {
        ...all.projects,
        [connectionId]: fn(dreamingOf(all, connectionId)),
      },
    }));
  }
}
