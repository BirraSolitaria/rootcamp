import type { Schema } from '@rootcamp/db';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import type { PostgresJsQueryResultHKT } from 'drizzle-orm/postgres-js';

/** A `Db` or a transaction opened on it: services that only run queries accept either. */
export type Executor = PgDatabase<PostgresJsQueryResultHKT, Schema>;
