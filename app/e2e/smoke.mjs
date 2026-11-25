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
  const countOf = async (testId) => intOf(await page.getByTestId(testId).textContent());
  const toggleCounts = async (prefix) => ({
    all: await countOf(`${prefix}-count-all`),
    nc: await countOf(`${prefix}-count-not_contacted`),
    c: await countOf(`${prefix}-count-contacted`),
  });
  /** Waits until `selector` matches exactly n elements (or times out quietly — the check that follows reports it). */
  const waitForCount = (selector, n) =>
    page.waitForFunction(([sel, k]) => document.querySelectorAll(sel).length === k, [selector, n], { timeout: 5000 }).catch(() => {});
  /** Waits until every rendered `cellSel` carries data-city=city (i.e. a city filter has been applied). */
  const waitForCity = (cellSel, city) =>
    page
      .waitForFunction(
        ([sel, c]) => {
          const cells = [...document.querySelectorAll(sel)];
          return cells.length > 0 && cells.every((e) => e.getAttribute('data-city') === c);
        },
        [cellSel, city],
        { timeout: 5000 },
      )
      .catch(() => {});
  const waitForText = (testId, n) =>
    page
      .waitForFunction(([id, k]) => (document.querySelector(`[data-testid="${id}"]`)?.textContent ?? '').replace(/[,\s]/g, '').startsWith(String(k)), [testId, n], {
        timeout: 5000,
      })
      .catch(() => {});

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
    for (const s of ['firm', 'services', 'internal', 'solo', 'all']) {
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

    step('Accounts — Not contacted / Contacted toggle');
    {
      for (const s of ['all', 'firm']) {
        await page.getByTestId(`section-tab-${s}`).click();
        const t = await toggleCounts('contacted');
        const tab = await countOf(`section-tab-count-${s}`);
        check(t.nc + t.c === t.all && t.all === tab, `Tab "${s}": Not contacted ${t.nc} + Contacted ${t.c} = All ${t.all} = tab count ${tab}`);
      }
      await page.getByTestId('section-tab-all').click();
      const t = await toggleCounts('contacted');
      for (const [id, n, wantContacted] of [
        ['not_contacted', t.nc, false],
        ['contacted', t.c, true],
      ]) {
        await page.getByTestId(`contacted-${id}`).click();
        if (await expandGroups.isEnabled()) await expandGroups.click();
        await waitForCount('[data-testid=account-row]', n);
        const rendered = await page.getByTestId('account-row').count();
        check(rendered === n && (await countOf('result-count')) === n, `"${id}": control count ${n} = rendered rows ${rendered}`);
        const pills = await page.locator('[data-testid=account-row] .pill.status').allTextContents();
        check(pills.length === n && pills.every((p) => (p.trim() === 'Not contacted') !== wantContacted), `"${id}": every row's Outreach pill agrees`);
        const tabCount = await countOf('section-tab-count-all');
        check(tabCount === n, `"${id}": the All tab count follows the toggle (${tabCount})`);
      }
      await page.getByTestId('contacted-all').click();
      await waitForCount('[data-testid=account-row]', t.all);
      check((await page.getByTestId('account-row').count()) === t.all, 'Back to "All" restores every row');
    }

    step('Accounts — City filter vs dashboard By city');
    {
      await page.getByTestId('section-tab-all').click();
      const citySelect = page.getByTestId('filter-city');
      const topCity = await citySelect.evaluate((el) => [...el.options].find((o) => o.value)?.value);
      check(!!topCity, `City filter lists cities, top one: ${topCity}`);
      await citySelect.selectOption(topCity);
      await waitForCity('[data-testid=account-row] [data-testid=city-cell]', topCity);
      if (await expandGroups.isEnabled()) await expandGroups.click();
      const n = await countOf('section-tab-count-all');
      await waitForCount('[data-testid=account-row]', n);
      const cities = await page.locator('[data-testid=account-row] [data-testid=city-cell]').evaluateAll((els) => els.map((e) => e.getAttribute('data-city')));
      check(cities.length === n && n > 0 && cities.every((c) => c === topCity), `All ${n} rendered rows show ${topCity} (${cities.length} city cells)`);
      const t = await toggleCounts('contacted');
      check(t.nc + t.c === t.all && t.all === n, `${topCity}: Not contacted ${t.nc} + Contacted ${t.c} = ${n}`);
      await page.screenshot({ path: join(SHOTS, 'accounts-city.png'), clip: { x: 0, y: 0, width: 1440, height: 420 } });

      await gotoView('dashboard');
      const row = page.locator(`[data-testid=by-city-row][data-city="${topCity}"]`);
      await row.waitFor();
      const dashAccounts = intOf(await row.getByTestId('by-city-accounts').textContent());
      const dashNc = intOf(await row.getByTestId('by-city-not-contacted').textContent());
      check(dashAccounts === n, `Dashboard By-city "${topCity}" accounts ${dashAccounts} = Accounts view ${n}`);
      check(dashNc === t.nc, `Dashboard By-city "${topCity}" not contacted ${dashNc} = Accounts toggle ${t.nc}`);
      {
        const totals = await page.getByTestId('by-city-table').evaluate((table) => {
          const col = (sel) => [...table.querySelectorAll(`[data-testid=by-city-row] [data-testid=${sel}]`)].reduce((s, td) => s + Number(td.textContent.replace(/\D/g, '')), 0);
          const tot = (sel) => Number(table.querySelector(`[data-testid=by-city-total] [data-testid=${sel}]`).textContent.replace(/\D/g, ''));
          return { rows: col('by-city-accounts'), total: tot('by-city-accounts'), ncRows: col('by-city-not-contacted'), ncTotal: tot('by-city-not-contacted') };
        });
        check(totals.rows === totals.total && totals.ncRows === totals.ncTotal, `By-city rows add up to the Total (${totals.rows} accounts, ${totals.ncRows} not contacted)`);
      }
      await page.getByTestId('by-city').screenshot({ path: join(SHOTS, 'dashboard-by-city.png') });

      // Clear the filter on Accounts, then come back through the dashboard link: it must re-apply the city on the All tab.
      await gotoView('accounts');
      await page.getByTestId('filter-city').selectOption('');
      await page.getByTestId('section-tab-firm').click();
      await gotoView('dashboard');
      await page.locator(`[data-testid=by-city-row][data-city="${topCity}"]`).click();
      await page.waitForFunction(() => location.hash.startsWith('#/accounts'));
      await page.getByTestId('accounts-table').waitFor();
      await waitForText('result-count', n);
      check(
        (await page.getByTestId('filter-city').inputValue()) === topCity &&
          (await page.getByTestId('section-tab-all').getAttribute('aria-selected')) === 'true' &&
          (await countOf('result-count')) === n,
        `Clicking "${topCity}" on the dashboard opens Accounts › All filtered to it (${n})`,
      );
      await page.getByTestId('filter-city').selectOption('');
    }

    step('Accounts — log "Email sent" on a not-contacted contact');
    {
      await page.getByTestId('section-tab-all').click();
      await page.getByTestId('contacted-not_contacted').click();
      if (await expandGroups.isEnabled()) await expandGroups.click();
      const before = await toggleCounts('contacted');
      const target = await page.evaluate(
        () => [...document.querySelectorAll('[data-testid=account-row]')].find((r) => Number(r.getAttribute('data-contacts')) > 0)?.getAttribute('data-account-id'),
      );
      check(!!target, `Found a not-contacted account with contacts (${target})`);
      const trow = page.locator(`[data-testid=account-row][data-account-id="${target}"]`);
      await trow.getByTestId('account-toggle').click();
      const tdetail = page.locator(`[data-testid=account-detail][data-account-id="${target}"]`);
      await tdetail.waitFor();
      const tc = tdetail.getByTestId('contact-row').first();
      check((await tc.locator('.pill.status').textContent())?.trim() === 'Not contacted', 'Its first contact starts as Not contacted');
      await tc.getByTestId('log-email-sent').click();
      await waitForText('contacted-count-not_contacted', before.nc - 1);
      const after = await toggleCounts('contacted');
      check(after.nc === before.nc - 1 && after.c === before.c + 1 && after.all === before.all, `Not contacted ${before.nc} → ${after.nc}, Contacted ${before.c} → ${after.c}`);
      check((await tc.locator('.pill.status').textContent())?.trim() === 'Contacted', 'The contact now shows Contacted');
      check(await trow.isVisible(), 'The open account stays on screen while you work on it');
      check((await trow.locator('.badge-moved').textContent())?.trim() === 'Now contacted', 'and is marked "Now contacted"');
      await tc.getByTestId('toggle-history').click();
      await tdetail.locator('.history-row [data-testid=delete-event]').first().click();
      await waitForText('contacted-count-not_contacted', before.nc);
      const restored = await toggleCounts('contacted');
      check(restored.nc === before.nc && restored.c === before.c, `Deleting the manual event restores ${before.nc} / ${before.c}`);
      check((await page.evaluate(() => localStorage.getItem('seraos.manualEvents.v1'))) === '[]', 'No manual events left behind');
      await trow.getByTestId('account-toggle').click();
      await page.getByTestId('contacted-all').click();
    }

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

    step('Contacts — Not contacted / Contacted toggle and City filter');
    {
      await gotoView('contacts');
      await page.getByTestId('contacts-table').waitFor();
      await page.getByTestId('contact-section-tab-all').click();
      const t = await toggleCounts('contact-contacted');
      check(t.nc + t.c === t.all && t.all === (await countOf('contacts-count')), `Contacts: Not contacted ${t.nc} + Contacted ${t.c} = All ${t.all}`);
      for (const [id, n] of [
        ['not_contacted', t.nc],
        ['contacted', t.c],
      ]) {
        await page.getByTestId(`contact-contacted-${id}`).click();
        await waitForText('contacts-count', n);
        const rendered = await page.getByTestId('contact-list-row').count();
        check((await countOf('contacts-count')) === n && rendered === Math.min(n, 300), `Contacts "${id}": count ${n}, rendered ${rendered}`);
      }
      await page.getByTestId('contact-contacted-all').click();
      const citySelect = page.getByTestId('contacts-filter-city');
      const topCity = await citySelect.evaluate((el) => [...el.options].find((o) => o.value)?.value);
      await citySelect.selectOption(topCity);
      await waitForCity('[data-testid=contact-list-row] [data-testid=contact-city-cell]', topCity);
      const n = await countOf('contact-section-tab-count-all');
      await waitForText('contacts-count', n);
      const cities = await page.locator('[data-testid=contact-list-row] [data-testid=contact-city-cell]').evaluateAll((els) => els.map((e) => e.getAttribute('data-city')));
      check(cities.length === Math.min(n, 300) && cities.every((c) => c === topCity), `Contacts in ${topCity}: all ${cities.length} rendered rows show it`);
      const tc = await toggleCounts('contact-contacted');
      check(tc.nc + tc.c === tc.all && tc.all === n, `Contacts in ${topCity}: ${tc.nc} + ${tc.c} = ${n}`);
      await citySelect.selectOption('');
    }

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
