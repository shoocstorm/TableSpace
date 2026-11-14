// Every database the switcher offers. To add one: write a SchemaDef file
// beside these and add it to SCHEMAS. Nothing else needs to change.

import { ecommerce } from './ecommerce';
import { saas } from './saas';
import type { SchemaDef } from './types';

export const SCHEMAS: SchemaDef[] = [ecommerce, saas];
export const DEFAULT_SCHEMA = ecommerce.id;
export const schemaById = (id: string | null | undefined): SchemaDef => SCHEMAS.find((s) => s.id === id) ?? ecommerce;
