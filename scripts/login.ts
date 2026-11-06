/**
 * Obtains a user-delegated Backstage token for a synthetic user through the
 * native Backstage OAuth server (Client ID Metadata Documents + PKCE), using
 * the Backstage CLI's built-in client:
 *
 *   yarn demo:login alice            # scripted browser: Dex sign-in + consent
 *   yarn demo:login alice --manual   # print the URL; complete it in your own browser
 *
 * The scripted mode drives a real headless browser through the real Dex login
 * form and the real Backstage consent screen. The password is read from .env
 * and never printed. It is an operator convenience for rehearsals, not a
 * substitute for the live presenter sign-in.
 */
import { spawn } from 'node:child_process';
import { chromium } from '@playwright/test';
import { BACKEND_URL, ROOT, log, requireEnv } from './lib/env';
import { printToken, unverifiedClaims } from './lib/cliAuth';

const USERS = ['alice', 'bob', 'carol', 'mig42-agent'] as const;

async function main() {
  const user = process.argv[2] as (typeof USERS)[number];
  if (!USERS.includes(user)) {
    throw new Error(`Usage: yarn demo:login <${USERS.join('|')}> [--manual]`);
  }
  const manual = process.argv.includes('--manual');

  const cli = spawn(
    'yarn',
    [
      'backstage-cli',
      'auth',
      'login',
      '--backend-url',
      BACKEND_URL,
      '--instance',
      user,
      '--no-browser',
    ],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: true },
  );
  let output = '';
  const authorizeUrl = await new Promise<string>((resolve, reject) => {
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      const m = output.match(/Open this URL to continue: (\S+)/);
      if (m) resolve(m[1]);
    };
    cli.stdout.on('data', onData);
    cli.stderr.on('data', onData);
    cli.on('exit', code => reject(new Error(`CLI exited early (${code}): ${output}`)));
  });
  const done = new Promise<void>((resolve, reject) => {
    cli.removeAllListeners('exit');
    cli.on('exit', code =>
      code === 0 ? resolve() : reject(new Error(`CLI login failed (${code}): ${output}`)),
    );
  });

  if (manual) {
    log(`Open this URL in a browser that can reach ${BACKEND_URL} and sign in as ${user}:`);
    log(authorizeUrl);
  } else {
    const password = requireEnv(`DEMO_${user.toUpperCase().replace(/-/g, '_')}_PASSWORD`);
    const browser = await chromium.launch();
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await page.goto(authorizeUrl);

      // The consent page requires a signed-in Backstage session first.
      const signIn = page.getByRole('button', { name: /sign in/i });
      await signIn.waitFor({ timeout: 30_000 });
      const [popup] = await Promise.all([context.waitForEvent('page'), signIn.click()]);
      await popup.waitForLoadState();
      await popup.locator('input[name="login"]').fill(`${user}@demo.example.com`);
      await popup.locator('input[name="password"]').fill(password);
      await popup.locator('button[type="submit"]').click();
      await popup.waitForEvent('close', { timeout: 30_000 });

      // Native Backstage consent screen for the CLI client.
      const allow = page.getByRole('button', { name: /allow|approve|authorize/i });
      await allow.waitFor({ timeout: 30_000 });
      await allow.click();
      await page.waitForURL(/127\.0\.0\.1|localhost:\d+\/callback/, { timeout: 30_000 }).catch(() => undefined);
    } catch (e) {
      // Debug artifacts for the operator (no secrets are on these pages).
      await page.screenshot({ path: `${ROOT}/.demo/login-failure.png`, fullPage: true }).catch(() => undefined);
      log(`Login automation failed at ${page.url()}; screenshot .demo/login-failure.png`);
      // Kill the whole group (yarn -> backstage-cli) so port 8055 is released.
      try {
        process.kill(-cli.pid!, 'SIGTERM');
      } catch {
        // already exited
      }
      throw e;
    } finally {
      await browser.close();
    }
  }

  await done;
  const claims = unverifiedClaims(await printToken(user));
  log(
    `Signed in as ${String(claims.sub)}; token expires ${new Date(
      Number(claims.exp) * 1000,
    ).toISOString()} (stored by the Backstage CLI, not printed).`,
  );
}

main().catch(e => {
  log(String(e.message ?? e));
  process.exit(1);
});
