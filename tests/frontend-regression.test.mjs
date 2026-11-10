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
const EXPECTED_TEST_COUNT = 20;

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
echo $u->createToken('test')->plainTextToken.':'.$p->id;
`
    : `<?php
require '${APP_ROOT}/vendor/autoload.php';
$app = require '${APP_ROOT}/bootstrap/app.php';
$app->make(Illuminate\\Contracts\\Console\\Kernel::class)->bootstrap();
$u = App\\Models\\User::create(['name'=>'Iso','email'=>'${email}','password'=>bcrypt('password')]);
App\\Models\\Tree::create(['owner_user_id'=>$u->id,'title'=>'Iso']);
echo $u->createToken('test')->plainTextToken;
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
  if (withPerson) {
    const [token, personId] = line.split(':');
    return { email, token, personId };
  }
  return { email, token: line, personId: null };
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

async function installBindFailHook() {
  await page.evaluate(() => {
    if (window.__yimaiOrigFetch) return;
    window.__yimaiOrigFetch = window.fetch.bind(window);
    window.__yimaiFailNextBind = false;
    window.__yimaiPostPersonCount = 0;
    window.fetch = async (input, init = {}) => {
      const url = String(input);
      const method = (init.method || 'GET').toUpperCase();
      if (method === 'POST' && /\/api\/v1\/persons\/?$/.test(url.replace(/\?.*$/, ''))) {
        window.__yimaiPostPersonCount += 1;
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
      return window.__yimaiOrigFetch(input, init);
    };
  });
}

async function armBindFail() {
  await page.evaluate(() => { window.__yimaiFailNextBind = true; });
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
  const anchorLabel = await page.$eval('#add-anchor-label', (el) => el.textContent).catch(() => '');
  log(
    'Kin buttons visible (父母哥姐弟妹儿女夫妻)',
    kinButtons.length === 10,
    `Found ${kinButtons.length}; anchorLabel="${anchorLabel}"`,
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
  await page.reload({ waitUntil: 'networkidle0' });
  await page.waitForFunction(() => {
    const stats = document.getElementById('stats');
    return stats && stats.textContent.includes('位亲人');
  }, { timeout: 10000 });
  const tokenAfter = await page.evaluate(() => localStorage.getItem('yimai_token'));
  const nodes = await page.$$('g.node-card');
  log(
    'Persisted token reload renders tree',
    tokenBefore === tokenAfter && nodes.length > 0,
    `Token persisted: ${tokenBefore === tokenAfter}, Nodes: ${nodes.length}`,
  );
}

async function testFirstPersonStaleRootAndRefresh() {
  const { token } = phpCreateUser();
  await page.evaluate((t) => {
    localStorage.setItem('yimai_token', t);
    localStorage.setItem('yimai_root_id', '1'); // stale foreign id
  }, token);
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
  await page.click('#btn-reload');
  await waitForNodes(1);
  const afterReload = await personsViaApi();
  const nodes = await page.$$('g.node-card');
  const ok = rootAfterBoot !== '1'
    && nodes.length === 1
    && beforeReload.length === 1
    && afterReload.length === 1
    && String(rootAfterAdd) === String(beforeReload[0].id)
    && String(afterReload[0].id) === String(beforeReload[0].id);
  log(
    'First person with stale rootId appears and persists on reload',
    ok,
    `bootRoot=${rootAfterBoot}, rootAfterAdd=${rootAfterAdd}, ids=${beforeReload[0]?.id}->${afterReload[0]?.id}, nodes=${nodes.length}`,
  );
}

async function testAddChildWithParentRole() {
  await selectNodeByName('第一人甲');
  const before = await personCountViaApi();
  await addKin('son', '测试儿子', { parentRole: 'father' });
  await waitForNodes(2);
  const after = await personCountViaApi();
  const son = await personByNameViaApi('测试儿子');
  const ok = after === before + 1 && son && Number(son.father_id) != null;
  log('Add child works', ok, `count ${before}->${after}, son.father_id=${son?.father_id}`);
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
  await addKin('wife', '测试妻子');
  await page.waitForFunction(
    () => document.querySelectorAll('g.node-card').length >= 4
      || document.getElementById('sheet-title')?.textContent === '测试妻子',
    { timeout: 10000 },
  );
  await sleep(400);
  const after = await personCountViaApi();
  const spouseEdges = await page.evaluate(async () => {
    const token = localStorage.getItem('yimai_token');
    const root = localStorage.getItem('yimai_root_id');
    const res = await fetch(`${window.location.origin}/api/v1/persons/${root}/tree`, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
    });
    const tree = await res.json();
    return (tree.edges || []).filter((e) => e.type === 'spouse').length;
  });
  log(
    'Add spouse (wife) works',
    after === before + 1 && spouseEdges >= 1,
    `count ${before}->${after}, spouseEdges=${spouseEdges}`,
  );
}

async function testAddSiblingWithKnownParent() {
  await selectNodeByName('测试儿子');
  const before = await personCountViaApi();
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
  const ok = after === before + 1 && bro && Number(bro.mother_id) === Number(son.mother_id);
  log(
    'Add sibling with known parent works',
    ok,
    `count ${before}->${after}, son.mother=${son?.mother_id}, bro.mother=${bro?.mother_id}`,
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
  const { token, personId } = phpCreateUser({ withPerson: true, personName: '无父母者' });
  await page.evaluate((t, id) => {
    localStorage.setItem('yimai_token', t);
    localStorage.setItem('yimai_root_id', id);
  }, token, personId);
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
  const { token, personId } = phpCreateUser({ withPerson: true, personName: '锚点人', gender: 'male' });
  await page.evaluate((t, id) => {
    localStorage.setItem('yimai_token', t);
    localStorage.setItem('yimai_root_id', id);
  }, token, personId);
  await page.reload({ waitUntil: 'networkidle0' });
  await waitForNodes(1);
  await selectNodeByName('锚点人');
  await installBindFailHook();

  const before = await personCountViaApi();
  await page.click('button[data-kin="son"]');
  await page.waitForSelector('#form-add:not(.hidden)', { timeout: 5000 });
  await page.type('#add-name', '半成儿子');
  await armBindFail();
  await page.click('#form-add button[type="submit"]');
  await page.waitForSelector('#add-error:not(.hidden)', { timeout: 10000 });
  await sleep(300);
  const err = await page.$eval('#add-error', (el) => el.textContent);
  const errVisible = await page.$eval('#add-error', (el) => !el.classList.contains('hidden'));
  const formOpen = await page.$eval('#form-add', (el) => !el.classList.contains('hidden'));
  const afterFail = await personCountViaApi();
  const child = await personByNameViaApi('半成儿子');
  const posts = await page.evaluate(() => window.__yimaiPostPersonCount);
  const ok = errVisible
    && err.includes('人已记下，关系未保存')
    && formOpen
    && afterFail === before + 1
    && child
    && child.father_id == null
    && posts === 1;
  partialBindCtx = { afterFail, childId: child?.id, posts };
  log(
    'Partial create/bind shows persistent partial-save message',
    ok,
    `msg="${err.substring(0, 50)}", count ${before}->${afterFail}, posts=${posts}, formOpen=${formOpen}`,
  );
}

async function testNaiveRetryReusesCreatedId() {
  if (!partialBindCtx?.childId) {
    log('Naive retry reuses created id without duplicate POST', false, 'no partial-bind context');
    return;
  }
  const beforeRetry = await personCountViaApi();
  const postsBefore = await page.evaluate(() => window.__yimaiPostPersonCount);
  // Form should still be open with pendingPersonId; submit again WITHOUT arming bind fail.
  const formOpen = await page.$eval('#form-add', (el) => !el.classList.contains('hidden'));
  if (!formOpen) {
    await selectNodeByName('锚点人');
    await page.click('button[data-kin="son"]');
    await page.waitForSelector('#form-add:not(.hidden)', { timeout: 5000 });
  }
  await page.click('#form-add button[type="submit"]');
  await sleep(1200);
  const afterRetry = await personCountViaApi();
  const postsAfter = await page.evaluate(() => window.__yimaiPostPersonCount);
  const sameName = (await personsViaApi()).filter((p) => p.name === '半成儿子');
  const child = sameName[0];
  const ok = afterRetry === beforeRetry
    && sameName.length === 1
    && String(child.id) === String(partialBindCtx.childId)
    && postsAfter === postsBefore
    && child.father_id != null;
  // Also verify refresh keeps same id
  await page.reload({ waitUntil: 'networkidle0' });
  await sleep(600);
  const afterRefresh = (await personsViaApi()).filter((p) => p.name === '半成儿子');
  const refreshOk = afterRefresh.length === 1 && String(afterRefresh[0].id) === String(partialBindCtx.childId);
  log(
    'Naive retry reuses created id without duplicate POST',
    ok && refreshOk,
    `count ${beforeRetry}->${afterRetry}, posts ${postsBefore}->${postsAfter}, id=${child?.id}, refreshId=${afterRefresh[0]?.id}`,
  );
}

async function testDoubleSubmitDoesNotDuplicate() {
  const { token, personId } = phpCreateUser({ withPerson: true, personName: '双击锚点', gender: 'male' });
  await page.evaluate((t, id) => {
    localStorage.setItem('yimai_token', t);
    localStorage.setItem('yimai_root_id', id);
  }, token, personId);
  await page.reload({ waitUntil: 'networkidle0' });
  await waitForNodes(1);
  await selectNodeByName('双击锚点');
  await installBindFailHook(); // for post counter
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

async function testParentOverwriteBlocked() {
  const { token, personId } = phpCreateUser({ withPerson: true, personName: '孩子甲', gender: 'male' });
  await page.evaluate((t, id) => {
    localStorage.setItem('yimai_token', t);
    localStorage.setItem('yimai_root_id', id);
  }, token, personId);
  await page.reload({ waitUntil: 'networkidle0' });
  await waitForNodes(1);
  await selectNodeByName('孩子甲');
  await addKin('father', '父亲甲');
  await sleep(700);
  const afterFirst = await personByNameViaApi('孩子甲');
  const fatherA = await personByNameViaApi('父亲甲');
  const countAfterFirst = await personCountViaApi();

  await selectNodeByName('孩子甲');
  await page.click('button[data-kin="father"]');
  await page.waitForSelector('#form-add:not(.hidden)', { timeout: 5000 });
  await page.type('#add-name', '父亲乙');
  await page.click('#form-add button[type="submit"]');
  await sleep(800);
  const err = await page.$eval('#add-error', (el) => el.textContent);
  const errVisible = await page.$eval('#add-error', (el) => !el.classList.contains('hidden'));
  const afterSecond = await personByNameViaApi('孩子甲');
  const fatherB = await personByNameViaApi('父亲乙');
  const countAfterSecond = await personCountViaApi();
  const blocked = errVisible
    && err.includes('已经记过父亲')
    && Number(afterSecond.father_id) === Number(fatherA.id)
    && !fatherB
    && countAfterSecond === countAfterFirst;
  log(
    'Parent overwrite blocked before creating another person',
    blocked,
    `father_id stays ${afterFirst?.father_id}->${afterSecond?.father_id}; count ${countAfterFirst}->${countAfterSecond}; err="${err.substring(0, 40)}"`,
  );
}

async function testIdempotentSameFatherBind() {
  // Re-bind same existing father should succeed without error / without changing id.
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
    testMissingSiblingParentError,
    testPartialCreateBindFailure,
    testNaiveRetryReusesCreatedId,
    testDoubleSubmitDoesNotDuplicate,
    testParentOverwriteBlocked,
    testIdempotentSameFatherBind,
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
