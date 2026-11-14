// Every database the switcher offers: the built-in mock schemas, and the
// ones imported from DDL, which are kept in this browser (localStorage) as
// their DDL text and read again at launch.
//
// To add a built-in: write a SchemaDef file beside these and add it to BUILT_IN.

import { create } from 'zustand';
import { parseDdl } from './ddl';
import { ecommerce } from './ecommerce';
import { saas } from './saas';
import type { SchemaDef } from './types';

export const BUILT_IN: SchemaDef[] = [ecommerce, saas];
/** The built-in schemas (tests run over these). */
export const SCHEMAS = BUILT_IN;
export const DEFAULT_SCHEMA = ecommerce.id;

type Saved = { id: string; name: string; ddl: string };
const KEY = 'tablespace.imported';

function load(): { saved: Saved[]; schemas: SchemaDef[] } {
  let saved: Saved[] = [];
  try {
    saved = JSON.parse((typeof localStorage === 'undefined' ? null : localStorage.getItem(KEY)) ?? '[]') as Saved[];
  } catch {
    // unreadable storage: start without imports
  }
  const schemas: SchemaDef[] = [];
  saved = saved.filter((s) => {
    const r = typeof s?.ddl === 'string' ? parseDdl(s.ddl, s.name, s.id) : null;
    if (r?.ok) schemas.push(r.schema);
    return !!r?.ok;
  });
  return { saved, schemas };
}

export const useRegistry = create<{ saved: Saved[]; imported: SchemaDef[] }>(() => {
  const { saved, schemas } = load();
  return { saved, imported: schemas };
});

const persist = (saved: Saved[]) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(saved));
  } catch {
    // storage full or blocked: the import still works for this visit
  }
};

export const allSchemas = (): SchemaDef[] => [...BUILT_IN, ...useRegistry.getState().imported];
export const schemaById = (id: string | null | undefined): SchemaDef => allSchemas().find((s) => s.id === id) ?? ecommerce;
export const isImported = (id: string) => useRegistry.getState().imported.some((s) => s.id === id);

/** Adds (or replaces, by name) an imported schema and remembers its DDL. */
export function saveImported(schema: SchemaDef, ddl: string): void {
  const { saved, imported } = useRegistry.getState();
  const next = { saved: [...saved.filter((s) => s.id !== schema.id), { id: schema.id, name: schema.name, ddl }], imported: [...imported.filter((s) => s.id !== schema.id), schema] };
  useRegistry.setState(next);
  persist(next.saved);
}

export function removeImported(id: string): void {
  const { saved, imported } = useRegistry.getState();
  const next = { saved: saved.filter((s) => s.id !== id), imported: imported.filter((s) => s.id !== id) };
  useRegistry.setState(next);
  persist(next.saved);
}
