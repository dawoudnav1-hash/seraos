#!/usr/bin/env node
// End-to-end smoke test against the production build (dist/index.html).
// Usage: npm run build && node e2e/smoke.mjs
// Starts `vite preview` on PORT (default 4173) unless something is already serving there.
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = join(APP_DIR, 'e2e', 'screenshots');
const PORT = Number(process.env.PORT ?? 4173);
const BASE = `http://localhost:${PORT}/`;

let failures = 0;
let passes = 0;
function check(cond, msg) {
  if (cond) {
    passes++;
    console.log(`  ✓ ${msg}`);
  } else {
    failures++;
    console.log(`  ✗ ${msg}`);
  }
}
function step(name) {
  console.log(`\n▸ ${name}`);
}

async function isUp() {
  try {
    const r = await fetch(BASE);
    return r.ok;
  } catch {
    return false;
  }
}

async function startServer() {
  if (await isUp()) {
    console.log(`Using server already running at ${BASE}`);
    return null;
  }
  // Run vite's CLI directly (not via npx) so proc.kill() really stops the server.
  const viteBin = join(APP_DIR, 'node_modules', 'vite', 'bin', 'vite.js');
  const proc = spawn(process.execPath, [viteBin, 'preview', '--port', String(PORT), '--strictPort'], {
    cwd: APP_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });
  let log = '';
  proc.stdout.on('data', (d) => (log += d));
  proc.stderr.on('data', (d) => (log += d));
  for (let i = 0; i < 100; i++) {
    if (await isUp()) {
      console.log(`Started vite preview at ${BASE}`);
      return proc;
    }
    if (proc.exitCode != null) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  proc.kill();
  throw new Error(`vite preview did not start:\n${log}`);
}

const intOf = (s) => {
  const m = String(s ?? '').replace(/[,\s]/g, '').match(/-?\d+/);
  return m ? Number(m[0]) : NaN;
};

async function main() {
  mkdirSync(SHOTS, { recursive: true });
  const server = await startServer();
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const page = await context.newPage();

  const consoleErrors = [];
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const url = msg.location()?.url ?? '';
    // External logo images may fail to load in a sandbox; that is not an app error.
    if (/Failed to load resource/.test(msg.text()) && url && !url.startsWith(BASE)) return;
    consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));

  const kpi = async (id) => (await page.getByTestId(`kpi-${id}-value`).textContent())?.trim();
  const gotoView = async (view) => {
    await page.getByTestId(`nav-${view}`).click();
    await page.waitForFunction((v) => location.hash.startsWith(`#/${v}`), view);
  };
  const messagesSent = async () => intOf(await kpi('messages-sent'));

  try {
    step('Dashboard');
    await page.goto(BASE + '#/dashboard');
    await page.getByTestId('kpi-messages-sent-value').waitFor();
    const ids = ['messages-sent', 'seen', 'replies', 'reply-rate', 'linkedin-connections', 'meetings', 'accounts-touched', 'contacts-reached'];
    for (const id of ids) {
      const v = await kpi(id);
      check(/^\d|^—$/.test(v ?? ''), `KPI "${id}" renders a value (${v})`);
    }
    const sentBefore = await messagesSent();
    check(Number.isFinite(sentBefore), `Messages sent is a number (${sentBefore})`);
    if ((await kpi('seen')) === '0') {
      const hint = await page.getByTestId('kpi-seen').textContent();
      check(/No open-tracking data/.test(hint ?? ''), 'Seen tile shows the no-tracking hint when there is no seen data');
    }
    check((await page.getByTestId('recent-activity').locator('[data-testid=event-line]').count()) > 0, 'Recent activity feed has events');
    check(await page.getByTestId('weekly-chart').locator('svg rect.bar').first().isVisible(), 'Weekly chart renders bars');
    await page.getByTestId('range-7d').click();
    check(Number.isFinite(await messagesSent()), '7d range renders');
    await page.getByTestId('range-all').click();
    check((await messagesSent()) === sentBefore, 'Back to "All" restores the total');
    await page.screenshot({ path: join(SHOTS, 'dashboard.png'), fullPage: true });

    step('Accounts — section tabs vs rendered rows');
    await gotoView('accounts');
    await page.getByTestId('accounts-table').waitFor();
    const expandGroups = page.getByTestId('expand-groups');
    for (const s of ['firm', 'internal', 'solo', 'all']) {
      await page.getByTestId(`section-tab-${s}`).click();
      if (await expandGroups.isEnabled()) await expandGroups.click();
      const expected = intOf(await page.getByTestId(`section-tab-count-${s}`).textContent());
      await page.waitForFunction(
        (n) => document.querySelectorAll('[data-testid=account-row]').length === n,
        expected,
        { timeout: 5000 },
      ).catch(() => {});
      const rendered = await page.getByTestId('account-row').count();
      const resultCount = intOf(await page.getByTestId('result-count').textContent());
      check(rendered === expected && resultCount === expected, `Tab "${s}": tab count ${expected} = rendered rows ${rendered} = result count ${resultCount}`);
    }
    const total = await page.getByTestId('account-row').count();
    const firstGroup = page.getByTestId('group-toggle').first();
    const groupSize = intOf(await firstGroup.locator('.count').textContent());
    await firstGroup.click();
    check((await page.getByTestId('account-row').count()) === total - groupSize, `Collapsing a group hides its ${groupSize} rows`);
    await firstGroup.click();
    check((await page.getByTestId('account-row').count()) === total, 'Expanding the group restores them');

    step('Accounts — CSV export matches visible rows');
    {
      await page.getByTestId('section-tab-all').click();
      if (await expandGroups.isEnabled()) await expandGroups.click();
      const visible = await page.getByTestId('account-row').evaluateAll((rs) => rs.map((r) => r.getAttribute('data-account-id')));
      const [dl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-csv').click()]);
      const { readFile } = await import('node:fs/promises');
      const csv = (await readFile(await dl.path(), 'utf8')).replace(/^\uFEFF/, '');
      const ids = csv.split('\r\n').slice(1).filter(Boolean).map((l) => l.split(',')[0]);
      check(ids.length === visible.length && ids.every((id, i) => id === visible[i]), `CSV has the same ${visible.length} accounts in the same order as the table`);
    }

    step('Accounts — expand an account');
    const accountId = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('[data-testid=account-row]')];
      const withContacts = rows.filter((r) => Number(r.getAttribute('data-contacts')) >= 2);
      return (withContacts[0] ?? rows.find((r) => Number(r.getAttribute('data-contacts')) > 0))?.getAttribute('data-account-id');
    });
    check(!!accountId, `Found an account with contacts (${accountId})`);
    const row = page.locator(`[data-testid=account-row][data-account-id="${accountId}"]`);
    const nContacts = Number(await row.getAttribute('data-contacts'));
    const toggle = row.getByTestId('account-toggle');
    await toggle.focus();
    await page.keyboard.press('Enter');
    const detail = page.locator(`[data-testid=account-detail][data-account-id="${accountId}"]`);
    await detail.waitFor();
    check((await toggle.getAttribute('aria-expanded')) === 'true', 'Keyboard Enter expands the row (aria-expanded=true)');
    const contactRows = detail.getByTestId('contact-row');
    check((await contactRows.count()) === nContacts, `Expanded account shows all ${nContacts} contacts`);
    check(await page.evaluate(() => location.hash).then((h) => h.startsWith('#/accounts/')), 'URL hash reflects the open account');

    step('Log "Email sent" and verify dashboard');
    const firstContact = contactRows.first();
    const contactName = (await firstContact.locator('.name').textContent())?.trim();
    await firstContact.getByTestId('log-email-sent').click();
    await page.locator('.toast').first().waitFor();
    check(/Logged/.test((await page.locator('.toast').first().textContent()) ?? ''), 'Toast confirms the logged event');
    check((await firstContact.locator('.status').textContent())?.trim() !== 'Not contacted', 'Contact status updates immediately');
    await gotoView('dashboard');
    {
      const m = /(\d+) of (\d+) people/.exec((await page.getByTestId('kpi-reply-rate').textContent()) ?? '');
      check(!m || Number(m[1]) <= Number(m[2]), 'Reply rate numerator never exceeds its denominator');
    }
    check((await messagesSent()) === sentBefore + 1, `Messages sent incremented ${sentBefore} → ${sentBefore + 1}`);
    await page.reload();
    await page.getByTestId('kpi-messages-sent-value').waitFor();
    check((await messagesSent()) === sentBefore + 1, 'Increment persists after reload');
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('seraos.manualEvents.v1') ?? '[]'));
    check(Array.isArray(stored) && stored.length === 1 && stored[0].source === 'manual' && stored[0].kind === 'sent', 'localStorage holds exactly one manual "sent" event');

    step('Deep link + delete the manual event');
    await page.goto(BASE + `#/accounts/${encodeURIComponent(accountId)}`);
    await page.reload();
    const detail2 = page.locator(`[data-testid=account-detail][data-account-id="${accountId}"]`);
    await detail2.waitFor();
    check(await detail2.isVisible(), 'Deep link opens the account expanded after reload');
    await page.screenshot({ path: join(SHOTS, 'account-expanded.png') });
    const c1 = detail2.getByTestId('contact-row').first();
    await c1.getByTestId('toggle-history').click();
    const del = detail2.locator('.history-row [data-testid=delete-event]');
    check((await del.count()) === 1, 'Contact history shows a delete button only for the manual event');
    await del.first().click();
    await gotoView('dashboard');
    check((await messagesSent()) === sentBefore, `Messages sent back to ${sentBefore} after delete`);
    check((await page.evaluate(() => localStorage.getItem('seraos.manualEvents.v1'))) === '[]', 'localStorage manual events emptied');

    step('Search for a contact name');
    await gotoView('accounts');
    await page.getByTestId('section-tab-all').click();
    await page.getByTestId('accounts-search').fill(contactName ?? '');
    await page.waitForFunction(
      (id) => {
        const rows = [...document.querySelectorAll('[data-testid=account-row]')];
        return rows.length > 0 && rows.some((r) => r.getAttribute('data-account-id') === id);
      },
      accountId,
      { timeout: 5000 },
    ).catch(() => {});
    const searchRows = await page.getByTestId('account-row').evaluateAll((rs) => rs.map((r) => r.getAttribute('data-account-id')));
    check(searchRows.includes(accountId), `Searching "${contactName}" finds its account (${searchRows.length} result(s))`);
    await page.getByTestId('accounts-search').fill('zzzz-no-such-account-zzzz');
    await page.getByText('No accounts match').waitFor();
    check(true, 'Search with no hits shows an empty state');
    await page.getByTestId('accounts-search').fill('');

    step('Contacts tab');
    await gotoView('contacts');
    await page.getByTestId('contacts-table').waitFor();
    const contactCount = intOf(await page.getByTestId('contacts-count').textContent());
    const listRows = await page.getByTestId('contact-list-row').count();
    check(contactCount > 0 && listRows === Math.min(contactCount, 300), `Contacts list renders (${listRows} rows of ${contactCount})`);
    const target = await page.getByTestId('contact-list-row').first().getAttribute('data-account-id');
    await page.getByTestId('contact-list-row').first().click();
    await page.waitForFunction(() => location.hash.startsWith('#/accounts/'));
    await page.locator(`[data-testid=account-detail][data-account-id="${target}"]`).waitFor();
    check(true, 'Clicking a contact opens its account expanded');

    step('Data / settings');
    await gotoView('settings');
    check(((await page.getByTestId('generated-at').textContent()) ?? '').length > 0, 'Generated-at timestamp shown');

    check(consoleErrors.length === 0, `No console errors${consoleErrors.length ? ':\n    ' + consoleErrors.join('\n    ') : ''}`);
  } catch (err) {
    failures++;
    console.error('\n✗ Smoke test aborted:', err);
    await page.screenshot({ path: join(SHOTS, 'failure.png'), fullPage: true }).catch(() => {});
  } finally {
    await browser.close();
    if (server) server.kill();
  }
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
