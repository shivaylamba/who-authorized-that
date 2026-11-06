/**
 * Generates .env with random local secrets and bcrypt hashes for the synthetic
 * Dex users. Refuses to overwrite an existing .env unless --force is given,
 * because rotating DEMO_* passwords invalidates nothing in Backstage but does
 * require restarting Dex.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { ROOT, log } from './lib/env';

const file = path.join(ROOT, '.env');
if (fs.existsSync(file) && !process.argv.includes('--force')) {
  log('.env already exists; leaving it untouched (use --force to regenerate).');
  process.exit(0);
}

const rand = (bytes = 24) => crypto.randomBytes(bytes).toString('base64url');
const password = () => rand(12);

const alice = password();
const bob = password();
const carol = password();
const agent = password();

const lines = [
  `POSTGRES_PASSWORD=${rand()}`,
  `AUTH_SESSION_SECRET=${rand(32)}`,
  `DEX_BACKSTAGE_CLIENT_SECRET=${rand()}`,
  `DEMO_ALICE_PASSWORD=${alice}`,
  `DEMO_ALICE_PASSWORD_HASH='${bcrypt.hashSync(alice, 10)}'`,
  `DEMO_BOB_PASSWORD=${bob}`,
  `DEMO_BOB_PASSWORD_HASH='${bcrypt.hashSync(bob, 10)}'`,
  `DEMO_CAROL_PASSWORD=${carol}`,
  `DEMO_CAROL_PASSWORD_HASH='${bcrypt.hashSync(carol, 10)}'`,
  `DEMO_MIG42_AGENT_PASSWORD=${agent}`,
  `DEMO_MIG42_AGENT_PASSWORD_HASH='${bcrypt.hashSync(agent, 10)}'`,
  `DEMO_OPERATOR_TOKEN=${rand(32)}`,
  `DEMO_EXECUTOR_TOKEN=${rand(32)}`,
  `DEMO_PROBE_SERVICE_TOKEN=${rand(32)}`,
];
fs.writeFileSync(file, `${lines.join('\n')}\n`, { mode: 0o600 });
log('Wrote .env with fresh local secrets (values not printed).');
