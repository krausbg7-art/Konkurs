import { loadConfig } from './config.js';
import { createPool, migrate } from './db.js';
import { buildApp } from './app.js';

const cfg = loadConfig();
const pool = createPool(cfg.databaseUrl);
await migrate(pool, (m) => console.log(m));

const app = await buildApp({ cfg, pool });

// Drop expired sessions once an hour.
setInterval(() => pool.query('delete from sessions where expires_at < now()').catch(() => {}), 3600e3).unref();

const close = async () => { await app.close(); await pool.end(); process.exit(0); };
process.on('SIGTERM', close);
process.on('SIGINT', close);

await app.listen({ port: cfg.port, host: cfg.host });
