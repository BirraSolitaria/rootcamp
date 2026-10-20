import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres, { type Sql } from 'postgres';
import * as schema from './schema/index.js';

export type Schema = typeof schema;
/** Drizzle instance over porsager `postgres` with the full rootcamp schema. */
export type Db = PostgresJsDatabase<Schema> & { $client: Sql };

export interface DbHandle {
  db: Db;
  sql: Sql;
  close(): Promise<void>;
}

export interface CreateDbOptions {
  /** Pool size. `runMigrations` needs at least 2 (one connection holds the advisory lock). */
  max?: number;
}

export function createDb(url: string, opts: CreateDbOptions = {}): DbHandle {
  const sql = postgres(url, {
    max: opts.max ?? 10,
    // `CREATE EXTENSION IF NOT EXISTS` and friends emit NOTICEs; they are not actionable.
    onnotice: () => {},
  });
  const db = drizzle(sql, { schema });
  return { db, sql, close: () => sql.end({ timeout: 5 }) };
}
