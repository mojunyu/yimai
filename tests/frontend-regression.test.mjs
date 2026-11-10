/**
 * Frontend regression tests for 一脉 (Yimai) family tree app.
 *
 * Covers the 71db97f login/loadTree/loadPersons regression and kin workflows.
 *
 * Prerequisites (portable; no app build step):
 *   1. PHP + Composer deps installed; SQLite DB migrated
 *   2. Demo seed on an isolated local DB:  php artisan yimai:demo --fresh
 *   3. App serving same-origin /app/ + /api/v1, default http://localhost:8000
 *   4. npm install  (declares puppeteer in package.json)
 *   5. Chrome/Chromium available:
 *        - set PUPPETEER_EXECUTABLE_PATH, or
 *        - install bundled: npx puppeteer browsers install chrome, or
 *        - have google-chrome / chromium on PATH
 *
 * Run:
 *   BASE_URL=http://localhost:8000 node tests/frontend-regression.test.mjs
 *
 * Env:
 *   BASE_URL                 default http://localhost:8000
 *   PUPPETEER_EXECUTABLE_PATH  optional Chrome/Chromium path
 *   APP_ROOT                 optional Laravel root (default: parent of tests/)
 *   ARTIFACTS_DIR            optional evidence dir (default: ./artifacts)
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

/** Must match results logged by the ordered suite. Aborting early fails the suite. */
const EXPECTED_TEST_COUNT = 19;

let browser;
let page;
const results = [];
let fatalError = null;

function log(test, passed, message = '') {
  const status = passed ? '✓ PASS' : '✗ FAIL';
  console.log(`${status}: ${test}${message ? ' - ' + message : ''}`);
  results.push({ test, passed, message });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function resolveChromePath() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    return process.env.PUPPETEER_EXECUTABLE_PATH;
  }
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
  return undefined; // let puppeteer use its bundled browser
}

function artisanExecute(phpCode) {
  const result = spawnSync(
    'php',
    ['artisan', 'tinker', `--execute=${phpCode}`],
    { cwd: APP_ROOT, encoding: 'utf8' },
  );
  if (result.status !== 0) {
    throw new Error(
      `artisan tinker failed (cwd=${APP_ROOT}): ${result.stdout || ''}${result.stderr || ''}`,
    );
  }
  return (result.stdout || '').trim().split('\n').filter(Boolean).pop();
}

function createIsolatedUser({ withPerson = false, personName = '无父母者' } = {}) {
  const email = `iso${Date.now()}${Math.floor(Math.random() * 1000)}@test.test`;
  if (withPerson) {
    const line = artisanExecute(
      `$u=\\App\\Models\\User::create(['name'=>'Iso','email'=>'${email}','password'=>bcrypt('password')]);` +
        `$t=\\App\\Models\\Tree::create(['owner_user_id'=>$u->id,'title'=>'Iso']);` +
        `$p=\\App\\Models\\Person::create(['tree_id'=>$t->id,'name'=>'${personName}','generation'=>1,'gender'=>'male']);` +
        `echo $u->createToken('test')->plainTextToken.':'.$p->id;`,
    );
    const [token, personId] = line.split(':');
    return { email, token, personId };
  }
  const token = artisanExecute(
    `$u=\\App\\Models\\User::create(['name'=>'Iso','email'=>'${email}','password'=>bcrypt('password')]);` +
      `\\App\\Models\\Tree::create(['owner_user_id'=>$u->id,'title'=>'Iso']);` +
      `echo $u->createToken('test')->plainTextToken;`,
  );
  return { email, token, personId: null };
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

async function addKin(kinKey, name) {
  await page.click(`button[data-kin="${kinKey}"]`);
  await page.waitForSelector('#form-add:not(.hidden)', { timeout: 5000 });
  await page.$eval('#add-name', (el) => { el.value = ''; });
  await page.type('#add-name', name);
  await page.click('#form-add button[type="submit"]');
}

async function nodeNames() {
  return page.$$eval('g.node-card .person-name', (els) => els.map((e) => e.textContent));
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

async function personByNameViaApi(name) {
  return page.evaluate(async (target) => {
    const token = localStorage.getItem('yimai_token');
    const res = await fetch(`${window.location.origin}/api/v1/persons`, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
    });
    const body = await res.json();
    return (body.data || []).find((p) => p.name === target) || null;
  }, name);
}

async function installBindFailHook() {
  await page.evaluate(() => {
    if (window.__yimaiOrigFetch) return;
    window.__yimaiOrigFetch = window.fetch.bind(window);
    window.__yimaiFailNextBind = false;
    window.fetch = async (input, init = {}) => {
      const url = String(input);
      const method = (init.method || 'GET').toUpperCase();
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
  await firstNode.click();
  await page.waitForSelector('#sheet:not(.hidden)', { timeout: 5000 });
  const sheetVisible = await page.$eval('#sheet', (el) => !el.classList.contains('hidden'));
  const summaryVisible = await page.$eval('#sheet-summary', (el) => !el.classList.contains('hidden'));
  log('Person selection opens sheet', sheetVisible && summaryVisible);
}

async function testKinButtonsVisible() {
  const kinButtons = await page.$$('#kin-grid button[data-kin]');
  log(
    'Kin buttons visible (父母哥姐弟妹儿女夫妻)',
    kinButtons.length === 10,
    `Found ${kinButtons.length} kin buttons`,
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

async function testFirstPersonForEmptyTree() {
  const { token } = createIsolatedUser();
  await page.evaluate((t) => {
    localStorage.setItem('yimai_token', t);
    localStorage.removeItem('yimai_root_id');
  }, token);
  await page.reload({ waitUntil: 'networkidle0' });
  await sleep(300);
  await page.click('#btn-add');
  await page.waitForSelector('#form-add:not(.hidden)', { timeout: 5000 });
  const contextText = await page.$eval('#add-context', (el) => el.textContent);
  const sheetTitle = await page.$eval('#sheet-title', (el) => el.textContent);
  log(
    'First person form for empty tree',
    contextText.includes('还没有记下亲人') && sheetTitle === '第一位家人',
    `Title: ${sheetTitle}`,
  );
}

async function testAddFirstPerson() {
  await page.type('#add-name', '测试祖先');
  await page.click('#form-add button[type="submit"]');
  await waitForNodes(1);
  const nodes = await page.$$('g.node-card');
  log('Add first person creates node', nodes.length > 0, `Created ${nodes.length} node(s)`);
}

async function testAddChild() {
  await selectNodeByName('测试祖先');
  const before = await personCountViaApi();
  await addKin('son', '测试儿子');
  await waitForNodes(2);
  const after = await personCountViaApi();
  const son = await personByNameViaApi('测试儿子');
  const ok = after === before + 1 && son && (son.father_id != null || son.mother_id != null);
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
    `count ${before}->${after}, child.mother_id=${child?.mother_id}, mother.id=${mother?.id}`,
  );
}

async function testAddSpouse() {
  await selectNodeByName('测试祖先');
  const before = await personCountViaApi();
  await addKin('wife', '测试妻子');
  await page.waitForFunction(
    () => document.querySelectorAll('g.node-card').length >= 4
      || document.getElementById('sheet-title')?.textContent === '测试妻子',
    { timeout: 10000 },
  );
  await sleep(400);
  const after = await personCountViaApi();
  const names = await nodeNames();
  // spouse edge comes only from tree JSON — check tree edge count via page state if exposed
  const spouseEdges = await page.evaluate(async () => {
    const token = localStorage.getItem('yimai_token');
    const root = localStorage.getItem('yimai_root_id');
    const res = await fetch(`${window.location.origin}/api/v1/persons/${root}/tree`, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
    });
    const tree = await res.json();
    return (tree.edges || []).filter((e) => e.type === 'spouse').length;
  });
  const ok = after === before + 1 && names.includes('测试妻子') && spouseEdges >= 1;
  log(
    'Add spouse (wife) works',
    ok,
    `count ${before}->${after}, spouseEdges=${spouseEdges}, hasName=${names.includes('测试妻子')}`,
  );
}

async function testAddSiblingWithKnownParent() {
  // 测试儿子 already has mother 测试母亲
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
  const ok = after === before + 1
    && bro
    && Number(bro.mother_id) === Number(son.mother_id)
    && (son.father_id == null || Number(bro.father_id) === Number(son.father_id));
  log(
    'Add sibling with known parent works',
    ok,
    `count ${before}->${after}, son.mother=${son?.mother_id}, bro.mother=${bro?.mother_id}`,
  );
}

async function testExistingPersonRecognition() {
  // Recognize existing 测试妻子 as spouse of 测试儿子? Better: bind existing mother already? 
  // Use: select 测试弟弟, add mother by choosing existing 测试母亲 from dropdown.
  await selectNodeByName('测试弟弟');
  // Clear mother first would be invasive; instead add father via existing 测试祖先
  const before = await personCountViaApi();
  await page.click('button[data-kin="father"]');
  await page.waitForSelector('#form-add:not(.hidden)', { timeout: 5000 });
  const wrapVisible = await page.$eval('#add-existing-wrap', (el) => !el.classList.contains('hidden'));
  if (!wrapVisible) {
    log('Existing-person recognition works', false, 'add-existing wrap hidden');
    return;
  }
  // Select 测试祖先 from dropdown
  const selected = await page.evaluate(() => {
    const sel = document.getElementById('add-existing');
    const opt = Array.from(sel.options).find((o) => o.textContent.includes('测试祖先'));
    if (!opt) return null;
    sel.value = opt.value;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return opt.value;
  });
  if (!selected) {
    log('Existing-person recognition works', false, '测试祖先 not in existing dropdown');
    return;
  }
  await page.click('#form-add button[type="submit"]');
  await sleep(800);
  const after = await personCountViaApi();
  const bro = await personByNameViaApi('测试弟弟');
  const ancestor = await personByNameViaApi('测试祖先');
  const ok = after === before
    && bro
    && ancestor
    && Number(bro.father_id) === Number(ancestor.id);
  log(
    'Existing-person recognition works',
    ok,
    `count ${before}->${after} (no new person), bro.father_id=${bro?.father_id}`,
  );
}

async function testMissingSiblingParentError() {
  const { token, personId } = createIsolatedUser({ withPerson: true, personName: '无父母者' });
  await page.evaluate((t, id) => {
    localStorage.setItem('yimai_token', t);
    localStorage.setItem('yimai_root_id', id);
  }, token, personId);
  await page.reload({ waitUntil: 'networkidle0' });
  await waitForNodes(1);
  await selectNodeByName('无父母者');
  await page.click('button[data-kin="elder_brother"]');
  await page.waitForSelector('#sheet-error:not(.hidden)', { timeout: 5000 });
  const errorText = await page.$eval('#sheet-error', (el) => el.textContent);
  log(
    'Missing sibling parent shows error',
    errorText.includes('父亲或母亲'),
    `Error: ${errorText.substring(0, 50)}`,
  );
}

/** Shared state between partial-bind message and naive-retry checks. */
let partialBindCtx = null;

async function testPartialCreateBindFailure() {
  // Fresh isolated tree with one person so child create+bind can fail on bind
  const { token, personId } = createIsolatedUser({ withPerson: true, personName: '锚点人' });
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

  // Give the UI a moment; openSheet() after bind failure currently clears #add-error.
  await sleep(800);
  const errVisible = await page.$eval('#add-error', (el) => !el.classList.contains('hidden'));
  const err = await page.$eval('#add-error', (el) => el.textContent);
  const afterFail = await personCountViaApi();
  const child = await personByNameViaApi('半成儿子');
  const createdUnbound = afterFail === before + 1 && child && child.father_id == null && child.mother_id == null;
  const partialMsg = errVisible
    && err.includes('人已经记下了')
    && err.includes('亲疏关系没有保存');
  partialBindCtx = { afterFail };
  log(
    'Partial create/bind shows partial-save message',
    partialMsg && createdUnbound,
    partialMsg
      ? `msg="${err.substring(0, 60)}", count ${before}->${afterFail}, unbound=${createdUnbound}`
      : `create unbound=${createdUnbound} count ${before}->${afterFail}; visible msg="${err}" `
        + '(inherited: submitAdd sets #add-error then openSheet clears it)',
  );
}

async function testNaiveRetryAfterPartialBind() {
  if (!partialBindCtx) {
    log('Naive retry after partial bind does not duplicate person', false, 'prior partial-bind test did not set context');
    return;
  }
  const beforeRetry = partialBindCtx.afterFail;

  // After partial failure, submitAdd opens the created person sheet and hides the form.
  // Naive retry: reopen add-son with the same name and submit again.
  await selectNodeByName('锚点人');
  await page.click('button[data-kin="son"]');
  await page.waitForSelector('#form-add:not(.hidden)', { timeout: 5000 });
  await page.$eval('#add-name', (el) => { el.value = ''; });
  await page.type('#add-name', '半成儿子');
  await page.click('#form-add button[type="submit"]');
  await sleep(1000);

  const afterRetry = await personCountViaApi();
  const sameNameCount = await page.evaluate(async () => {
    const token = localStorage.getItem('yimai_token');
    const res = await fetch(`${window.location.origin}/api/v1/persons`, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
    });
    const body = await res.json();
    return (body.data || []).filter((p) => p.name === '半成儿子').length;
  });
  const noDuplicate = afterRetry === beforeRetry && sameNameCount === 1;
  log(
    'Naive retry after partial bind does not duplicate person',
    noDuplicate,
    `count ${beforeRetry}->${afterRetry}, same-name count=${sameNameCount}`
      + (noDuplicate ? '' : ' (inherited: submitAdd creates again on retry)'),
  );
}

async function testParentOverwriteBehavior() {
  // Document actual bindPerson/API behavior: PATCH overwrites existing father_id.
  const { token, personId } = createIsolatedUser({ withPerson: true, personName: '孩子甲' });
  await page.evaluate((t, id) => {
    localStorage.setItem('yimai_token', t);
    localStorage.setItem('yimai_root_id', id);
  }, token, personId);
  await page.reload({ waitUntil: 'networkidle0' });
  await waitForNodes(1);
  await selectNodeByName('孩子甲');

  await addKin('father', '父亲甲');
  await sleep(600);
  const afterFirst = await personByNameViaApi('孩子甲');
  const fatherA = await personByNameViaApi('父亲甲');

  await selectNodeByName('孩子甲');
  await addKin('father', '父亲乙');
  await sleep(600);
  const afterSecond = await personByNameViaApi('孩子甲');
  const fatherB = await personByNameViaApi('父亲乙');

  const overwrote = fatherA
    && fatherB
    && Number(afterFirst.father_id) === Number(fatherA.id)
    && Number(afterSecond.father_id) === Number(fatherB.id)
    && Number(afterSecond.father_id) !== Number(fatherA.id);

  // This is observational: pass if we correctly observed overwrite (current code does overwrite).
  // Label makes clear we are asserting observed behavior, not a protection guarantee.
  log(
    'Observed: adding second father overwrites father_id (no frontend guard)',
    overwrote,
    `father_id ${afterFirst?.father_id}->${afterSecond?.father_id} (A=${fatherA?.id}, B=${fatherB?.id})`,
  );
}

async function runAllTests() {
  console.log('\n一脉 Frontend Regression Tests\n' + '='.repeat(50));
  console.log(`APP_ROOT=${APP_ROOT}`);
  console.log(`BASE_URL=${BASE_URL}`);
  console.log(`ARTIFACTS_DIR=${ARTIFACTS_DIR}`);
  console.log(`EXPECTED_TEST_COUNT=${EXPECTED_TEST_COUNT}`);
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
    testFirstPersonForEmptyTree,
    testAddFirstPerson,
    testAddChild,
    testAddParent,
    testAddSpouse,
    testAddSiblingWithKnownParent,
    testExistingPersonRecognition,
    testMissingSiblingParentError,
    testPartialCreateBindFailure,
    testNaiveRetryAfterPartialBind,
    testParentOverwriteBehavior,
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
      });
    }
  }

  const passed = results.filter((r) => r.passed).length;
  const total = results.length;
  const countOk = total === EXPECTED_TEST_COUNT;
  const allPassed = passed === total && !fatalError && countOk;

  console.log('\n' + '='.repeat(50));
  console.log(`Results: ${passed}/${total} tests passed`);
  console.log(`Expected count: ${EXPECTED_TEST_COUNT} — ${countOk ? 'OK' : 'MISMATCH'}`);
  if (fatalError) console.log(`Fatal error: ${fatalError.message || fatalError}`);

  const evidencePath = path.join(ARTIFACTS_DIR, 'frontend-regression-results.json');
  fs.writeFileSync(
    evidencePath,
    JSON.stringify(
      {
        passed,
        total,
        expected: EXPECTED_TEST_COUNT,
        countOk,
        fatalError: fatalError ? String(fatalError.message || fatalError) : null,
        allPassed,
        results,
        appRoot: APP_ROOT,
        baseUrl: BASE_URL,
        at: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  console.log(`Evidence: ${evidencePath}`);

  if (!countOk) {
    console.log(`\nExpected ${EXPECTED_TEST_COUNT} results but got ${total}.`);
  }
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
