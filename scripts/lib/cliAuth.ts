import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ROOT } from './env';

const run = promisify(execFile);

/**
 * Returns the current access token for a Backstage CLI instance, refreshing
 * it through Backstage's native OAuth server if needed. The token is only
 * held in memory; callers must never log it.
 */
export async function printToken(instance: string): Promise<string> {
  const { stdout } = await run(
    'yarn',
    ['backstage-cli', 'auth', 'print-token', '--instance', instance],
    { cwd: ROOT, maxBuffer: 1024 * 1024 },
  );
  const token = stdout.trim().split('\n').pop()?.trim() ?? '';
  if (!/^[\w-]+\.[\w-]+\.[\w-]+$/.test(token)) {
    throw new Error(
      `No usable token for CLI instance "${instance}"; run \`yarn demo:login ${instance}\``,
    );
  }
  return token;
}

/** Decodes JWT claims for display (subject/expiry). Never used for authorization. */
export function unverifiedClaims(token: string): Record<string, unknown> {
  const [, payload] = token.split('.');
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
}
