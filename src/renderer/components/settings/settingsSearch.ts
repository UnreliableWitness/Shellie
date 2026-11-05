import {
  createContext,
  createElement,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from 'react';

type Entry = { scope: string; texts: string[]; category: string };

export type SettingsSearch = {
  query: string;
  /** True when every search term is a case-insensitive substring of the texts. */
  matches(text: string[]): boolean;
  /** Registers a row; returns the function that removes it again. */
  register(
    id: string,
    scope: string,
    texts: string[],
    category?: string,
  ): () => void;
  /** How many registered rows of `scope` match the query. */
  countIn(scope: string): number;
  /** How many registered rows of a category match the query, and how many exist. */
  categoryCount(category: string): { matching: number; total: number };
};

export function matchesQuery(query: string, texts: string[]): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const hay = texts.join(' ').toLowerCase();
  return terms.every((t) => hay.includes(t));
}

const fallback: SettingsSearch = {
  query: '',
  matches: () => true,
  register: () => () => {},
  countIn: () => 0,
  categoryCount: () => ({ matching: 0, total: 0 }),
};

const Ctx = createContext<SettingsSearch>(fallback);

export function SettingsSearchProvider({
  query,
  children,
}: {
  query: string;
  children: ReactNode;
}) {
  const entries = useRef(new Map<string, Entry>());
  const [version, setVersion] = useState(0);

  const register = useCallback<SettingsSearch['register']>(
    (id, scope, texts, category = '') => {
      entries.current.set(id, { scope, texts, category });
      setVersion((v) => v + 1);
      return () => {
        entries.current.delete(id);
        setVersion((v) => v + 1);
      };
    },
    [],
  );

  const value = useMemo<SettingsSearch>(() => {
    void version;
    return {
      query,
      matches: (text) => matchesQuery(query, text),
      register,
      countIn: (scope) =>
        [...entries.current.values()].filter(
          (e) => e.scope === scope && matchesQuery(query, e.texts),
        ).length,
      categoryCount: (category) => {
        const mine = [...entries.current.values()].filter(
          (e) => e.category === category,
        );
        return {
          matching: mine.filter((e) => matchesQuery(query, e.texts)).length,
          total: mine.length,
        };
      },
    };
  }, [query, register, version]);

  return createElement(Ctx.Provider, { value }, children);
}

export function useSettingsSearch(): SettingsSearch {
  return useContext(Ctx);
}
