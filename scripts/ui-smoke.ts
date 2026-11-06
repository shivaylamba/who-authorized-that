/**
 * Frontend smoke test in a real browser: signs in through Dex as Alice, checks
 * the presenter page renders backend-derived state, and exercises the native
 * Catalog "Unregister entity" control to record what it actually does for
 * Alice. Screenshots are local verification artifacts (evidence/screenshots).
 *
 *   tsx scripts/ui-smoke.ts [--skip-native-unregister]
 */
import path from 'node:path';
import { Page, chromium } from '@playwright/test';
import { BACKEND_URL, EVIDENCE_DIR, ensureDir, log, requireEnv, writeJson } from './lib/env';
import { getHealth, getSnapshot } from './lib/operator';

const shots = path.join(EVIDENCE_DIR, 'screenshots');

async function signIn(page: Page, user: string) {
  await page.goto(`${BACKEND_URL}/identity-boundary-demo`);
  const signInButton = page.getByRole('button', { name: /sign in/i });
  await signInButton.waitFor({ timeout: 30_000 });
  const [popup] = await Promise.all([page.context().waitForEvent('page'), signInButton.click()]);
  await popup.locator('input[name="login"]').fill(`${user}@demo.example.com`);
  await popup.locator('input[name="password"]').fill(requireEnv(`DEMO_${user.toUpperCase()}_PASSWORD`));
  await popup.locator('button[type="submit"]').click();
  await popup.waitForEvent('close', { timeout: 30_000 });
}

async function main() {
  ensureDir(shots);
  const health = await getHealth();
  const mode: string = health.mode;
  const results: Record<string, string> = {};
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 } })).newPage();
  try {
    await signIn(page, 'alice');
    await page.goto(`${BACKEND_URL}/identity-boundary-demo-details`);
    const banner = mode === 'gated' ? 'GATED PROFILE' : 'INTENTIONALLY UNSAFE CUSTOM INTEGRATION';
    await page.getByText(banner).waitFor({ timeout: 30_000 });
    results.banner = banner;
    await page.getByText('user:default/alice').first().waitFor();
    results.caller = 'user:default/alice shown as verified caller';
    await page.getByText('PRESENT in catalog').first().waitFor({ timeout: 15_000 });
    results.catalogState = `${await page.getByText('PRESENT in catalog').count()} target cards PRESENT`;
    await page.getByText('UNTRUSTED ISSUE CONTENT', { exact: false }).waitFor();
    await page.getByText('Migration follow-up: payments-api').waitFor();
    results.issue = 'issue + untrusted presenter badge rendered';
    await page.getByText('Agent delegation (act 3', { exact: false }).waitFor();
    results.delegationPanel = 'agent delegation panel rendered';
    await page.getByText('Run comparison (stored evidence)').waitFor();
    results.comparison = (await page.locator('table').last().innerText()).replace(/\s+/g, ' ').slice(0, 400);
    await page.screenshot({ path: path.join(shots, `${mode}-presenter.png`), fullPage: true });

    // Manual action path through the same protected service (checkout-v2 is denied in gated).
    if (mode === 'gated') {
      const card = page
        .locator('div.MuiCard-root')
        .filter({ has: page.getByRole('heading', { name: 'checkout-v2', exact: true }) });
      await card.getByRole('button', { name: /retire \(manual\)/i }).click();
      await page.getByText(/Manual action result: checkout-v2: NotAllowedError/).waitFor({ timeout: 30_000 });
      results.manualDenied = 'manual Retire on checkout-v2 -> NotAllowedError (backend authoritative)';
      await page.getByText('Resource permission: DENY').first().waitFor({ timeout: 10_000 });
      results.timeline = 'timeline shows backend DENY event';
      await page.screenshot({ path: path.join(shots, `${mode}-presenter-after-manual.png`), fullPage: true });
    }

    // Native Catalog UI unregister control, exercised as Alice.
    if (!process.argv.includes('--skip-native-unregister')) {
      await page.goto(`${BACKEND_URL}/catalog/default/component/payments-api`);
      await page.getByText('payments-api').first().waitFor({ timeout: 30_000 });
      await page.getByRole('button', { name: /more/i }).first().click();
      const item = page.getByRole('menuitem', { name: /unregister entity/i });
      const visible = await item.isVisible().catch(() => false);
      const disabled = visible && (await item.getAttribute('aria-disabled')) === 'true';
      await page.screenshot({ path: path.join(shots, `${mode}-native-unregister-menu.png`) });
      if (!visible) {
        results.nativeUnregister = 'menu item not offered to Alice';
      } else if (disabled) {
        await page.keyboard.press('Escape');
        const snap = await getSnapshot();
        const stillPresent = snap.entities.find(e => e.entityRef === 'component:default/payments-api')?.present;
        results.nativeUnregister = `"Unregister entity" menu item is shown but disabled for Alice (catalog frontend permission check; backend REST also returns 403, see e2e); payments-api ${stillPresent ? 'still present' : 'REMOVED'}`;
      } else {
        await item.click();
        const dialog = page.getByRole('dialog');
        await dialog.waitFor({ timeout: 15_000 });
        await page.waitForTimeout(1500);
        await page.screenshot({ path: path.join(shots, `${mode}-native-unregister-dialog.png`) });
        const buttons = await dialog.getByRole('button').allInnerTexts();
        const confirm = dialog.getByRole('button', { name: /^unregister/i }).first();
        await confirm.click();
        await page.waitForTimeout(3000);
        await page.screenshot({ path: path.join(shots, `${mode}-native-unregister-result.png`) });
        const body = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
        const err = body.match(/(Unable to|Failed|Error|not allowed|Forbidden)[^.]{0,160}/i)?.[0];
        const snap = await getSnapshot();
        const stillPresent = snap.entities.find(e => e.entityRef === 'component:default/payments-api')?.present;
        results.nativeUnregisterDialogButtons = buttons.join(' | ');
        results.nativeUnregister = `dialog offered; after confirming: ${err ?? 'no error text found'}; payments-api ${stillPresent ? 'still present' : 'REMOVED'}`;
      }
    }
  } catch (e) {
    await page.screenshot({ path: path.join(shots, `${mode}-failure.png`), fullPage: true }).catch(() => undefined);
    throw e;
  } finally {
    await browser.close();
  }
  writeJson(path.join(EVIDENCE_DIR, `ui-smoke-${mode}.json`), { mode, ranAt: new Date().toISOString(), results });
  for (const [k, v] of Object.entries(results)) log(`PASS ${k}: ${v}`);
}

main().catch(e => {
  log(`FAIL ${String(e.message ?? e)}`);
  process.exit(1);
});
