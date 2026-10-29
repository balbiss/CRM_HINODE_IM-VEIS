import 'dotenv/config';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from './schema.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL não configurada (veja server/.env)');

// DB_POOL_MAX só pra teste local com banco embutido (PGlite aceita poucas conexões); produção usa o padrão 10.
export const sql = postgres(connectionString, { max: Number(process.env.DB_POOL_MAX) || 10 });
export const db = drizzle(sql, { schema });
