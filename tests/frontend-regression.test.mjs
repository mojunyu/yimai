/**
 * Frontend regression tests for 一脉 (Yimai) family tree app.
 *
 * Covers: login/loadTree restoration, empty-tree first person (incl. stale rootId),
 * kin add, partial-save persistence, retry without duplicate POST, parent-slot
 * conflict protection, double-submit guard.
 *
 * Prerequisites — see tests/README.md
 * Run: BASE_URL=http://localhost:8000 npm run test:frontend
 */

import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = process.env.APP_ROOT
  ? path.resolve(process.env.APP_ROOT)
  : path.resolve(__dirname, '..');
const BASE_URL = process.env.BASE_URL || 'http://localhost:8000';
const DEMO_EMAIL = 'demo@yimai.test';
const DEMO_PASSWORD = 'password';
const ARTIFACTS_DIR = process.env.ARTIFACTS_DIR
  ? path.resolve(process.env.ARTIFACTS_DIR)
  : path.resolve(APP_ROOT, 'artifacts');

/** Must match results logged by the ordered suite. Aborting early fails. */
const EXPECTED_TEST_COUNT = 35;

let browser;
let page;
const results = [];
let fatalError = null;
const startedAt = new Date();

function log(test, passed, message = '') {
  const status = passed ? '✓ PASS' : '✗ FAIL';
  console.log(`${status}: ${test}${message ? ' - ' + message : ''}`);
  results.push({ test, passed, message, at: new Date().toISOString() });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function resolveChromePath() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH;
  const candidates = [
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

function phpCreateUser({ withPerson = false, personName = '无父母者', gender = 'male' } = {}) {
  const email = `iso${Date.now()}${Math.floor(Math.random() * 1000)}@test.test`;
  const script = withPerson
    ? `<?php
require '${APP_ROOT}/vendor/autoload.php';
$app = require '${APP_ROOT}/bootstrap/app.php';
$app->make(Illuminate\\Contracts\\Console\\Kernel::class)->bootstrap();
$u = App\\Models\\User::create(['name'=>'Iso','email'=>'${email}','password'=>bcrypt('password')]);
$t = App\\Models\\Tree::create(['owner_user_id'=>$u->id,'title'=>'Iso']);
$p = App\\Models\\Person::create(['tree_id'=>$t->id,'name'=>'${personName}','generation'=>1,'gender'=>'${gender}']);
echo json_encode(['userId'=>$u->id,'treeId'=>$t->id,'token'=>$u->createToken('test')->plainTextToken,'personId'=>$p->id], JSON_UNESCAPED_UNICODE);
`
    : `<?php
require '${APP_ROOT}/vendor/autoload.php';
$app = require '${APP_ROOT}/bootstrap/app.php';
$app->make(Illuminate\\Contracts\\Console\\Kernel::class)->bootstrap();
$u = App\\Models\\User::create(['name'=>'Iso','email'=>'${email}','password'=>bcrypt('password')]);
$t = App\\Models\\Tree::create(['owner_user_id'=>$u->id,'title'=>'Iso']);
echo json_encode(['userId'=>$u->id,'treeId'=>$t->id,'token'=>$u->createToken('test')->plainTextToken,'personId'=>null], JSON_UNESCAPED_UNICODE);
`;
  const tmp = path.join(ARTIFACTS_DIR, `_tmp_seed_${Date.now()}.php`);
  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
  fs.writeFileSync(tmp, script);
  const result = spawnSync('php', [tmp], { cwd: APP_ROOT, encoding: 'utf8' });
  fs.unlinkSync(tmp);
  if (result.status !== 0) {
    throw new Error(`seed failed: ${result.stdout || ''}${result.stderr || ''}`);
  }
  const line = (result.stdout || '').trim().split('\n').filter(Boolean).pop();
  const parsed = JSON.parse(line);
  return {
    email,
    userId: String(parsed.userId),
    treeId: String(parsed.treeId),
    token: parsed.token,
    personId: parsed.personId != null ? String(parsed.personId) : null,
  };
}

async function injectAuth({ token, userId, treeId, rootId = null }) {
  await page.evaluate((auth) => {
    localStorage.setItem('yimai_token', auth.token);
    localStorage.setItem('yimai_user_id', String(auth.userId));
    if (auth.treeId) localStorage.setItem('yimai_tree_id', String(auth.treeId));
    if (auth.rootId) localStorage.setItem('yimai_root_id', String(auth.rootId));
    else localStorage.removeItem('yimai_root_id');
  }, { token, userId, treeId, rootId });
}

async function setup() {
  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
  const executablePath = resolveChromePath();
  const launchOpts = {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
  };
  if (executablePath) launchOpts.executablePath = executablePath;
  browser = await puppeteer.launch(launchOpts);
  page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.log('  Browser error:', msg.text());
  });
  page.on('pageerror', (err) => console.log('  Page error:', err.message));
}

async function teardown() {
  if (browser) await browser.close();
}

async function freshPage() {
  await page.goto(`${BASE_URL}/app/`, { waitUntil: 'networkidle0' });
  await page.evaluate(() => {
    localStorage.removeItem('yimai_token');
    localStorage.removeItem('yimai_root_id');
  });
  await page.reload({ waitUntil: 'networkidle0' });
}

async function loginAsDemo() {
  await freshPage();
  const emailValue = await page.$eval('#email', (el) => el.value);
  const passwordValue = await page.$eval('#password', (el) => el.value);
  if (emailValue !== DEMO_EMAIL || passwordValue !== DEMO_PASSWORD) {
    await page.$eval('#email', (el) => { el.value = ''; });
    await page.$eval('#password', (el) => { el.value = ''; });
    await page.type('#email', DEMO_EMAIL);
    await page.type('#password', DEMO_PASSWORD);
  }
  let jsError = null;
  page.once('pageerror', (err) => { jsError = err.message; });
  try {
    await Promise.all([
      page.click('#btn-login'),
      page.waitForFunction(() => {
        const stats = document.getElementById('stats');
        return stats && stats.textContent.includes('位亲人');
      }, { timeout: 10000 }),
    ]);
  } catch (err) {
    if (jsError?.includes('login is not defined')) {
      return { ok: false, reason: 'login function not defined - REGRESSION' };
    }
    if (jsError?.includes('loadTree is not defined')) {
      return { ok: false, reason: 'loadTree function not defined - REGRESSION' };
    }
    throw err;
  }
  return { ok: true };
}

async function waitForNodes(min = 1) {
  await page.waitForFunction(
    (n) => document.querySelectorAll('g.node-card').length >= n,
    { timeout: 10000 },
    min,
  );
}

async function selectNodeByName(name) {
  await page.evaluate((target) => {
    const cards = Array.from(document.querySelectorAll('g.node-card'));
    const match = cards.find((c) => (c.querySelector('.person-name')?.textContent || '') === target);
    if (!match) throw new Error(`node ${target} not found`);
    match.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  }, name);
  await page.waitForSelector('#sheet:not(.hidden)', { timeout: 5000 });
}

async function addKin(kinKey, name, { parentRole = '' } = {}) {
  await page.click(`button[data-kin="${kinKey}"]`);
  await page.waitForSelector('#form-add:not(.hidden)', { timeout: 5000 });
  if (parentRole) {
    await page.waitForSelector('#add-parent-role-wrap:not(.hidden)', { timeout: 3000 });
    await page.select('#add-parent-role', parentRole);
  }
  await page.$eval('#add-name', (el) => { el.value = ''; });
  await page.type('#add-name', name);
  await page.click('#form-add button[type="submit"]');
}

async function personCountViaApi() {
  return page.evaluate(async () => {
    const token = localStorage.getItem('yimai_token');
    const res = await fetch(`${window.location.origin}/api/v1/persons`, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
    });
    const body = await res.json();
    return (body.data || []).length;
  });
}

async function personsViaApi() {
  return page.evaluate(async () => {
    const token = localStorage.getItem('yimai_token');
    const res = await fetch(`${window.location.origin}/api/v1/persons`, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
    });
    const body = await res.json();
    return body.data || [];
  });
}

async function personByNameViaApi(name) {
  const list = await personsViaApi();
  return list.find((p) => p.name === name) || null;
}

async function installFetchHooks() {
  await page.evaluate(() => {
    if (window.__yimaiOrigFetch) return;
    window.__yimaiOrigFetch = window.fetch.bind(window);
    window.__yimaiFailNextBind = false;
    window.__yimaiFailNextPersonsGet = false;
    window.__yimaiFailNextTreeGet = false;
    window.__yimaiDelayTreeMs = 0;
    window.__yimaiTreeDelayArmed = false;
    window.__yimaiTreeDelayActive = false;
    window.__yimaiLoseNextPersonPostResponse = false;
    window.__yimaiFailPersonPostBeforeCommit = false;
    window.__yimaiNextPersonPost422 = false;
    window.__yimaiNextPersonPost422Msg = '';
    window.__yimaiFailNextPersonGetId = null;
    window.__yimaiPostPersonCount = 0;
    window.fetch = async (input, init = {}) => {
      const url = String(input);
      const method = (init.method || 'GET').toUpperCase();
      if (method === 'POST' && /\/api\/v1\/persons\/?$/.test(url.replace(/\?.*$/, ''))) {
        window.__yimaiPostPersonCount += 1;
        if (window.__yimaiFailPersonPostBeforeCommit) {
          window.__yimaiFailPersonPostBeforeCommit = false;
          throw new TypeError('Failed to fetch (simulated network fail before commit)');
        }
        if (window.__yimaiNextPersonPost422) {
          window.__yimaiNextPersonPost422 = false;
          const msg = window.__yimaiNextPersonPost422Msg || 'forced create validation failure';
          return new Response(JSON.stringify({ message: msg }), {
            status: 422,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (window.__yimaiLoseNextPersonPostResponse) {
          window.__yimaiLoseNextPersonPostResponse = false;
          // Backend commits; client never receives the body (unknown outcome).
          await window.__yimaiOrigFetch(input, init);
          throw new TypeError('Failed to fetch (simulated lost create response)');
        }
      }
      if (
        window.__yimaiFailNextBind
        && method === 'PATCH'
        && /\/api\/v1\/persons\/\d+$/.test(url)
      ) {
        window.__yimaiFailNextBind = false;
        return new Response(
          JSON.stringify({ message: 'forced bind failure for regression test' }),
          { status: 422, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (
        window.__yimaiFailNextPersonsGet
        && method === 'GET'
        && /\/api\/v1\/persons\/?$/.test(url.replace(/\?.*$/, ''))
      ) {
        window.__yimaiFailNextPersonsGet = false;
        return new Response(JSON.stringify({ message: 'forced persons load failure' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (
        window.__yimaiFailNextPersonGetId
        && method === 'GET'
        && new RegExp(`/api/v1/persons/${window.__yimaiFailNextPersonGetId}$`).test(url.replace(/\?.*$/, ''))
      ) {
        window.__yimaiFailNextPersonGetId = null;
        return new Response(JSON.stringify({ message: 'forced person read failure' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (
        method === 'GET'
        && /\/api\/v1\/persons\/\d+\/tree/.test(url)
      ) {
        if (window.__yimaiTreeDelayArmed && window.__yimaiDelayTreeMs > 0) {
          window.__yimaiTreeDelayArmed = false;
          window.__yimaiTreeDelayActive = true;
          await new Promise((r) => setTimeout(r, window.__yimaiDelayTreeMs));
          window.__yimaiTreeDelayActive = false;
        }
        if (window.__yimaiFailNextTreeGet) {
          window.__yimaiFailNextTreeGet = false;
          return new Response(JSON.stringify({ message: 'forced tree load failure' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
          });
        }
      }
      return window.__yimaiOrigFetch(input, init);
    };
  });
}

async function armBindFail() {
  await page.evaluate(() => { window.__yimaiFailNextBind = true; });
}

async function armTreeLoadFail() {
  await page.evaluate(() => { window.__yimaiFailNextTreeGet = true; });
}

async function armTreeLoadDelay(ms = 8000) {
  await page.evaluate((delay) => {
    window.__yimaiDelayTreeMs = delay;
    window.__yimaiTreeDelayArmed = true;
  }, ms);
}

async function armLoseNextPersonPostResponse() {
  await page.evaluate(() => { window.__yimaiLoseNextPersonPostResponse = true; });
}

async function armFailPersonPostBeforeCommit() {
  await page.evaluate(() => { window.__yimaiFailPersonPostBeforeCommit = true; });
}

async function armPersonPost422(message = 'forced create validation failure') {
  await page.evaluate((msg) => {
    window.__yimaiNextPersonPost422 = true;
    window.__yimaiNextPersonPost422Msg = msg;
  }, message);
}

async function armPersonGetFail(id) {
  await page.evaluate((pid) => { window.__yimaiFailNextPersonGetId = String(pid); }, id);
}

async function selectExistingByPersonId(personId) {
  await page.evaluate((id) => {
    const sel = document.getElementById('add-existing');
    if (!sel) throw new Error('add-existing missing');
    sel.value = String(id);
    if (sel.value !== String(id)) throw new Error(`cannot select id ${id}`);
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  }, personId);
}

async function selectConfirmNew() {
  await page.evaluate(() => {
    const sel = document.getElementById('add-existing');
    if (!sel) throw new Error('add-existing missing');
    sel.value = '__confirm_new__';
    if (sel.value !== '__confirm_new__') throw new Error('confirm-new option missing');
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

async function readRecovery() {
  return page.evaluate(() => {
    try { return JSON.parse(localStorage.getItem('yimai_add_recovery') || 'null'); }
    catch (_) { return null; }
  });
}

async function treeSnapshot() {
  return page.evaluate(async () => {
    const token = localStorage.getItem('yimai_token');
    const root = localStorage.getItem('yimai_root_id');
    const res = await fetch(`${window.location.origin}/api/v1/persons/${root}/tree`, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
    });
    const tree = await res.json();
    const stats = document.getElementById('stats')?.textContent || '';
    return {
      root_id: tree.root_id,
      nodeIds: (tree.nodes || []).map((n) => n.id).sort((a, b) => a - b),
      parentEdges: (tree.edges || [])
        .filter((e) => e.type === 'parent')
        .map((e) => `${e.from}->${e.to}`)
        .sort(),
      spouseEdges: (tree.edges || [])
        .filter((e) => e.type === 'spouse')
        .map((e) => [e.a, e.b].sort((a, b) => a - b).join('-'))
        .sort(),
      stats,
      canvasNodes: document.querySelectorAll('g.node-card').length,
    };
  });
}

async function screenshot(name) {
  const file = path.join(ARTIFACTS_DIR, name);
  await page.screenshot({ path: file, fullPage: true });
  return file;
}

// --- Tests ---

async function testPageLoads() {
  await freshPage();
  const title = await page.title();
  const hasCanvas = (await page.$('#tree-canvas')) !== null;
  const hasLoginBtn = (await page.$('#btn-login')) !== null;
  log('Page loads with canvas and login button', Boolean(title && hasCanvas && hasLoginBtn));
}

async function testLoginButtonClickWorks() {
  const result = await loginAsDemo();
  if (!result.ok) {
    log('Login click works', false, result.reason);
    return;
  }
  const statsText = await page.$eval('#stats', (el) => el.textContent);
  const reloadDisabled = await page.$eval('#btn-reload', (el) => el.disabled);
  log(
    'Login click works',
    statsText.includes('位亲人') && !reloadDisabled,
    `Stats: ${statsText}`,
  );
  await screenshot('regression-login-tree.png');
}

async function testTreeRendersAfterLogin() {
  const nodes = await page.$$('g.node-card');
  log('Tree renders with nodes', nodes.length > 0, `Found ${nodes.length} nodes`);
}

async function testPersonSelection() {
  const firstNode = await page.$('g.node-card');
  if (!firstNode) {
    log('Person selection opens sheet', false, 'No nodes to select');
    return;
  }
  const rootBefore = await page.evaluate(() => localStorage.getItem('yimai_root_id'));
  await firstNode.click();
  await page.waitForSelector('#sheet:not(.hidden)', { timeout: 5000 });
  const rootAfter = await page.evaluate(() => localStorage.getItem('yimai_root_id'));
  const sheetVisible = await page.$eval('#sheet', (el) => !el.classList.contains('hidden'));
  log(
    'Person selection opens sheet without changing root',
    sheetVisible && rootBefore === rootAfter,
    `root ${rootBefore}->${rootAfter}`,
  );
}

async function testKinButtonsVisible() {
  const kinButtons = await page.$$('#kin-grid button[data-kin]');
  const keys = await page.$$eval('#kin-grid button[data-kin]', (els) => els.map((e) => e.dataset.kin));
  const expected = ['father', 'mother', 'elder_brother', 'elder_sister', 'younger_brother', 'younger_sister', 'son', 'daughter', 'husband', 'wife'];
  const title = await page.$eval('#sheet-title', (el) => el.textContent);
  const anchorLabel = await page.$eval('#add-anchor-label', (el) => el.textContent).catch(() => '');
  const labelOk = anchorLabel.includes(`当前人：${title}`);
  log(
    'Kin buttons visible and anchorLabel names current person',
    kinButtons.length === 10 && expected.every((k) => keys.includes(k)) && labelOk,
    `keys=${keys.join(',')}; anchorLabel="${anchorLabel}"; title="${title}"`,
  );
}

async function testKinButtonClickWorks() {
  await page.click('button[data-kin="son"]');
  await page.waitForSelector('#form-add:not(.hidden)', { timeout: 5000 });
  const formVisible = await page.$eval('#form-add', (el) => !el.classList.contains('hidden'));
  const contextText = await page.$eval('#add-context', (el) => el.textContent);
  log(
    'Kin button click opens add form',
    formVisible && contextText.includes('儿子'),
    `Context: ${contextText}`,
  );
  await screenshot('regression-kin-add-ui.png');
}

async function testReloadButtonWorks() {
  await page.click('#btn-cancel-add');
  await sleep(200);
  let jsError = null;
  page.once('pageerror', (err) => { jsError = err.message; });
  try {
    await Promise.all([
      page.click('#btn-reload'),
      page.waitForFunction(() => document.querySelectorAll('g.node-card').length > 0, { timeout: 10000 }),
    ]);
  } catch (err) {
    if (jsError?.includes('loadTree is not defined')) {
      log('Reload button works', false, 'loadTree function not defined - REGRESSION');
      return;
    }
    throw err;
  }
  const nodes = await page.$$('g.node-card');
  log('Reload button works', nodes.length > 0, `Found ${nodes.length} nodes after reload`);
}

async function testPersistedTokenReload() {
  const tokenBefore = await page.evaluate(() => localStorage.getItem('yimai_token'));
  const before = await treeSnapshot();
  await page.reload({ waitUntil: 'networkidle0' });
  await page.waitForFunction(() => {
    const stats = document.getElementById('stats');
    return stats && stats.textContent.includes('位亲人');
  }, { timeout: 10000 });
  const tokenAfter = await page.evaluate(() => localStorage.getItem('yimai_token'));
  const after = await treeSnapshot();
  const ok = tokenBefore === tokenAfter
    && JSON.stringify(before.nodeIds) === JSON.stringify(after.nodeIds)
    && JSON.stringify(before.parentEdges) === JSON.stringify(after.parentEdges)
    && JSON.stringify(before.spouseEdges) === JSON.stringify(after.spouseEdges)
    && before.stats === after.stats
    && after.canvasNodes === after.nodeIds.length;
  log(
    'Persisted token reload keeps node IDs, edges, and stats',
    ok,
    `nodes=${after.nodeIds.length}, parentEdges=${after.parentEdges.length}, spouseEdges=${after.spouseEdges.length}`,
  );
}

async function testFirstPersonStaleRootAndRefresh() {
  const { token, userId, treeId } = phpCreateUser();
  await injectAuth({ token, userId, treeId, rootId: '1' });
  await page.reload({ waitUntil: 'networkidle0' });
  await sleep(500);
  const rootAfterBoot = await page.evaluate(() => localStorage.getItem('yimai_root_id'));
  await page.click('#btn-add');
  await page.waitForSelector('#form-add:not(.hidden)', { timeout: 5000 });
  await page.type('#add-name', '第一人甲');
  await page.click('#form-add button[type="submit"]');
  await waitForNodes(1);
  const beforeReload = await personsViaApi();
  const rootAfterAdd = await page.evaluate(() => localStorage.getItem('yimai_root_id'));
  const snap = await treeSnapshot();
  await page.click('#btn-reload');
  await waitForNodes(1);
  const afterReload = await personsViaApi();
  const snap2 = await treeSnapshot();
  const ok = rootAfterBoot !== '1'
    && snap.nodeIds.length === 1
    && beforeReload.length === 1
    && afterReload.length === 1
    && String(rootAfterAdd) === String(beforeReload[0].id)
    && String(afterReload[0].id) === String(beforeReload[0].id)
    && JSON.stringify(snap.nodeIds) === JSON.stringify(snap2.nodeIds);
  log(
    'First person with stale rootId appears and persists on reload',
    ok,
    `bootRoot=${rootAfterBoot}, rootAfterAdd=${rootAfterAdd}, ids=${beforeReload[0]?.id}->${afterReload[0]?.id}`,
  );
}

async function testAddChildWithParentRole() {
  await selectNodeByName('第一人甲');
  const anchor = await personByNameViaApi('第一人甲');
  const before = await personCountViaApi();
  await addKin('son', '测试儿子', { parentRole: 'father' });
  await waitForNodes(2);
  const after = await personCountViaApi();
  const son = await personByNameViaApi('测试儿子');
  const snap = await treeSnapshot();
  const edgeOk = snap.parentEdges.includes(`${anchor.id}->${son?.id}`);
  const ok = after === before + 1
    && son
    && Number(son.father_id) === Number(anchor.id)
    && son.mother_id == null
    && edgeOk;
  log(
    'Add child works with exact father_id and tree edge',
    ok,
    `count ${before}->${after}, father_id=${son?.father_id} expect=${anchor.id}, edgeOk=${edgeOk}`,
  );
}

async function testAddParent() {
  await selectNodeByName('测试儿子');
  const before = await personCountViaApi();
  await addKin('mother', '测试母亲');
  await page.waitForFunction(
    () => document.querySelectorAll('g.node-card').length >= 3
      || document.getElementById('sheet-title')?.textContent === '测试母亲',
    { timeout: 10000 },
  );
  await sleep(400);
  const after = await personCountViaApi();
  const child = await personByNameViaApi('测试儿子');
  const mother = await personByNameViaApi('测试母亲');
  const ok = after === before + 1 && mother && child && Number(child.mother_id) === Number(mother.id);
  log(
    'Add parent (mother) works',
    ok,
    `count ${before}->${after}, child.mother_id=${child?.mother_id}`,
  );
}

async function testAddSpouse() {
  await selectNodeByName('第一人甲');
  const before = await personCountViaApi();
  const a = await personByNameViaApi('第一人甲');
  await addKin('wife', '测试妻子');
  await page.waitForFunction(
    () => document.querySelectorAll('g.node-card').length >= 4
      || document.getElementById('sheet-title')?.textContent === '测试妻子',
    { timeout: 10000 },
  );
  await sleep(400);
  const after = await personCountViaApi();
  const wife = await personByNameViaApi('测试妻子');
  const snap = await treeSnapshot();
  const pair = [Number(a.id), Number(wife?.id)].sort((x, y) => x - y).join('-');
  const bidir = snap.spouseEdges.includes(pair);
  // From either person's tree JSON, spouse edge must appear.
  const fromWifeRoot = await page.evaluate(async (wifeId) => {
    const token = localStorage.getItem('yimai_token');
    const res = await fetch(`${window.location.origin}/api/v1/persons/${wifeId}/tree`, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
    });
    const tree = await res.json();
    return (tree.edges || [])
      .filter((e) => e.type === 'spouse')
      .map((e) => [e.a, e.b].sort((x, y) => x - y).join('-'));
  }, wife.id);
  const ok = after === before + 1 && bidir && fromWifeRoot.includes(pair);
  log(
    'Add spouse (wife) bidirectional on API/tree',
    ok,
    `count ${before}->${after}, pair=${pair}, rootEdges=${snap.spouseEdges.join(',')}, wifeRoot=${fromWifeRoot.join(',')}`,
  );
}

async function testAddSiblingWithKnownParent() {
  await selectNodeByName('测试儿子');
  const before = await personCountViaApi();
  const sonBefore = await personByNameViaApi('测试儿子');
  await addKin('younger_brother', '测试弟弟');
  await page.waitForFunction(
    () => document.querySelectorAll('g.node-card').length >= 5
      || document.getElementById('sheet-title')?.textContent === '测试弟弟',
    { timeout: 10000 },
  );
  await sleep(400);
  const after = await personCountViaApi();
  const son = await personByNameViaApi('测试儿子');
  const bro = await personByNameViaApi('测试弟弟');
  const snap = await treeSnapshot();
  const shareFather = son.father_id != null && Number(bro.father_id) === Number(son.father_id);
  const shareMother = son.mother_id != null && Number(bro.mother_id) === Number(son.mother_id);
  const fatherEdge = snap.parentEdges.includes(`${son.father_id}->${bro.id}`);
  const motherEdge = snap.parentEdges.includes(`${son.mother_id}->${bro.id}`);
  const ok = after === before + 1
    && bro
    && shareFather
    && shareMother
    && fatherEdge
    && motherEdge
    && Number(son.father_id) === Number(sonBefore.father_id);
  log(
    'Add sibling shares known father and mother with tree edges',
    ok,
    `father ${son?.father_id}/${bro?.father_id}, mother ${son?.mother_id}/${bro?.mother_id}, edges F=${fatherEdge} M=${motherEdge}`,
  );
}

async function testExistingPersonRecognition() {
  await selectNodeByName('测试弟弟');
  const before = await personCountViaApi();
  await page.click('button[data-kin="father"]');
  await page.waitForSelector('#form-add:not(.hidden)', { timeout: 5000 });
  const selected = await page.evaluate(() => {
    const sel = document.getElementById('add-existing');
    const opt = Array.from(sel.options).find((o) => o.textContent.includes('第一人甲'));
    if (!opt) return null;
    sel.value = opt.value;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return opt.value;
  });
  if (!selected) {
    log('Existing-person recognition works', false, '第一人甲 not in existing dropdown');
    return;
  }
  await page.click('#form-add button[type="submit"]');
  await sleep(800);
  const after = await personCountViaApi();
  const bro = await personByNameViaApi('测试弟弟');
  const ancestor = await personByNameViaApi('第一人甲');
  const ok = after === before && bro && ancestor && Number(bro.father_id) === Number(ancestor.id);
  log(
    'Existing-person recognition works',
    ok,
    `count ${before}->${after}, bro.father_id=${bro?.father_id}`,
  );
}

async function testMissingSiblingParentError() {
  const { token, userId, treeId, personId } = phpCreateUser({ withPerson: true, personName: '无父母者' });
  await injectAuth({ token, userId, treeId, rootId: personId });
  await page.reload({ waitUntil: 'networkidle0' });
  await waitForNodes(1);
  await selectNodeByName('无父母者');
  const before = await personCountViaApi();
  await page.click('button[data-kin="elder_brother"]');
  await page.waitForSelector('#sheet-error:not(.hidden)', { timeout: 5000 });
  const errorText = await page.$eval('#sheet-error', (el) => el.textContent);
  const formHidden = await page.$eval('#form-add', (el) => el.classList.contains('hidden'));
  const after = await personCountViaApi();
  log(
    'Missing sibling parent shows error before create',
    errorText.includes('父亲或母亲') && formHidden && after === before,
    `Error: ${errorText.substring(0, 40)}; count ${before}->${after}`,
  );
}

let partialBindCtx = null;

async function testPartialCreateBindFailure() {
  const auth = phpCreateUser({ withPerson: true, personName: '锚点人', gender: 'male' });
  await injectAuth({ ...auth, rootId: auth.personId });
  await page.reload({ waitUntil: 'networkidle0' });
  await waitForNodes(1);
  await selectNodeByName('锚点人');
  await installFetchHooks();

  const before = await personCountViaApi();
  await page.click('button[data-kin="son"]');
  await page.waitForSelector('#form-add:not(.hidden)', { timeout: 5000 });
  await page.type('#add-name', '半成儿子');
  await armBindFail();
  await page.click('#form-add button[type="submit"]');
  await page.waitForSelector('#add-error:not(.hidden)', { timeout: 10000 });
  await sleep(300);
  // Navigate away to detail — recovery guidance must remain visible.
  await selectNodeByName('锚点人');
  await sleep(300);
  const sheetErr = await page.$eval('#sheet-error', (el) => ({
    t: el.textContent,
    h: el.classList.contains('hidden'),
  }));
  const recovery = await page.evaluate(() => {
    try { return JSON.parse(localStorage.getItem('yimai_add_recovery') || 'null'); }
    catch { return null; }
  });
  const afterFail = await personCountViaApi();
  const child = await personByNameViaApi('半成儿子');
  const posts = await page.evaluate(() => window.__yimaiPostPersonCount);
  const ok = !sheetErr.h
    && sheetErr.t.includes('人已记下，关系未保存')
    && afterFail === before + 1
    && child
    && child.father_id == null
    && posts === 1
    && recovery
    && String(recovery.pendingPersonId) === String(child.id)
    && recovery.kin === 'son'
    && String(recovery.userId) === String(auth.userId);
  partialBindCtx = { ...auth, afterFail, childId: child?.id, posts };
  await screenshot('recovery-partial-bind-sheet.png');
  log(
    'Partial bind keeps recovery message across detail navigation',
    ok,
    `sheet="${sheetErr.t.substring(0, 40)}", id=${child?.id}, posts=${posts}`,
  );
}

async function testPartialRecoverySurvivesRefreshAndRetry() {
  if (!partialBindCtx?.childId) {
    log('Partial recovery survives F5 and retries without duplicate POST', false, 'no context');
    return;
  }
  const postsBefore = await page.evaluate(() => window.__yimaiPostPersonCount || 0);
  await page.reload({ waitUntil: 'networkidle0' });
  await sleep(800);
  await installFetchHooks();
  await page.evaluate((n) => { window.__yimaiPostPersonCount = n; }, postsBefore);
  // Recovery should reopen add form for son, or at least keep guidance.
  await page.waitForFunction(() => {
    const rec = localStorage.getItem('yimai_add_recovery');
    const err = document.getElementById('sheet-error');
    return rec && err && !err.classList.contains('hidden') && err.textContent.includes('人已记下');
  }, { timeout: 10000 });
  let formOpen = await page.$eval('#form-add', (el) => !el.classList.contains('hidden'));
  if (!formOpen) {
    await selectNodeByName('锚点人');
    await page.click('button[data-kin="son"]');
    await page.waitForSelector('#form-add:not(.hidden)', { timeout: 5000 });
    formOpen = true;
  }
  const beforeRetry = await personCountViaApi();
  await page.evaluate(() => {
    const btn = document.getElementById('btn-submit-add');
    if (btn) btn.disabled = false;
    document.getElementById('form-add').requestSubmit();
  });
  await sleep(1500);
  const afterRetry = await personCountViaApi();
  const postsAfter = await page.evaluate(() => window.__yimaiPostPersonCount);
  const sameName = (await personsViaApi()).filter((p) => p.name === '半成儿子');
  const child = sameName[0];
  const ok = formOpen
    && afterRetry === beforeRetry
    && sameName.length === 1
    && String(child.id) === String(partialBindCtx.childId)
    && postsAfter === postsBefore
    && child.father_id != null
    && Number(child.father_id) === Number(partialBindCtx.personId);
  log(
    'Partial recovery survives F5 and retries without duplicate POST',
    ok,
    `count ${beforeRetry}->${afterRetry}, posts ${postsBefore}->${postsAfter}, id=${child?.id}, father_id=${child?.father_id} expect=${partialBindCtx.personId}`,
  );
}

async function submitAddForm() {
  await page.evaluate(() => {
    const btn = document.getElementById('btn-submit-add');
    if (btn) btn.disabled = false;
    const form = document.getElementById('form-add');
    if (!form || form.classList.contains('hidden')) throw new Error('add form not open');
    form.requestSubmit();
  });
}

async function testPostSaveLoadFailureRetryStable() {
  const auth = phpCreateUser({ withPerson: true, personName: '载入锚点', gender: 'male' });
  await injectAuth({ ...auth, rootId: auth.personId });
  await page.reload({ waitUntil: 'networkidle0' });
  await waitForNodes(1);
  await selectNodeByName('载入锚点');
  await installFetchHooks();
  await page.evaluate(() => { window.__yimaiPostPersonCount = 0; });
  await page.click('button[data-kin="daughter"]');
  await page.waitForSelector('#form-add:not(.hidden)', { timeout: 5000 });
  await page.type('#add-name', '载入女儿');
  await armTreeLoadFail();
  await submitAddForm();
  await sleep(1200);
  const err = await page.$eval('#add-error', (el) => el.textContent);
  const sheetErr = await page.$eval('#sheet-error', (el) => el.textContent);
  const afterFail = await personsViaApi();
  const daughter = afterFail.find((p) => p.name === '载入女儿');
  const posts1 = await page.evaluate(() => window.__yimaiPostPersonCount);
  const msg = `${err} ${sheetErr}`;
  const msgOk = msg.includes('关系已保存') && msg.includes('画面没有刷新成功');
  // Ensure form still available for retry
  const formOpen = await page.$eval('#form-add', (el) => !el.classList.contains('hidden'));
  if (!formOpen) {
    await selectNodeByName('载入锚点');
    await page.click('button[data-kin="daughter"]');
    await page.waitForSelector('#form-add:not(.hidden)', { timeout: 5000 });
  }
  await submitAddForm();
  await sleep(1200);
  const afterRetry = await personsViaApi();
  const posts2 = await page.evaluate(() => window.__yimaiPostPersonCount);
  const same = afterRetry.filter((p) => p.name === '载入女儿');
  await page.reload({ waitUntil: 'networkidle0' });
  await sleep(700);
  const afterRefresh = (await personsViaApi()).filter((p) => p.name === '载入女儿');
  const ok = msgOk
    && daughter
    && posts1 === 1
    && posts2 === 1
    && same.length === 1
    && String(same[0].id) === String(daughter.id)
    && afterRefresh.length === 1
    && String(afterRefresh[0].id) === String(daughter.id)
    && Number(same[0].father_id) === Number(auth.personId);
  await screenshot('recovery-display-load-fail.png');
  log(
    'Post-save tree load failure retries without duplicate person',
    ok,
    `msgOk=${msgOk}, posts ${posts1}->${posts2}, id=${daughter?.id}, father=${same[0]?.father_id}`,
  );
}

async function testDoubleSubmitDoesNotDuplicate() {
  const auth = phpCreateUser({ withPerson: true, personName: '双击锚点', gender: 'male' });
  await injectAuth({ ...auth, rootId: auth.personId });
  await page.reload({ waitUntil: 'networkidle0' });
  await waitForNodes(1);
  await selectNodeByName('双击锚点');
  await installFetchHooks();
  await page.evaluate(() => { window.__yimaiPostPersonCount = 0; });
  await page.click('button[data-kin="daughter"]');
  await page.waitForSelector('#form-add:not(.hidden)', { timeout: 5000 });
  await page.type('#add-name', '双击女儿');
  await page.evaluate(() => {
    const form = document.getElementById('form-add');
    form.requestSubmit();
    form.requestSubmit();
  });
  await sleep(1500);
  const list = (await personsViaApi()).filter((p) => p.name === '双击女儿');
  const posts = await page.evaluate(() => window.__yimaiPostPersonCount);
  log(
    'Double submit does not create duplicate person',
    list.length === 1 && posts <= 1,
    `same-name=${list.length}, posts=${posts}`,
  );
}

async function testParentOverwriteBlockedFatherAndMother() {
  const auth = phpCreateUser({ withPerson: true, personName: '孩子甲', gender: 'male' });
  await injectAuth({ ...auth, rootId: auth.personId });
  await page.reload({ waitUntil: 'networkidle0' });
  await waitForNodes(1);
  await selectNodeByName('孩子甲');
  await addKin('father', '父亲甲');
  await sleep(700);
  await selectNodeByName('孩子甲');
  await addKin('mother', '母亲甲');
  await sleep(700);
  const child = await personByNameViaApi('孩子甲');
  const fatherA = await personByNameViaApi('父亲甲');
  const motherA = await personByNameViaApi('母亲甲');
  const countBase = await personCountViaApi();
  const snapBase = await treeSnapshot();

  // New-person father conflict
  await selectNodeByName('孩子甲');
  await page.click('button[data-kin="father"]');
  await page.waitForSelector('#form-add:not(.hidden)', { timeout: 5000 });
  await page.type('#add-name', '父亲乙');
  await page.click('#form-add button[type="submit"]');
  await sleep(700);
  const errF = await page.$eval('#add-error', (el) => el.textContent);
  // New-person mother conflict
  await selectNodeByName('孩子甲');
  await page.click('button[data-kin="mother"]');
  await page.waitForSelector('#form-add:not(.hidden)', { timeout: 5000 });
  await page.type('#add-name', '母亲乙');
  await page.click('#form-add button[type="submit"]');
  await sleep(700);
  const errM = await page.$eval('#add-error', (el) => el.textContent);

  // Existing-person conflict: try bind 第一人-style wrong parent via 父亲甲 onto mother slot using another person
  await selectNodeByName('孩子甲');
  await page.click('button[data-kin="mother"]');
  await page.waitForSelector('#form-add:not(.hidden)', { timeout: 5000 });
  await page.evaluate(() => {
    const sel = document.getElementById('add-existing');
    const opt = Array.from(sel.options).find((o) => o.textContent.includes('父亲甲'));
    if (!opt) throw new Error('父亲甲 missing for existing conflict');
    sel.value = opt.value;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.click('#form-add button[type="submit"]');
  await sleep(700);
  const errExisting = await page.$eval('#add-error', (el) => el.textContent);

  const childAfter = await personByNameViaApi('孩子甲');
  const countAfter = await personCountViaApi();
  const snapAfter = await treeSnapshot();
  const noFatherB = !(await personByNameViaApi('父亲乙'));
  const noMotherB = !(await personByNameViaApi('母亲乙'));
  const ok = errF.includes('已经记过父亲')
    && errM.includes('已经记过母亲')
    && errExisting.includes('已经记过母亲')
    && Number(childAfter.father_id) === Number(fatherA.id)
    && Number(childAfter.mother_id) === Number(motherA.id)
    && countAfter === countBase
    && noFatherB
    && noMotherB
    && JSON.stringify(snapBase.parentEdges) === JSON.stringify(snapAfter.parentEdges);
  log(
    'Father/mother overwrite blocked for new and existing selection',
    ok,
    `father ${child.father_id}->${childAfter.father_id}, mother ${child.mother_id}->${childAfter.mother_id}, count ${countBase}->${countAfter}`,
  );
}

async function testIdempotentSameFatherBind() {
  await selectNodeByName('孩子甲');
  const before = await personByNameViaApi('孩子甲');
  const countBefore = await personCountViaApi();
  await page.click('button[data-kin="father"]');
  await page.waitForSelector('#form-add:not(.hidden)', { timeout: 5000 });
  await page.evaluate(() => {
    const sel = document.getElementById('add-existing');
    const opt = Array.from(sel.options).find((o) => o.textContent.includes('父亲甲'));
    if (!opt) throw new Error('父亲甲 missing');
    sel.value = opt.value;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.click('#form-add button[type="submit"]');
  await sleep(800);
  const after = await personByNameViaApi('孩子甲');
  const countAfter = await personCountViaApi();
  const errHidden = await page.$eval('#add-error', (el) => el.classList.contains('hidden') || !el.textContent);
  log(
    'Idempotent same-father bind does not conflict',
    Number(after.father_id) === Number(before.father_id) && countAfter === countBefore && errHidden,
    `father_id=${after?.father_id}, count ${countBefore}->${countAfter}`,
  );
}

async function testIdempotentSameMotherBind() {
  await selectNodeByName('孩子甲');
  const before = await personByNameViaApi('孩子甲');
  const countBefore = await personCountViaApi();
  const snapBefore = await treeSnapshot();
  await page.click('button[data-kin="mother"]');
  await page.waitForSelector('#form-add:not(.hidden)', { timeout: 5000 });
  await page.evaluate(() => {
    const sel = document.getElementById('add-existing');
    const opt = Array.from(sel.options).find((o) => o.textContent.includes('母亲甲'));
    if (!opt) throw new Error('母亲甲 missing');
    sel.value = opt.value;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await submitAddForm();
  await sleep(800);
  const after = await personByNameViaApi('孩子甲');
  const countAfter = await personCountViaApi();
  const snapAfter = await treeSnapshot();
  const errHidden = await page.$eval('#add-error', (el) => el.classList.contains('hidden') || !el.textContent);
  log(
    'Idempotent same-mother bind does not conflict',
    Number(after.mother_id) === Number(before.mother_id)
      && countAfter === countBefore
      && errHidden
      && JSON.stringify(snapBefore.parentEdges) === JSON.stringify(snapAfter.parentEdges)
      && snapBefore.stats === snapAfter.stats,
    `mother_id=${after?.mother_id}, count ${countBefore}->${countAfter}`,
  );
}

async function testExistingPersonOccupiedFatherSlotBlocked() {
  // Symmetric to mother: select another existing person into an occupied father slot.
  await selectNodeByName('孩子甲');
  const before = await personByNameViaApi('孩子甲');
  const fatherA = await personByNameViaApi('父亲甲');
  const countBefore = await personCountViaApi();
  const snapBefore = await treeSnapshot();
  // Ensure 父亲乙 exists as an alternate existing person without binding as father.
  await selectNodeByName('孩子甲');
  await addKin('son', '旁系儿子');
  await sleep(700);
  const decoy = await personByNameViaApi('旁系儿子');
  await selectNodeByName('孩子甲');
  await page.click('button[data-kin="father"]');
  await page.waitForSelector('#form-add:not(.hidden)', { timeout: 5000 });
  await page.evaluate((decoyName) => {
    const sel = document.getElementById('add-existing');
    const opt = Array.from(sel.options).find((o) => o.textContent.includes(decoyName));
    if (!opt) throw new Error(`${decoyName} missing for occupied father existing bind`);
    sel.value = opt.value;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  }, '旁系儿子');
  await submitAddForm();
  await sleep(800);
  const err = await page.$eval('#add-error', (el) => el.textContent);
  const after = await personByNameViaApi('孩子甲');
  const countAfter = await personCountViaApi();
  const snapAfter = await treeSnapshot();
  const ok = err.includes('已经记过父亲')
    && Number(after.father_id) === Number(fatherA.id)
    && Number(after.father_id) === Number(before.father_id)
    && countAfter === countBefore + 1 // only the decoy son from setup
    && decoy
    && snapBefore.parentEdges.every((e) => snapAfter.parentEdges.includes(e));
  log(
    'Existing-person occupied father slot blocked; ids/edges preserved',
    ok,
    `err=${err.slice(0, 40)}, father ${before.father_id}->${after.father_id}, count ${countBefore}->${countAfter}`,
  );
}

async function testRefreshDuringDisplayLoadKeepsIdentity() {
  // Depth counterexample window: delay tree GET, refresh WHILE unresolved — must keep id.
  const auth = phpCreateUser({ withPerson: true, personName: '中断锚点', gender: 'male' });
  await injectAuth({ ...auth, rootId: auth.personId });
  await page.reload({ waitUntil: 'networkidle0' });
  await waitForNodes(1);
  await selectNodeByName('中断锚点');
  await installFetchHooks();
  await page.evaluate(() => { window.__yimaiPostPersonCount = 0; });
  await page.click('button[data-kin="son"]');
  await page.waitForSelector('#form-add:not(.hidden)', { timeout: 5000 });
  await page.type('#add-name', '中断儿子');
  await armTreeLoadDelay(10000);
  await submitAddForm();

  let recoveryDuring = null;
  let delaySeen = false;
  const deadline = Date.now() + 7000;
  while (Date.now() < deadline) {
    const snap = await page.evaluate(() => ({
      active: Boolean(window.__yimaiTreeDelayActive),
      recovery: localStorage.getItem('yimai_add_recovery'),
      posts: window.__yimaiPostPersonCount,
    }));
    if (snap.active) delaySeen = true;
    if (snap.active && snap.recovery) {
      recoveryDuring = JSON.parse(snap.recovery);
      break;
    }
    await sleep(40);
  }
  const personsMid = (await personsViaApi()).filter((p) => p.name === '中断儿子');
  const postsMid = await page.evaluate(() => window.__yimaiPostPersonCount);

  await page.reload({ waitUntil: 'networkidle0' });
  await sleep(900);
  const recoveryAfter = await readRecovery();
  await installFetchHooks();
  await page.evaluate(() => { window.__yimaiPostPersonCount = 0; });
  // Resume should complete without a second create.
  if (recoveryAfter?.kin === 'son') {
    await selectNodeByName('中断锚点');
    await page.click('button[data-kin="son"]');
    await page.waitForSelector('#form-add:not(.hidden)', { timeout: 5000 });
  } else if (recoveryAfter?.pendingPersonId) {
    await page.click('#btn-add');
  }
  await submitAddForm();
  await sleep(1200);
  const postsAfter = await page.evaluate(() => window.__yimaiPostPersonCount);
  const same = (await personsViaApi()).filter((p) => p.name === '中断儿子');
  const ok = delaySeen
    && recoveryDuring
    && String(recoveryDuring.pendingPersonId) === String(personsMid[0]?.id)
    && recoveryAfter
    && String(recoveryAfter.pendingPersonId) === String(personsMid[0]?.id)
    && postsMid === 1
    && postsAfter === 0
    && same.length === 1
    && Number(same[0].father_id) === Number(auth.personId);
  await screenshot('recovery-refresh-during-display-load.png');
  log(
    'Refresh during unresolved display load keeps exact id (one POST)',
    ok,
    `delaySeen=${delaySeen}, midId=${personsMid[0]?.id}, afterId=${recoveryAfter?.pendingPersonId}, posts ${postsMid}->${postsAfter}, count=${same.length}`,
  );
}

async function testSiblingMissingParentKeepsRecoveryNotice() {
  const auth = phpCreateUser({ withPerson: true, personName: '无父母锚', gender: 'male' });
  // Build partial-save pending on a different branch person first.
  const seed = await page.evaluate(async (a) => {
    const headers = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${a.token}`,
    };
    const child = await fetch('/api/v1/persons', {
      method: 'POST', headers, body: JSON.stringify({ name: '待绑孩子', gender: 'male', generation: 2 }),
    }).then((r) => r.json());
    return child;
  }, auth);
  await injectAuth({ ...auth, rootId: auth.personId });
  await page.reload({ waitUntil: 'networkidle0' });
  await waitForNodes(1);
  await page.evaluate((payload) => {
    localStorage.setItem('yimai_add_recovery', JSON.stringify(payload));
  }, {
    userId: String(auth.userId),
    treeId: String(auth.treeId),
    pendingPersonId: seed.id,
    kin: 'son',
    relation: 'child',
    anchorId: Number(auth.personId),
    parentRole: 'father',
    name: '待绑孩子',
    phase: 'bind_failed',
    message: '人已记下，关系未保存：forced bind failure for regression test',
  });
  await page.reload({ waitUntil: 'networkidle0' });
  await waitForNodes(1);
  await selectNodeByName('无父母锚');
  await page.click('button[data-kin="younger_brother"]');
  await sleep(400);
  const sheetErr = await page.$eval('#sheet-error', (el) => el.textContent);
  const recovery = await readRecovery();
  const ok = sheetErr.includes('父亲或母亲')
    && sheetErr.includes('人已记下，关系未保存')
    && recovery
    && String(recovery.pendingPersonId) === String(seed.id);
  await screenshot('recovery-sibling-missing-parent-dual.png');
  log(
    'Sibling missing-parent shows prerequisite AND recovery notice',
    ok,
    `sheet=${sheetErr.slice(0, 80)}, pending=${recovery?.pendingPersonId}`,
  );
}

async function testLostCreateResponseNoSecondPost() {
  const auth = phpCreateUser({ withPerson: true, personName: '丢包锚点', gender: 'male' });
  await injectAuth({ ...auth, rootId: auth.personId });
  await page.reload({ waitUntil: 'networkidle0' });
  await waitForNodes(1);
  await selectNodeByName('丢包锚点');
  await installFetchHooks();
  await page.evaluate(() => { window.__yimaiPostPersonCount = 0; });
  await page.click('button[data-kin="daughter"]');
  await page.waitForSelector('#form-add:not(.hidden)', { timeout: 5000 });
  await page.type('#add-name', '丢包女儿');
  await armLoseNextPersonPostResponse();
  await submitAddForm();
  await sleep(1200);
  const err1 = await page.$eval('#add-error', (el) => el.textContent);
  const recovery1 = await readRecovery();
  const posts1 = await page.evaluate(() => window.__yimaiPostPersonCount);
  const created = (await personsViaApi()).filter((p) => p.name === '丢包女儿');
  // Blind retry must NOT auto-adopt/bind by name.
  await submitAddForm();
  await sleep(800);
  const postsBlind = await page.evaluate(() => window.__yimaiPostPersonCount);
  const mid = await personByNameViaApi('丢包女儿');
  const stillUnbound = mid && (mid.father_id == null || mid.father_id === '');
  // Explicit ID selection of the committed person — not name heuristic.
  await selectExistingByPersonId(created[0].id);
  await submitAddForm();
  await sleep(1200);
  const posts2 = await page.evaluate(() => window.__yimaiPostPersonCount);
  const after = (await personsViaApi()).filter((p) => p.name === '丢包女儿');
  const snap = await treeSnapshot();
  const edgeOk = snap.parentEdges.includes(`${auth.personId}->${created[0].id}`);
  const ok = err1.includes('不确定')
    && err1.includes('同名不会自动合并')
    && recovery1?.phase === 'create_uncertain'
    && !recovery1.pendingPersonId
    && posts1 === 1
    && postsBlind === 1
    && stillUnbound
    && posts2 === 1
    && created.length === 1
    && after.length === 1
    && String(after[0].id) === String(created[0].id)
    && Number(after[0].father_id) === Number(auth.personId)
    && edgeOk;
  await screenshot('recovery-lost-create-response.png');
  log(
    'Lost create response requires explicit ID; no name auto-adopt',
    ok,
    `posts ${posts1}/${postsBlind}/${posts2}, id=${after[0]?.id}, father=${after[0]?.father_id}, edgeOk=${edgeOk}`,
  );
}

async function testSameName422NoAdoptThenValidCreate() {
  // Preexisting 李四; attempted POST 422 (no commit) must not bind old 李四.
  const auth = phpCreateUser({ withPerson: true, personName: '校验锚点', gender: 'male' });
  const old = await page.evaluate(async (a) => {
    const headers = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${a.token}`,
    };
    return fetch('/api/v1/persons', {
      method: 'POST', headers, body: JSON.stringify({ name: '李四', gender: 'female', generation: 2 }),
    }).then((r) => r.json());
  }, auth);
  await injectAuth({ ...auth, rootId: auth.personId });
  await page.reload({ waitUntil: 'networkidle0' });
  await waitForNodes(1);
  await selectNodeByName('校验锚点');
  await installFetchHooks();
  await page.evaluate(() => { window.__yimaiPostPersonCount = 0; });
  await page.click('button[data-kin="daughter"]');
  await page.waitForSelector('#form-add:not(.hidden)', { timeout: 5000 });
  await page.type('#add-name', '李四');
  await armPersonPost422('forced create validation failure');
  await submitAddForm();
  await sleep(900);
  const err = await page.$eval('#add-error', (el) => el.textContent);
  const recovery = await readRecovery();
  const posts1 = await page.evaluate(() => window.__yimaiPostPersonCount);
  const oldAfter = await page.evaluate(async (id) => {
    const token = localStorage.getItem('yimai_token');
    const res = await fetch(`${location.origin}/api/v1/persons/${id}`, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
    });
    return res.json();
  }, old.id);
  const count1 = await personCountViaApi();
  // Corrected valid resubmit creates a distinct person.
  await page.$eval('#add-name', (el) => { el.value = ''; });
  await page.type('#add-name', '李四乙');
  await submitAddForm();
  await sleep(1200);
  const posts2 = await page.evaluate(() => window.__yimaiPostPersonCount);
  const list = await personsViaApi();
  const created = list.filter((p) => p.name === '李四乙');
  const stillOld = list.find((p) => Number(p.id) === Number(old.id));
  const snap = await treeSnapshot();
  const ok = err.includes('forced create validation failure')
    && !err.includes('不确定')
    && recovery == null
    && posts1 === 1
    && oldAfter.father_id == null
    && count1 === 2 // anchor + old 李四 only
    && posts2 === 2
    && created.length === 1
    && Number(created[0].id) !== Number(old.id)
    && Number(created[0].father_id) === Number(auth.personId)
    && stillOld
    && stillOld.father_id == null
    && snap.parentEdges.includes(`${auth.personId}->${created[0].id}`)
    && !snap.parentEdges.includes(`${auth.personId}->${old.id}`);
  log(
    'Definite 422 create rejection: no same-name adopt; corrected create distinct',
    ok,
    `posts ${posts1}->${posts2}, old=${old.id}/${stillOld?.father_id}, new=${created[0]?.id}/${created[0]?.father_id}`,
  );
}

async function testSameNameNetworkFailRequiresExplicitChoice() {
  // Old 李四 exists; network fail before commit; retry must not auto-bind old 李四.
  const auth = phpCreateUser({ withPerson: true, personName: '网断锚点', gender: 'male' });
  const old = await page.evaluate(async (a) => {
    const headers = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${a.token}`,
    };
    return fetch('/api/v1/persons', {
      method: 'POST', headers, body: JSON.stringify({ name: '李四', gender: 'male', generation: 2 }),
    }).then((r) => r.json());
  }, auth);
  await injectAuth({ ...auth, rootId: auth.personId });
  await page.reload({ waitUntil: 'networkidle0' });
  await waitForNodes(1);
  await selectNodeByName('网断锚点');
  await installFetchHooks();
  await page.evaluate(() => { window.__yimaiPostPersonCount = 0; });
  await page.click('button[data-kin="son"]');
  await page.waitForSelector('#form-add:not(.hidden)', { timeout: 5000 });
  await page.type('#add-name', '李四');
  await armFailPersonPostBeforeCommit();
  await submitAddForm();
  await sleep(900);
  const err1 = await page.$eval('#add-error', (el) => el.textContent);
  const posts1 = await page.evaluate(() => window.__yimaiPostPersonCount);
  // Blind retry: still no bind of old 李四, no second create until explicit choice.
  await submitAddForm();
  await sleep(700);
  const posts2 = await page.evaluate(() => window.__yimaiPostPersonCount);
  const oldMid = await page.evaluate(async (id) => {
    const token = localStorage.getItem('yimai_token');
    return fetch(`${location.origin}/api/v1/persons/${id}`, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
    }).then((r) => r.json());
  }, old.id);
  // Explicit confirm-new then successful create of a distinct 李四.
  await selectConfirmNew();
  await submitAddForm();
  await sleep(1200);
  const posts3 = await page.evaluate(() => window.__yimaiPostPersonCount);
  const named = (await personsViaApi()).filter((p) => p.name === '李四');
  const snap = await treeSnapshot();
  const newOne = named.find((p) => Number(p.id) !== Number(old.id));
  const ok = err1.includes('不确定')
    && posts1 === 1
    && posts2 === 1
    && oldMid.father_id == null
    && posts3 === 2
    && named.length === 2
    && newOne
    && Number(newOne.father_id) === Number(auth.personId)
    && snap.parentEdges.includes(`${auth.personId}->${newOne.id}`)
    && !snap.parentEdges.includes(`${auth.personId}->${old.id}`);
  log(
    'Network fail before commit with same-name: explicit choice, no auto-bind',
    ok,
    `posts ${posts1}/${posts2}/${posts3}, oldF=${oldMid.father_id}, new=${newOne?.id}, names=${named.length}`,
  );
}

function phpCreateEmptyUserNoTree() {
  const email = `emptyui${Date.now()}${Math.floor(Math.random() * 1000)}@test.test`;
  const script = `<?php
require '${APP_ROOT}/vendor/autoload.php';
$app = require '${APP_ROOT}/bootstrap/app.php';
$app->make(Illuminate\\Contracts\\Console\\Kernel::class)->bootstrap();
$u = App\\Models\\User::create(['name'=>'EmptyUI','email'=>'${email}','password'=>bcrypt('password')]);
// No Tree row — login must acquire scope via trees/current.
echo json_encode(['userId'=>$u->id,'email'=>'${email}'], JSON_UNESCAPED_UNICODE);
`;
  const tmp = path.join(ARTIFACTS_DIR, `_tmp_empty_${Date.now()}.php`);
  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
  fs.writeFileSync(tmp, script);
  const result = spawnSync('php', [tmp], { cwd: APP_ROOT, encoding: 'utf8' });
  fs.unlinkSync(tmp);
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  const parsed = JSON.parse((result.stdout || '').trim().split('\n').filter(Boolean).pop());
  return { email: parsed.email, userId: String(parsed.userId), password: 'password' };
}

async function loginViaUi(email, password) {
  // Clear before scripts boot to avoid prior-test token/treeId races.
  await page.goto(`${BASE_URL}/app/`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.evaluate((auth) => {
    document.getElementById('email').value = auth.email;
    document.getElementById('password').value = auth.password;
    document.getElementById('btn-login').click();
  }, { email, password });
  await page.waitForFunction(() => {
    const stats = document.getElementById('stats')?.textContent || '';
    const treeId = localStorage.getItem('yimai_tree_id');
    return (stats.includes('没有记下') || stats.includes('位亲人')) && Boolean(treeId);
  }, { timeout: 20000 });
  await sleep(300);
}

async function testEmptyAccountRealLoginTreeScopeAndLostCreate() {
  // Hidden by injectAuth fixtures: fresh empty account has no treeId until trees/current.
  const user = phpCreateEmptyUserNoTree();
  await loginViaUi(user.email, user.password);
  const afterLogin = await page.evaluate(() => ({
    treeId: localStorage.getItem('yimai_tree_id'),
    userId: localStorage.getItem('yimai_user_id'),
  }));
  await installFetchHooks();
  await page.evaluate(() => {
    window.__yimaiPostPersonCount = 0;
    window.__yimaiLoseNextPersonPostResponse = true;
  });
  await page.evaluate(() => document.getElementById('btn-add').click());
  await page.waitForSelector('#form-add:not(.hidden)', { timeout: 10000 });
  await page.$eval('#add-name', (el) => { el.value = '实登录第一人'; });
  await submitAddForm();
  await sleep(1200);
  const afterLost = await readRecovery();
  const posts1 = await page.evaluate(() => window.__yimaiPostPersonCount);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => Boolean(localStorage.getItem('yimai_token')), { timeout: 20000 });
  await sleep(900);
  const afterRefresh = await readRecovery();
  await installFetchHooks();
  await page.evaluate(() => { window.__yimaiPostPersonCount = 0; });
  // Blind retry must not POST again while uncertain recovery is scoped.
  const formOpen = await page.$eval('#form-add', (el) => !el.classList.contains('hidden')).catch(() => false);
  if (!formOpen) {
    await page.evaluate(() => document.getElementById('btn-add').click());
    await page.waitForSelector('#form-add:not(.hidden)', { timeout: 8000 }).catch(() => null);
  }
  await page.$eval('#add-name', (el) => { el.value = '实登录第一人'; }).catch(() => null);
  await submitAddForm().catch(() => null);
  await sleep(900);
  const postsBlind = await page.evaluate(() => window.__yimaiPostPersonCount);
  const named = (await personsViaApi()).filter((p) => p.name === '实登录第一人');
  // Explicit ID selection completes without a second create.
  if (named[0] && afterRefresh) {
    await selectExistingByPersonId(named[0].id);
    await submitAddForm();
    await sleep(1200);
  }
  const postsFinal = await page.evaluate(() => window.__yimaiPostPersonCount);
  const finalNamed = (await personsViaApi()).filter((p) => p.name === '实登录第一人');
  const ok = Boolean(afterLogin.treeId)
    && String(afterLogin.userId) === String(user.userId)
    && afterLost
    && Boolean(afterLost.treeId)
    && String(afterLost.treeId) === String(afterLogin.treeId)
    && afterLost.phase === 'create_uncertain'
    && afterRefresh
    && String(afterRefresh.treeId) === String(afterLost.treeId)
    && String(afterRefresh.userId || afterLogin.userId) === String(user.userId)
    && posts1 === 1
    && postsBlind === 0
    && finalNamed.length === 1
    && Number(finalNamed[0].tree_id) === Number(afterLogin.treeId)
    && postsFinal === 0;
  await screenshot('empty-account-real-login-lost-create.png');
  log(
    'Empty-account real login acquires treeId; lost create+F5 keeps scoped recovery (no duplicate)',
    ok,
    `loginTree=${afterLogin.treeId}, lostTree=${afterLost?.treeId}, refreshTree=${afterRefresh?.treeId}, posts ${posts1}/${postsBlind}/${postsFinal}, ids=${finalNamed.map((p) => p.id).join(',')}`,
  );
}

async function testLostResponseSameNameNoAutoSelect() {
  // Lost response AFTER commit while another same-name already exists — must not auto-select either.
  const auth = phpCreateUser({ withPerson: true, personName: '丢包同名锚', gender: 'male' });
  const old = await page.evaluate(async (a) => {
    const headers = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${a.token}`,
    };
    return fetch('/api/v1/persons', {
      method: 'POST', headers, body: JSON.stringify({ name: '李四', gender: 'female', generation: 2 }),
    }).then((r) => r.json());
  }, auth);
  await injectAuth({ ...auth, rootId: auth.personId });
  await page.reload({ waitUntil: 'networkidle0' });
  await waitForNodes(1);
  await selectNodeByName('丢包同名锚');
  await installFetchHooks();
  await page.evaluate(() => { window.__yimaiPostPersonCount = 0; });
  await page.click('button[data-kin="daughter"]');
  await page.waitForSelector('#form-add:not(.hidden)', { timeout: 5000 });
  await page.type('#add-name', '李四');
  await armLoseNextPersonPostResponse();
  await submitAddForm();
  await sleep(1200);
  const posts1 = await page.evaluate(() => window.__yimaiPostPersonCount);
  const named = (await personsViaApi()).filter((p) => p.name === '李四');
  const committed = named.find((p) => Number(p.id) !== Number(old.id));
  await submitAddForm(); // blind — no auto select
  await sleep(700);
  const posts2 = await page.evaluate(() => window.__yimaiPostPersonCount);
  const afterBlind = await personsViaApi();
  const oldBlind = afterBlind.find((p) => Number(p.id) === Number(old.id));
  const newBlind = afterBlind.find((p) => Number(p.id) === Number(committed?.id));
  // Explicitly select the newly committed id (not the old same-name).
  await selectExistingByPersonId(committed.id);
  await submitAddForm();
  await sleep(1200);
  const posts3 = await page.evaluate(() => window.__yimaiPostPersonCount);
  const final = await personsViaApi();
  const oldFinal = final.find((p) => Number(p.id) === Number(old.id));
  const newFinal = final.find((p) => Number(p.id) === Number(committed.id));
  const snap = await treeSnapshot();
  const ok = posts1 === 1
    && named.length === 2
    && committed
    && posts2 === 1
    && oldBlind.father_id == null
    && (newBlind.father_id == null || newBlind.father_id === '')
    && posts3 === 1
    && oldFinal.father_id == null
    && Number(newFinal.father_id) === Number(auth.personId)
    && snap.parentEdges.includes(`${auth.personId}->${committed.id}`)
    && !snap.parentEdges.includes(`${auth.personId}->${old.id}`);
  log(
    'Lost response with preexisting same-name: no auto-select; explicit ID binds',
    ok,
    `posts ${posts1}/${posts2}/${posts3}, old=${old.id}/${oldFinal?.father_id}, new=${committed?.id}/${newFinal?.father_id}`,
  );
}

async function testPendingGetFailFallsBackToListWithoutClear() {
  // Verifies d9ff844 semantics (not a rewrite): single GET-by-id failure does not
  // clear recovery; loadPersons fallback finds the id. Clear only if list lacks id.
  const auth = phpCreateUser({ withPerson: true, personName: '读失败锚', gender: 'male' });
  await injectAuth({ ...auth, rootId: auth.personId });
  await page.reload({ waitUntil: 'networkidle0' });
  await waitForNodes(1);
  const child = await page.evaluate(async (a) => {
    const headers = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${a.token}`,
    };
    return fetch('/api/v1/persons', {
      method: 'POST', headers, body: JSON.stringify({ name: '待读孩子', gender: 'female', generation: 2 }),
    }).then((r) => r.json());
  }, auth);
  await page.evaluate((payload) => {
    localStorage.setItem('yimai_add_recovery', JSON.stringify(payload));
  }, {
    userId: String(auth.userId),
    treeId: String(auth.treeId),
    pendingPersonId: child.id,
    kin: 'daughter',
    relation: 'child',
    anchorId: Number(auth.personId),
    parentRole: 'father',
    name: '待读孩子',
    phase: 'bind_failed',
    message: '人已记下，关系未保存',
  });
  await page.reload({ waitUntil: 'networkidle0' });
  await waitForNodes(1);
  await installFetchHooks();
  await page.evaluate(() => { window.__yimaiPostPersonCount = 0; });
  await selectNodeByName('读失败锚');
  await page.click('button[data-kin="daughter"]');
  await page.waitForSelector('#form-add:not(.hidden)', { timeout: 5000 });
  await armPersonGetFail(child.id);
  await submitAddForm();
  await sleep(1200);
  const posts = await page.evaluate(() => window.__yimaiPostPersonCount);
  const after = (await personsViaApi()).filter((p) => p.name === '待读孩子');
  const recovery = await readRecovery();
  // Fallback list found the person → bind/display can complete; no second POST;
  // recovery must not have been cleared solely by the failed GET-by-id.
  const ok = posts === 0
    && after.length === 1
    && String(after[0].id) === String(child.id)
    && Number(after[0].father_id) === Number(auth.personId)
    && (recovery == null || String(recovery.pendingPersonId) === String(child.id));
  log(
    'Pending GET-by-id failure falls back to list; no clear/re-add',
    ok,
    `posts=${posts}, id=${after[0]?.id}, father=${after[0]?.father_id}, recovery=${recovery?.pendingPersonId ?? 'cleared-after-success'}`,
  );
}

async function testApiRejectsParentOverwrite() {
  // Direct API check (backend guard), not only UI.
  const auth = phpCreateUser({ withPerson: true, personName: 'API孩子', gender: 'male' });
  const result = await page.evaluate(async (a) => {
    const headers = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${a.token}`,
    };
    const f1 = await fetch('/api/v1/persons', {
      method: 'POST', headers, body: JSON.stringify({ name: 'API父甲', gender: 'male', generation: 1 }),
    }).then((r) => r.json());
    const f2 = await fetch('/api/v1/persons', {
      method: 'POST', headers, body: JSON.stringify({ name: 'API父乙', gender: 'male', generation: 1 }),
    }).then((r) => r.json());
    await fetch(`/api/v1/persons/${a.personId}`, {
      method: 'PATCH', headers, body: JSON.stringify({ father_id: f1.id }),
    });
    const overwrite = await fetch(`/api/v1/persons/${a.personId}`, {
      method: 'PATCH', headers, body: JSON.stringify({ father_id: f2.id }),
    });
    const body = await overwrite.json();
    const show = await fetch(`/api/v1/persons/${a.personId}`, { headers }).then((r) => r.json());
    return { status: overwrite.status, father_id: show.father_id, expect: f1.id, msg: body.message || JSON.stringify(body.errors || {}) };
  }, auth);
  log(
    'API rejects silent father overwrite',
    result.status === 422 && Number(result.father_id) === Number(result.expect),
    `status=${result.status}, father_id=${result.father_id}, msg=${String(result.msg).substring(0, 60)}`,
  );
}

async function testSisterHusbandAndYoungerSisterOps() {
  // Coverage gap close-out: 姐 / 夫 / 妹 within existing small flow.
  await selectNodeByName('测试儿子');
  const son = await personByNameViaApi('测试儿子');
  const before = await personCountViaApi();
  await addKin('elder_sister', '测试姐姐');
  await sleep(700);
  const sister = await personByNameViaApi('测试姐姐');
  await selectNodeByName('测试妻子');
  const wife = await personByNameViaApi('测试妻子');
  await addKin('husband', '测试丈夫');
  await sleep(700);
  const husband = await personByNameViaApi('测试丈夫');
  await selectNodeByName('测试儿子');
  await addKin('younger_sister', '测试妹妹');
  await sleep(700);
  const younger = await personByNameViaApi('测试妹妹');
  const after = await personCountViaApi();
  const snap = await treeSnapshot();
  const sisterSharesParents = sister
    && Number(sister.father_id) === Number(son.father_id)
    && Number(sister.mother_id) === Number(son.mother_id);
  const youngerSharesParents = younger
    && Number(younger.father_id) === Number(son.father_id)
    && Number(younger.mother_id) === Number(son.mother_id);
  const husbandPair = husband && wife
    ? [Number(wife.id), Number(husband.id)].sort((a, b) => a - b).join('-')
    : '';
  const husbandEdge = husbandPair && snap.spouseEdges.includes(husbandPair);
  const ok = after === before + 3
    && sisterSharesParents
    && youngerSharesParents
    && husbandEdge
    && snap.parentEdges.includes(`${son.father_id}->${sister.id}`)
    && snap.parentEdges.includes(`${son.father_id}->${younger.id}`);
  log(
    '姐/妹/夫 operations create exact shared-parent and spouse edges',
    ok,
    `count ${before}->${after}, sisterF=${sister?.father_id}, youngerF=${younger?.father_id}, husbandEdge=${husbandEdge}`,
  );
}

async function testSetRootPerspective() {
  const beforeRoot = await page.evaluate(() => localStorage.getItem('yimai_root_id'));
  await selectNodeByName('测试妻子');
  const wife = await personByNameViaApi('测试妻子');
  await page.click('#btn-set-root');
  await sleep(800);
  const afterRoot = await page.evaluate(() => localStorage.getItem('yimai_root_id'));
  const snap = await treeSnapshot();
  const mark = await page.evaluate(() => {
    const rootCard = document.querySelector('g.node-card.root .person-name');
    return rootCard ? rootCard.textContent : '';
  });
  const ok = String(afterRoot) === String(wife.id)
    && Number(snap.root_id) === Number(wife.id)
    && mark.includes('测试妻子')
    && String(beforeRoot) !== String(afterRoot);
  // Restore original root for later same-root comparisons where useful.
  await selectNodeByName('第一人甲');
  await page.click('#btn-set-root');
  await sleep(500);
  log(
    '从TA看 reroot updates root_id and current-perspective mark',
    ok,
    `root ${beforeRoot}->${afterRoot}, tree.root_id=${snap.root_id}, mark=${mark}`,
  );
}

async function testRelationChangesPersistAfterRefresh() {
  const before = await treeSnapshot();
  await page.click('#btn-reload');
  await sleep(800);
  const mid = await treeSnapshot();
  await page.reload({ waitUntil: 'networkidle0' });
  await sleep(800);
  const after = await treeSnapshot();
  const ok = JSON.stringify(before.nodeIds) === JSON.stringify(mid.nodeIds)
    && JSON.stringify(before.parentEdges) === JSON.stringify(mid.parentEdges)
    && JSON.stringify(before.spouseEdges) === JSON.stringify(mid.spouseEdges)
    && JSON.stringify(before.nodeIds) === JSON.stringify(after.nodeIds)
    && JSON.stringify(before.parentEdges) === JSON.stringify(after.parentEdges)
    && JSON.stringify(before.spouseEdges) === JSON.stringify(after.spouseEdges)
    && before.stats === after.stats
    && after.canvasNodes === after.nodeIds.length;
  log(
    'After relation changes, reload/refresh keep API edges/stats/canvas aligned',
    ok,
    `nodes=${after.nodeIds.length}, parents=${after.parentEdges.length}, spouses=${after.spouseEdges.length}, stats=${after.stats}`,
  );
}

async function runAllTests() {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  console.log('\n一脉 Frontend Regression Tests\n' + '='.repeat(50));
  console.log(`APP_ROOT=${APP_ROOT}`);
  console.log(`BASE_URL=${BASE_URL}`);
  console.log(`ARTIFACTS_DIR=${ARTIFACTS_DIR}`);
  console.log(`EXPECTED_TEST_COUNT=${EXPECTED_TEST_COUNT}`);
  console.log(`startedAt=${startedAt.toISOString()} tz=${tz}`);
  console.log('='.repeat(50));

  const ordered = [
    testPageLoads,
    testLoginButtonClickWorks,
    testTreeRendersAfterLogin,
    testPersonSelection,
    testKinButtonsVisible,
    testKinButtonClickWorks,
    testReloadButtonWorks,
    testPersistedTokenReload,
    testFirstPersonStaleRootAndRefresh,
    testAddChildWithParentRole,
    testAddParent,
    testAddSpouse,
    testAddSiblingWithKnownParent,
    testExistingPersonRecognition,
    testSisterHusbandAndYoungerSisterOps,
    testSetRootPerspective,
    testRelationChangesPersistAfterRefresh,
    testMissingSiblingParentError,
    testPartialCreateBindFailure,
    testPartialRecoverySurvivesRefreshAndRetry,
    testPostSaveLoadFailureRetryStable,
    testRefreshDuringDisplayLoadKeepsIdentity,
    testSiblingMissingParentKeepsRecoveryNotice,
    testLostCreateResponseNoSecondPost,
    testEmptyAccountRealLoginTreeScopeAndLostCreate,
    testSameName422NoAdoptThenValidCreate,
    testSameNameNetworkFailRequiresExplicitChoice,
    testLostResponseSameNameNoAutoSelect,
    testPendingGetFailFallsBackToListWithoutClear,
    testDoubleSubmitDoesNotDuplicate,
    testParentOverwriteBlockedFatherAndMother,
    testIdempotentSameFatherBind,
    testIdempotentSameMotherBind,
    testExistingPersonOccupiedFatherSlotBlocked,
    testApiRejectsParentOverwrite,
  ];

  try {
    await setup();
    for (const fn of ordered) {
      await fn();
    }
  } catch (err) {
    fatalError = err;
    console.error('FATAL suite error (suite aborted):', err);
    results.push({
      test: 'Suite completed without uncaught error',
      passed: false,
      message: String(err?.message || err),
      at: new Date().toISOString(),
    });
  } finally {
    try {
      await teardown();
    } catch (teardownErr) {
      fatalError = fatalError || teardownErr;
      console.error('FATAL teardown error:', teardownErr);
      results.push({
        test: 'Teardown succeeded',
        passed: false,
        message: String(teardownErr?.message || teardownErr),
        at: new Date().toISOString(),
      });
    }
  }

  const passed = results.filter((r) => r.passed).length;
  const total = results.length;
  const expected = EXPECTED_TEST_COUNT;
  const countOk = total === expected;
  const allPassed = passed === total && !fatalError && countOk;
  const endedAt = new Date();

  console.log('\n' + '='.repeat(50));
  console.log(`Results: ${passed}/${total} tests passed`);
  console.log(`Expected count: ${expected} — ${countOk ? 'OK' : 'MISMATCH'}`);
  console.log(`endedAt=${endedAt.toISOString()} durationMs=${endedAt - startedAt}`);
  if (fatalError) console.log(`Fatal error: ${fatalError.message || fatalError}`);

  const evidencePath = path.join(ARTIFACTS_DIR, 'frontend-regression-results.json');
  const payload = {
    passed,
    total,
    expected,
    countOk,
    fatalError: fatalError ? String(fatalError.message || fatalError) : null,
    allPassed,
    results,
    appRoot: APP_ROOT,
    baseUrl: BASE_URL,
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    timezone: tz,
    durationMs: endedAt - startedAt,
  };
  fs.writeFileSync(evidencePath, JSON.stringify(payload, null, 2));
  console.log(`Evidence: ${evidencePath}`);

  if (!countOk) console.log(`\nExpected ${expected} results but got ${total}.`);
  if (passed < total || fatalError) {
    console.log('\nFailed / incomplete:');
    results.filter((r) => !r.passed).forEach((r) => {
      console.log(`  - ${r.test}: ${r.message}`);
    });
  }

  if (!allPassed) process.exit(1);
  process.exit(0);
}

runAllTests();
