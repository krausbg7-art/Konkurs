// Create or reset an organiser account:
//   node src/cli/create-admin.js <login>
// The password is read from ADMIN_PASSWORD or asked interactively (min 12 chars).
import readline from 'node:readline';
import { loadConfig } from '../config.js';
import { createPool, migrate } from '../db.js';
import { hashPassword } from '../security.js';

const login = process.argv[2];
if (!login) {
  console.error('Usage: node src/cli/create-admin.js <login>');
  process.exit(1);
}

async function ask(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  return new Promise((res) => rl.question(q, (a) => { rl.close(); res(a); }));
}

const password = process.env.ADMIN_PASSWORD || (await ask('Password: '));
if (password.length < 12) {
  console.error('Password must be at least 12 characters');
  process.exit(1);
}

const cfg = loadConfig();
const pool = createPool(cfg.databaseUrl);
await migrate(pool);
await pool.query(
  `insert into admins (login, password_hash) values ($1, $2)
   on conflict (login) do update set password_hash = excluded.password_hash`,
  [login, await hashPassword(password)],
);
console.log(`Admin "${login}" saved`);
await pool.end();
