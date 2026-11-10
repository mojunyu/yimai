/**
 * Real-login empty-account counterexample (no injectAuth / no manual treeId).
 * Observe create_inflight/uncertain recovery across lost POST + F5.
 *
 * OUT_DIR for artifacts. Exit 0 always (observation). Check outcome.bugObserved.
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.APP_ROOT ? path.resolve(process.env.APP_ROOT) : path.resolve(__dirname, '..');
const BASE_URL = process.env.BASE_URL || 'http://localhost:8000';
const OUT_DIR = process.env.OUT_DIR
  ? path.resolve(process.env.OUT_DIR)
  : path.resolve('/opt/cursor/artifacts/run-20261110-empty-treeid/red');
fs.mkdirSync(OUT_DIR, { recursive: true });

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function chromePath() {
  for (const c of ['/usr/bin/google-chrome-stable', '/usr/bin/chromium-browser', '/usr/bin/chromium']) {
    if (fs.existsSync(c)) return c;
  }
  return undefined;
}

function createFreshUser() {
  const email = `empty${Date.now()}${Math.floor(Math.random() * 1000)}@test.test`;
  const script = `<?php
require '${ROOT}/vendor/autoload.php';
$app = require '${ROOT}/bootstrap/app.php';
$app->make(Illuminate\\Contracts\\Console\\Kernel::class)->bootstrap();
$u = App\\Models\\User::create(['name'=>'Empty','email'=>'${email}','password'=>bcrypt('password')]);
// Intentionally NO Tree row / NO Person — empty account.
echo json_encode(['userId'=>$u->id,'email'=>'${email}'], JSON_UNESCAPED_UNICODE);
`;
  const tmp = path.join(OUT_DIR, `_seed_${Date.now()}.php`);
  fs.writeFileSync(tmp, script);
  const r = spawnSync('php', [tmp], { cwd: ROOT, encoding: 'utf8' });
  fs.unlinkSync(tmp);
  if (r.status !== 0) throw new Error(r.stderr || r.stdout);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

function redact(obj) {
  const s = JSON.stringify(obj);
  return JSON.parse(s.replace(/Bearer [A-Za-z0-9_|.-]+/g, 'Bearer [REDACTED]')
    .replace(/"token"\s*:\s*"[^"]+"/g, '"token":"[REDACTED]"')
    .replace(/\d+\|[A-Za-z0-9]+/g, '[REDACTED_TOKEN]'));
}

async function main() {
  const user = createFreshUser();
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: chromePath(),
    protocolTimeout: 180000,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  page.setDefaultTimeout(60000);
  const trace = [];
  page.on('console', (msg) => {
    if (String(msg.text()).includes('__TRACE__')) {
      try { trace.push(JSON.parse(String(msg.text()).replace(/^.*?__TRACE__/, ''))); } catch (_) { /* ignore */ }
    }
  });

  await page.goto(`${BASE_URL}/app/`, { waitUntil: 'networkidle0' });
  // Fully clear storage — no leftover treeId/token.
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  await page.reload({ waitUntil: 'networkidle0' });

  // REAL login UI — no injectAuth.
  await page.$eval('#email', (el, email) => { el.value = email; }, user.email);
  await page.$eval('#password', (el) => { el.value = 'password'; });
  await page.evaluate(() => document.getElementById('btn-login').click());
  await page.waitForFunction(() => {
    const add = document.getElementById('btn-add');
    const stats = document.getElementById('stats')?.textContent || '';
    return add && !add.disabled && (stats.includes('没有记下') || stats.includes('位亲人'));
  }, { timeout: 20000 });
  await sleep(500);

  const afterLogin = await page.evaluate(() => ({
    tokenPresent: Boolean(localStorage.getItem('yimai_token')),
    userId: localStorage.getItem('yimai_user_id'),
    treeId: localStorage.getItem('yimai_tree_id'),
    rootId: localStorage.getItem('yimai_root_id'),
    recovery: localStorage.getItem('yimai_add_recovery'),
    personCountDom: document.querySelectorAll('g.node-card').length,
  }));

  // Install hooks: count POSTs; lose response AFTER commit on next person POST.
  await page.evaluate(() => {
    window.__yimaiOrigFetch = window.fetch.bind(window);
    window.__yimaiPostPersonCount = 0;
    window.__yimaiLoseNext = true;
    window.__trace = [];
    window.fetch = async (input, init = {}) => {
      const url = String(input);
      const method = (init.method || 'GET').toUpperCase();
      const entry = { t: Date.now(), method, url: url.replace(/Bearer[^&]*/g, ''), status: null };
      if (method === 'POST' && /\/api\/v1\/persons\/?$/.test(url.replace(/\?.*$/, ''))) {
        window.__yimaiPostPersonCount += 1;
        entry.kind = 'POST_PERSON';
        entry.postN = window.__yimaiPostPersonCount;
        if (window.__yimaiLoseNext) {
          window.__yimaiLoseNext = false;
          const res = await window.__yimaiOrigFetch(input, init);
          entry.status = res.status;
          entry.committed = res.ok;
          let bodyText = '';
          try { bodyText = await res.clone().text(); } catch (_) { /* ignore */ }
          entry.bodyPreview = bodyText.slice(0, 120).replace(/\d+\|[A-Za-z0-9]+/g, '[REDACTED]');
          window.__trace.push(entry);
          console.log('__TRACE__' + JSON.stringify(entry));
          throw new TypeError('Failed to fetch (simulated lost create response after commit)');
        }
      }
      const res = await window.__yimaiOrigFetch(input, init);
      entry.status = res.status;
      if (/\/api\/v1\/(persons|trees)/.test(url)) {
        window.__trace.push(entry);
        console.log('__TRACE__' + JSON.stringify(entry));
      }
      return res;
    };
  });

  // First person via real UI.
  await page.evaluate(() => document.getElementById('btn-add').click());
  await page.waitForSelector('#form-add:not(.hidden)', { timeout: 10000 });
  await page.$eval('#add-name', (el) => { el.value = '空账第一人'; });
  const beforeSubmit = await page.evaluate(() => ({
    treeId: localStorage.getItem('yimai_tree_id'),
    recovery: localStorage.getItem('yimai_add_recovery'),
  }));
  await page.evaluate(() => document.getElementById('form-add').requestSubmit());
  await sleep(1500);

  const afterLost = await page.evaluate(() => ({
    treeId: localStorage.getItem('yimai_tree_id'),
    recovery: localStorage.getItem('yimai_add_recovery'),
    posts: window.__yimaiPostPersonCount,
    err: document.getElementById('add-error')?.textContent || '',
    trace: window.__trace || [],
  }));

  // F5 before user reconciles.
  await page.reload({ waitUntil: 'networkidle0' });
  await sleep(900);

  const afterRefresh = await page.evaluate(() => ({
    tokenPresent: Boolean(localStorage.getItem('yimai_token')),
    userId: localStorage.getItem('yimai_user_id'),
    treeId: localStorage.getItem('yimai_tree_id'),
    recovery: localStorage.getItem('yimai_add_recovery'),
    nodes: document.querySelectorAll('g.node-card').length,
  }));

  // Re-install counter (reload cleared hooks) and retry first person via UI.
  await page.evaluate(() => {
    window.__yimaiOrigFetch = window.fetch.bind(window);
    window.__yimaiPostPersonCount = 0;
    window.fetch = async (input, init = {}) => {
      const url = String(input);
      const method = (init.method || 'GET').toUpperCase();
      if (method === 'POST' && /\/api\/v1\/persons\/?$/.test(url.replace(/\?.*$/, ''))) {
        window.__yimaiPostPersonCount += 1;
      }
      return window.__yimaiOrigFetch(input, init);
    };
  });

  // If recovery was dropped, UI may show empty add again.
  const addDisabled = await page.$eval('#btn-add', (el) => el.disabled).catch(() => true);
  if (!addDisabled) {
    await page.evaluate(() => document.getElementById('btn-add').click());
    await page.waitForSelector('#form-add:not(.hidden)', { timeout: 10000 }).catch(() => null);
  }
  const formOpen = await page.$eval('#form-add', (el) => !el.classList.contains('hidden')).catch(() => false);
  if (formOpen) {
    await page.$eval('#add-name', (el) => { el.value = '空账第一人'; });
    // If uncertain select appears, do NOT choose — blind submit to observe duplicate risk.
    await page.evaluate(() => {
      const form = document.getElementById('form-add');
      if (form && !form.classList.contains('hidden')) form.requestSubmit();
    });
    await sleep(1500);
  }

  const postsAfterRetry = await page.evaluate(() => window.__yimaiPostPersonCount);
  const server = await page.evaluate(async () => {
    const token = localStorage.getItem('yimai_token');
    const res = await fetch(`${location.origin}/api/v1/persons`, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
    });
    const body = await res.json();
    const named = (body.data || []).filter((p) => p.name === '空账第一人');
    return {
      total: (body.data || []).length,
      namedIds: named.map((p) => p.id),
      treeIds: [...new Set((body.data || []).map((p) => p.tree_id))],
    };
  });

  const recoveryAfterLost = afterLost.recovery ? JSON.parse(afterLost.recovery) : null;
  const recoveryAfterRefresh = afterRefresh.recovery ? JSON.parse(afterRefresh.recovery) : null;

  const outcome = {
    headNote: 'observation against working tree / 1e7bd22 lineage',
    userId: user.userId,
    email: user.email,
    afterLogin,
    beforeSubmit,
    afterLost: {
      ...afterLost,
      recoveryParsed: recoveryAfterLost,
    },
    afterRefresh: {
      ...afterRefresh,
      recoveryParsed: recoveryAfterRefresh,
    },
    postsAfterRetry,
    server,
    recoveryDroppedOnRefresh: Boolean(recoveryAfterLost) && !recoveryAfterRefresh,
    duplicateCreated: server.namedIds.length >= 2,
    bugObserved: Boolean(
      afterLogin.treeId == null
      && recoveryAfterLost
      && (!recoveryAfterLost.treeId || recoveryAfterLost.treeId === '')
      && (!recoveryAfterRefresh || server.namedIds.length >= 2),
    ),
    note: 'Fresh empty login → no treeId; create_inflight may persist empty treeId; strict scope drop on F5 can allow blind re-POST.',
  };

  fs.writeFileSync(path.join(OUT_DIR, 'empty-account-lost-create.json'), JSON.stringify(redact(outcome), null, 2));
  fs.writeFileSync(path.join(OUT_DIR, 'empty-account-trace.json'), JSON.stringify(redact({
    consoleTrace: trace,
    inPageTrace: afterLost.trace,
  }), null, 2));
  const lines = [
    'EMPTY-ACCOUNT REAL-LOGIN OBSERVATION',
    `afterLogin.treeId=${afterLogin.treeId}`,
    `afterLost.recovery.treeId=${recoveryAfterLost?.treeId ?? 'null'}`,
    `afterLost.phase=${recoveryAfterLost?.phase}`,
    `recoveryDroppedOnRefresh=${outcome.recoveryDroppedOnRefresh}`,
    `postsAfterRetry=${postsAfterRetry}`,
    `namedIds=${JSON.stringify(server.namedIds)}`,
    `duplicateCreated=${outcome.duplicateCreated}`,
    `bugObserved=${outcome.bugObserved}`,
  ];
  fs.writeFileSync(path.join(OUT_DIR, 'empty-account-lost-create.log'), `${lines.join('\n')}\n`);
  console.log(lines.join('\n'));
  await browser.close();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  fs.writeFileSync(path.join(OUT_DIR, 'empty-account-lost-create.log'), String(err));
  process.exit(1);
});
