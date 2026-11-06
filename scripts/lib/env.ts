import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

export const ROOT = path.resolve(__dirname, '..', '..');
export const STATE_DIR = path.join(ROOT, '.demo');
export const EVIDENCE_DIR = path.join(ROOT, 'evidence');
export const BACKEND_URL = process.env.DEMO_BACKEND_URL ?? 'http://localhost:7007';

/** Loads .env into a fresh object without printing anything. */
export function loadEnv(): Record<string, string> {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) {
    throw new Error('Missing .env; run `yarn demo:env:init` first');
  }
  return dotenv.parse(fs.readFileSync(file));
}

export function requireEnv(name: string): string {
  const value = process.env[name] ?? loadEnv()[name];
  if (!value) {
    throw new Error(`${name} is not set (see .env.example)`);
  }
  return value;
}

export function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

export function writeJson(file: string, value: unknown) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function log(message: string) {
  process.stdout.write(`${message}\n`);
}
