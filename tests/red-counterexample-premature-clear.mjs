/**
 * Rerunnable RED counterexample against current app.js (d9ff844 premise).
 * Proves: clearRecovery()-before-await loadTree loses durable ID on refresh
 * during unresolved display load → second POST creates a duplicate.
 *
 * Exit 0 always (observation runner). outcome.premiseFalsified === true means
 * the shared premise failed as expected on this source.
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.APP_ROOT ? path.resolve(process.env.APP_ROOT) : path.resolve(__dirname, '..');
const BASE_URL = process.env.BASE_URL || 'http://localhost:8000';
const OUT_DIR = process.env.OUT_DIR ? path.resolve(process.env.OUT_DIR) : path.dirname(fileURLToPath(import.meta.url));
fs.mkdirSync(OUT_DIR, { recursive: true });

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function seedUser() {
  const email = `red${Date.now()}${Math.floor(Math.random() * 1000)}@test.test`;
  const script = `<?php
require '${ROOT}/vendor/autoload.php';
$app = require '${ROOT}/bootstrap/app.php';
$app->make(Illuminate\\Contracts\\Console\\Kernel::class)->bootstrap();
$u = App\\Models\\User::create(['name'=>'Red','email'=>'${email}','password'=>bcrypt('password')]);
$t = App\\Models\\Tree::create(['owner_user_id'=>$u->id,'title'=>'Red']);
$p = App\\Models\\Person::create(['tree_id'=>$t->id,'name'=>'红证锚点','generation'=>1,'gender'=>'male']);
echo json_encode(['userId'=>$u->id,'treeId'=>$t->id,'token'=>$u->createToken('t')->plainTextToken,'personId'=>$p->id]);
`;
  const tmp = path.join(OUT_DIR, `_seed_${Date.now()}.php`);
  fs.writeFileSync(tmp, script);
  const r = spawnSync('php', [tmp], { cwd: ROOT, encoding: 'utf8' });
  fs.unlinkSync(tmp);
  if (r.status !== 0) throw new Error(r.stderr || r.stdout);
  return { email, ...JSON.parse(r.stdout.trim().split('\n').pop()) };
}

function chromePath() {
  for (const c of ['/usr/bin/google-chrome-stable', '/usr/bin/chromium-browser', '/usr/bin/chromium']) {
    if (fs.existsSync(c)) return c;
  }
  return undefined;
}

async function main() {
  const auth = seedUser();
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: chromePath(),
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  await page.goto(`${BASE_URL}/app/`, { waitUntil: 'networkidle0' });
  await page.evaluate((a) => {
    localStorage.setItem('yimai_token', a.token);
    localStorage.setItem('yimai_user_id', String(a.userId));
    localStorage.setItem('yimai_tree_id', String(a.treeId));
    localStorage.setItem('yimai_root_id', String(a.personId));
  }, auth);
  await page.reload({ waitUntil: 'networkidle0' });
  await page.waitForSelector('g.node-card', { timeout: 10000 });

  // Install delay hook: hang GET tree after person create (does not reject → catch unused).
  await page.evaluate(() => {
    window.__yimaiOrigFetch = window.fetch.bind(window);
    window.__yimaiPostPersonCount = 0;
    window.__yimaiTreeHangMs = 8000;
    window.__yimaiTreeHangArmed = false;
    window.__yimaiTreeHangActive = false;
    window.fetch = async (input, init = {}) => {
      const url = String(input);
      const method = (init.method || 'GET').toUpperCase();
      if (method === 'POST' && /\/api\/v1\/persons\/?$/.test(url.replace(/\?.*$/, ''))) {
        window.__yimaiPostPersonCount += 1;
      }
      if (
        window.__yimaiTreeHangArmed
        && method === 'GET'
        && /\/api\/v1\/persons\/\d+\/tree/.test(url)
      ) {
        window.__yimaiTreeHangArmed = false;
        window.__yimaiTreeHangActive = true;
        await new Promise((r) => setTimeout(r, window.__yimaiTreeHangMs));
        window.__yimaiTreeHangActive = false;
      }
      return window.__yimaiOrigFetch(input, init);
    };
  });

  // Select anchor, open son form, submit with tree hang armed.
  await page.evaluate(() => {
    const card = [...document.querySelectorAll('g.node-card')].find((n) => (n.textContent || '').includes('红证锚点'));
    if (!card) throw new Error('anchor missing');
    card.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await sleep(400);
  await page.click('button[data-kin="son"]');
  await page.waitForSelector('#form-add:not(.hidden)');
  await page.type('#add-name', '红证儿子');
  await page.evaluate(() => { window.__yimaiTreeHangArmed = true; });
  await page.evaluate(() => document.getElementById('form-add').requestSubmit());

  // Poll during unresolved tree request for premature clear.
  let prematureClearObserved = false;
  let recoveryDuringHang = 'unset';
  let hangSeen = false;
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    const snap = await page.evaluate(() => ({
      hang: Boolean(window.__yimaiTreeHangActive),
      recovery: localStorage.getItem('yimai_add_recovery'),
      posts: window.__yimaiPostPersonCount,
    }));
    if (snap.hang) hangSeen = true;
    if (snap.hang && snap.recovery == null) {
      prematureClearObserved = true;
      recoveryDuringHang = null;
      break;
    }
    recoveryDuringHang = snap.recovery;
    await sleep(50);
  }

  const postsBeforeReload = await page.evaluate(() => window.__yimaiPostPersonCount);
  const personsBefore = await page.evaluate(async () => {
    const token = localStorage.getItem('yimai_token');
    const res = await fetch(`${location.origin}/api/v1/persons`, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
    });
    const body = await res.json();
    return (body.data || []).filter((p) => p.name === '红证儿子');
  });

  // Interrupt DURING unresolved await (bypass catch): hard reload.
  await page.reload({ waitUntil: 'networkidle0' });
  await sleep(800);
  const recoveryAfterReload = await page.evaluate(() => localStorage.getItem('yimai_add_recovery'));

  // Re-open form and submit again — without durable pending id this POSTs again.
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
  await page.evaluate(() => {
    const card = [...document.querySelectorAll('g.node-card')].find((n) => (n.textContent || '').includes('红证锚点'));
    if (card) card.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await sleep(400);
  await page.click('button[data-kin="son"]');
  await page.waitForSelector('#form-add:not(.hidden)');
  await page.type('#add-name', '红证儿子');
  await page.evaluate(() => document.getElementById('form-add').requestSubmit());
  await sleep(1500);

  const postsAfterRetry = await page.evaluate(() => window.__yimaiPostPersonCount);
  const personsAfter = await page.evaluate(async () => {
    const token = localStorage.getItem('yimai_token');
    const res = await fetch(`${location.origin}/api/v1/persons`, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
    });
    const body = await res.json();
    return (body.data || []).filter((p) => p.name === '红证儿子').map((p) => p.id);
  });

  const outcome = {
    head: 'd9ff844 (working tree at observation time)',
    premise: 'Keeping recovery in the visible form and restoring it in catch is enough to guarantee one creation.',
    hangSeen,
    prematureClearObserved,
    recoveryDuringHang,
    postsBeforeReload,
    createdIdsBeforeReload: personsBefore.map((p) => p.id),
    recoveryAfterReload,
    postsAfterRetry,
    createdIdsAfterRetry: personsAfter,
    duplicateCreated: personsAfter.length >= 2,
    premiseFalsified: prematureClearObserved && recoveryAfterReload == null && personsAfter.length >= 2 && postsAfterRetry >= 1,
    note: 'Refresh during unresolved loadTree bypasses catch; clearRecovery already ran.',
  };

  fs.writeFileSync(path.join(OUT_DIR, 'counterexample-premature-clear.json'), JSON.stringify(outcome, null, 2));
  const lines = [
    'PREMISE COUNTEREXAMPLE OBSERVATION',
    `hangSeen=${hangSeen}`,
    `prematureClearObserved=${prematureClearObserved}`,
    `recoveryDuringHang=${recoveryDuringHang}`,
    `postsBeforeReload=${postsBeforeReload}`,
    `idsBefore=${JSON.stringify(outcome.createdIdsBeforeReload)}`,
    `recoveryAfterReload=${recoveryAfterReload}`,
    `postsAfterRetry=${postsAfterRetry}`,
    `idsAfter=${JSON.stringify(personsAfter)}`,
    `duplicateCreated=${outcome.duplicateCreated}`,
    `premiseFalsified=${outcome.premiseFalsified}`,
  ];
  fs.writeFileSync(path.join(OUT_DIR, 'counterexample-premature-clear.log'), `${lines.join('\n')}\n`);
  console.log(lines.join('\n'));
  await browser.close();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  fs.writeFileSync(path.join(OUT_DIR, 'counterexample-premature-clear.log'), String(err));
  process.exit(1);
});
