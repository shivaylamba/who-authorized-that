/**
 * Browser test of the three-scenario dashboard: signs in as Alice, presses
 * Reset and Run all, and checks each card's outcome (deterministic replay).
 *
 *   tsx scripts/dashboard-smoke.ts
 */
import path from 'node:path';
import { chromium } from '@playwright/test';
import { BACKEND_URL, EVIDENCE_DIR, ensureDir, log, requireEnv } from './lib/env';

// Per chapter: the delete requests the agent makes (in order) -> result shown.
const EXPECT: Record<string, Record<string, string>> = {
  '1': { 'unregister checkout-preview': 'Retired', 'unregister payments-api': 'Unregistered' },
  '2': { 'unregister checkout-preview': 'Retired', 'unregister payments-api': 'Blocked' },
  '3': {
    'unregister checkout-preview': 'Retired',
    'unregister legacy-checkout-worker': 'Blocked',
    'unregister payments-api': 'Blocked',
  },
};

async function main() {
  const shots = path.join(EVIDENCE_DIR, 'screenshots');
  ensureDir(shots);
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  let failed = 0;
  try {
    await page.goto(`${BACKEND_URL}/identity-boundary-demo`);
    const signIn = page.getByRole('button', { name: /sign in/i });
    await signIn.waitFor({ timeout: 30_000 });
    const [popup] = await Promise.all([page.context().waitForEvent('page'), signIn.click()]);
    await popup.locator('input[name="login"]').fill('alice@demo.example.com');
    await popup.locator('input[name="password"]').fill(requireEnv('DEMO_ALICE_PASSWORD'));
    await popup.locator('button[type="submit"]').click();
    await popup.waitForEvent('close', { timeout: 30_000 });

    await page.getByRole('heading', { name: 'Who authorized that?' }).waitFor({ timeout: 30_000 });
    await page.screenshot({ path: path.join(shots, 'dashboard-start.png') });
    await page.getByRole('button', { name: 'Reset' }).click();
    await page.waitForTimeout(4000);
    const titles: Record<string, string> = { '1': 'The gap', '2': 'The fix', '3': "Agent's own identity" };
    for (const id of ['1', '2', '3']) {
      await page.getByRole('button', { name: new RegExp(`${id} · ${titles[id]}`) }).click();
      const run = page.getByRole('button', { name: `Run scenario ${id}` });
      await run.click();
      await page.getByText('Agent is working').waitFor({ timeout: 10_000 }).catch(() => undefined);
      await run.and(page.locator(':enabled')).waitFor({ timeout: 240_000 });
      await page.waitForTimeout(1500);
      await page.screenshot({ path: path.join(shots, `dashboard-scenario-${id}.png`) });
      const text = await page.locator('.MuiPaper-outlined').nth(1).innerText();
      const lines = text.split('\n').map(l => l.trim());
      for (const [req, want] of Object.entries(EXPECT[id])) {
        const at = lines.indexOf(req);
        const tail = lines.slice(at + 1, at + 4).join(' ');
        const ok = at >= 0 && tail.includes(want);
        if (!ok) failed++;
        log(`${ok ? 'PASS' : 'FAIL'} scenario ${id} ${req}: want ${want}, saw "${tail}"`);
      }
      log(`  lesson: ${lines[lines.length - 1]}`);
    }
    // Tab 4: what Backstage gives you today, read from the findings run.
    await page.getByRole('button', { name: /4 · Backstage today/ }).click();
    await page.getByText('What Backstage gives you today').waitFor({ timeout: 15_000 });
    await page.waitForTimeout(1000);
    await page.screenshot({ path: path.join(shots, 'dashboard-backstage-today.png') });
    const facts = (await page.locator('.MuiPaper-outlined').first().innerText()).split('\n').map(l => l.trim());
    const want: Record<string, string> = {
      'Short-lived tokens': '✓',
      'Scoped tokens': '✗',
      'Token exchange (RFC 8693)': '✗',
      'Permission framework': '✓',
    };
    for (const [title, mark] of Object.entries(want)) {
      const at = facts.indexOf(title);
      const ok = at > 0 && facts[at - 1] === mark;
      if (!ok) failed++;
      log(`${ok ? 'PASS' : 'FAIL'} Backstage today: ${title} ${mark} (saw "${facts[at - 1]}")`);
    }
  } finally {
    await browser.close();
  }
  log(failed ? `${failed} check(s) failed` : 'Dashboard smoke: all checks passed');
  if (failed) process.exitCode = 1;
}

main().catch(e => {
  log(String(e.stack ?? e));
  process.exit(1);
});
