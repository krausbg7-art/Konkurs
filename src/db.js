import pg from 'pg';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// bigint ids come back as strings by default; they fit in a JS number here.
pg.types.setTypeParser(20, (v) => Number(v));
// numeric (video duration)
pg.types.setTypeParser(1700, (v) => Number(v));

export function createPool(url) {
  return new pg.Pool({ connectionString: url, max: 10 });
}

export async function tx(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

export async function migrate(pool, log = () => {}) {
  await pool.query('create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())');
  const done = new Set((await pool.query('select name from schema_migrations')).rows.map((r) => r.name));
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    if (done.has(file)) continue;
    const sql = await readFile(path.join(migrationsDir, file), 'utf8');
    await tx(pool, async (c) => {
      await c.query(sql);
      await c.query('insert into schema_migrations (name) values ($1)', [file]);
    });
    log(`migration applied: ${file}`);
  }
}

export async function getSetting(pool, key, def = null) {
  const r = await pool.query('select value from settings where key = $1', [key]);
  return r.rows.length ? r.rows[0].value : def;
}

export async function setSetting(db, key, value) {
  await db.query(
    'insert into settings (key, value) values ($1, $2) on conflict (key) do update set value = excluded.value',
    [key, JSON.stringify(value)],
  );
}

export async function adminLog(db, adminId, action, targetType, targetId, details = null) {
  await db.query(
    'insert into admin_log (admin_id, action, target_type, target_id, details) values ($1, $2, $3, $4, $5)',
    [adminId, action, targetType, targetId, details ? JSON.stringify(details) : null],
  );
}
