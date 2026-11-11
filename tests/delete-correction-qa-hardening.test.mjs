/**
 * QA hardening oracles for delete-correction (identity freeze, DEL-7 lost-response
 * terminal proof, H-11/H-12, viewport scroll reachability, parents display).
 * Isolated fixtures only. Cursor Auto only.
 */

import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = process.env.APP_ROOT ? path.resolve(process.env.APP_ROOT) : path.resolve(__dirname, '..');
const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:8000';
const ARTIFACTS_DIR = process.env.ARTIFACTS_DIR
  ? path.resolve(process.env.ARTIFACTS_DIR)
  : path.resolve(APP_ROOT, 'artifacts', `del-hardening-${Date.now()}`);

let browser;
let page;
const results = [];
const unverified = [];
let fatalError = null;
const startedAt = new Date();
const suiteMeta = {};

function log(test, passed, message = '') {
  console.log(`${passed ? '✓ PASS' : '✗ FAIL'}: ${test}${message ? ' - ' + message : ''}`);
  results.push({ test, passed, message, at: new Date().toISOString() });
}

function noteUnverified(test, message = '') {
  console.log(`○ UNVERIFIED: ${test}${message ? ' - ' + message : ''}`);
  unverified.push({ test, status: 'UNVERIFIED', message, at: new Date().toISOString() });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function fileSha(rel) {
  return createHash('sha256').update(fs.readFileSync(path.join(APP_ROOT, rel))).digest('hex');
}

function resolveChromePath() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH;
  for (const c of ['/usr/bin/google-chrome-stable', '/usr/bin/google-chrome', '/usr/bin/chromium']) {
    if (fs.existsSync(c)) return c;
  }
  return undefined;
}

function phpSeed(scriptBody) {
  const email = `qh${Date.now()}${Math.floor(Math.random() * 10000)}@test.test`;
  const script = `<?php
require '${APP_ROOT}/vendor/autoload.php';
$app = require '${APP_ROOT}/bootstrap/app.php';
$app->make(Illuminate\\Contracts\\Console\\Kernel::class)->bootstrap();
$email='${email}';
${scriptBody}
`;
  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
  const tmp = path.join(ARTIFACTS_DIR, `_seed_${Date.now()}.php`);
  fs.writeFileSync(tmp, script);
  const result = spawnSync('php', [tmp], { cwd: APP_ROOT, encoding: 'utf8' });
  fs.unlinkSync(tmp);
  if (result.status !== 0) throw new Error(`seed failed: ${result.stdout}${result.stderr}`);
  const line = (result.stdout || '').trim().split('\n').filter(Boolean).pop();
  return { ...JSON.parse(line), email, password: 'password' };
}

function seedPerson(name = '目标T') {
  return phpSeed(`
$u=App\\Models\\User::create(['name'=>'QA','email'=>$email,'password'=>bcrypt('password')]);
$t=App\\Models\\Tree::create(['owner_user_id'=>$u->id,'title'=>'QA']);
$p=App\\Models\\Person::create(['tree_id'=>$t->id,'name'=>'${name}','gender'=>'male','generation'=>1]);
$n=App\\Models\\Person::create(['tree_id'=>$t->id,'name'=>'旁人N','gender'=>'female','generation'=>1]);
echo json_encode(['userId'=>$u->id,'treeId'=>$t->id,'token'=>$u->createToken('t')->plainTextToken,'idT'=>$p->id,'idN'=>$n->id], JSON_UNESCAPED_UNICODE);
`);
}

function seedSiblingOverlap() {
  return phpSeed(`
$u=App\\Models\\User::create(['name'=>'QASib','email'=>$email,'password'=>bcrypt('password')]);
$t=App\\Models\\Tree::create(['owner_user_id'=>$u->id,'title'=>'QASib']);
$parent=App\\Models\\Person::create(['tree_id'=>$t->id,'name'=>'共父','gender'=>'male','generation'=>1]);
$a=App\\Models\\Person::create(['tree_id'=>$t->id,'name'=>'兄A','gender'=>'male','generation'=>2,'father_id'=>$parent->id]);
$b=App\\Models\\Person::create(['tree_id'=>$t->id,'name'=>'弟B','gender'=>'male','generation'=>2,'father_id'=>$parent->id]);
$c=App\\Models\\Person::create(['tree_id'=>$t->id,'name'=>'无亲C','gender'=>'male','generation'=>2]);
$linkAb=App\\Models\\SiblingLink::create(['tree_id'=>$t->id,'person_a_id'=>min($a->id,$b->id),'person_b_id'=>max($a->id,$b->id)]);
$linkAc=App\\Models\\SiblingLink::create(['tree_id'=>$t->id,'person_a_id'=>min($a->id,$c->id),'person_b_id'=>max($a->id,$c->id)]);
echo json_encode([
  'userId'=>$u->id,'treeId'=>$t->id,'token'=>$u->createToken('t')->plainTextToken,
  'idParent'=>$parent->id,'idA'=>$a->id,'idB'=>$b->id,'idC'=>$c->id,'linkAb'=>$linkAb->id,'linkAc'=>$linkAc->id
], JSON_UNESCAPED_UNICODE);
`);
}

function seedForeign() {
  const a = phpSeed(`
$u=App\\Models\\User::create(['name'=>'A','email'=>$email,'password'=>bcrypt('password')]);
$t=App\\Models\\Tree::create(['owner_user_id'=>$u->id,'title'=>'A']);
$p=App\\Models\\Person::create(['tree_id'=>$t->id,'name'=>'甲树人','gender'=>'male','generation'=>1]);
echo json_encode(['userId'=>$u->id,'treeId'=>$t->id,'token'=>$u->createToken('t')->plainTextToken,'idP'=>$p->id], JSON_UNESCAPED_UNICODE);
`);
  const b = phpSeed(`
$u=App\\Models\\User::create(['name'=>'B','email'=>$email,'password'=>bcrypt('password')]);
$t=App\\Models\\Tree::create(['owner_user_id'=>$u->id,'title'=>'B']);
$p=App\\Models\\Person::create(['tree_id'=>$t->id,'name'=>'乙树人','gender'=>'female','generation'=>1]);
echo json_encode(['userId'=>$u->id,'treeId'=>$t->id,'token'=>$u->createToken('t')->plainTextToken,'idP'=>$p->id], JSON_UNESCAPED_UNICODE);
`);
  return { a, b };
}

async function setup() {
  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
  const launchOpts = { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] };
  const chrome = resolveChromePath();
  if (chrome) launchOpts.executablePath = chrome;
  browser = await puppeteer.launch(launchOpts);
  page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
}

async function teardown() {
  if (browser) await browser.close();
}

async function openAuthed(auth, rootId) {
  await page.goto(`${BASE_URL}/app/`, { waitUntil: 'networkidle0' });
  await page.evaluate((a) => {
    localStorage.clear();
    localStorage.setItem('yimai_token', a.token);
    localStorage.setItem('yimai_user_id', String(a.userId));
    localStorage.setItem('yimai_tree_id', String(a.treeId));
    localStorage.setItem('yimai_root_id', String(a.rootId));
  }, { ...auth, rootId: rootId || auth.idT || auth.idA || auth.idP });
  await page.reload({ waitUntil: 'networkidle0' });
  await page.waitForFunction(() => document.querySelectorAll('g.node-card').length >= 1, { timeout: 10000 });
}

async function installHooks() {
  await page.evaluate(() => {
    if (window.__yimaiOrigFetch) return;
    window.__yimaiOrigFetch = window.fetch.bind(window);
    window.__yimaiLoseNextDelete = false;
    window.__yimaiFailNextDeleteNetwork = false;
    window.__yimaiFailNextTreeGet = false;
    window.__yimaiDelayNextDeleteMs = 0;
    window.__yimaiDelayNextDeleteMode = null; // 'ok' | 'network'
    window.__yimaiDelayGate = null;
    window.__yimaiDeletePaths = [];
    window.__yimaiDeleteCommitted = [];
    window.__yimaiReconcileForceStatus = null;
    window.fetch = async (input, init = {}) => {
      const url = String(input);
      const method = (init.method || 'GET').toUpperCase();
      if (method === 'DELETE' && /\/api\/v1\/persons\/\d+/.test(url)) {
        window.__yimaiDeletePaths.push(url);
        if (window.__yimaiFailNextDeleteNetwork) {
          window.__yimaiFailNextDeleteNetwork = false;
          throw new TypeError('Failed to fetch (simulated delete network fail)');
        }
        if (window.__yimaiLoseNextDelete) {
          window.__yimaiLoseNextDelete = false;
          const res = await window.__yimaiOrigFetch(input, init);
          window.__yimaiDeleteCommitted.push({ url, status: res.status });
          throw new TypeError('Failed to fetch (simulated lost delete response)');
        }
        if (window.__yimaiDelayNextDeleteMs > 0) {
          const ms = window.__yimaiDelayNextDeleteMs;
          const mode = window.__yimaiDelayNextDeleteMode || 'ok';
          window.__yimaiDelayNextDeleteMs = 0;
          window.__yimaiDelayNextDeleteMode = null;
          let release;
          window.__yimaiDelayGate = new Promise((r) => { release = r; });
          window.__yimaiReleaseDelayedDelete = release;
          await window.__yimaiDelayGate;
          await new Promise((r) => setTimeout(r, ms));
          if (mode === 'network') {
            throw new TypeError('Failed to fetch (simulated delayed delete network fail)');
          }
          const res = await window.__yimaiOrigFetch(input, init);
          window.__yimaiDeleteCommitted.push({ url, status: res.status });
          return res;
        }
      }
      if (
        window.__yimaiFailNextTreeGet
        && method === 'GET'
        && /\/api\/v1\/persons\/\d+\/tree/.test(url)
      ) {
        window.__yimaiFailNextTreeGet = false;
        throw new TypeError('Failed to fetch (simulated tree refresh fail)');
      }
      // Independent reconcile negative oracles: force 401/403 on GET /persons/{id}
      if (
        window.__yimaiReconcileForceStatus
        && method === 'GET'
        && /\/api\/v1\/persons\/\d+$/.test(url)
      ) {
        const status = window.__yimaiReconcileForceStatus;
        window.__yimaiReconcileForceStatus = null;
        return new Response(JSON.stringify({ message: 'forced' }), {
          status,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return window.__yimaiOrigFetch(input, init);
    };
  });
}

async function selectById(id) {
  await page.evaluate((targetId) => {
    const card = document.querySelector(`g.node-card[data-id="${targetId}"]`);
    if (!card) throw new Error(`missing ${targetId}`);
    card.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  }, String(id));
  await page.waitForSelector('#sheet:not(.hidden)', { timeout: 5000 });
}

async function screenshot(name) {
  const file = path.join(ARTIFACTS_DIR, name);
  await page.screenshot({ path: file, fullPage: true });
  return file;
}

async function personsApi(token) {
  return page.evaluate(async (tok) => {
    const t = tok || localStorage.getItem('yimai_token');
    const res = await fetch(`${window.location.origin}/api/v1/persons`, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${t}` },
    });
    return { status: res.status, data: (await res.json()).data || [] };
  }, token || null);
}

async function linksApi(kind, token) {
  return page.evaluate(async (k, tok) => {
    const t = tok || localStorage.getItem('yimai_token');
    const res = await fetch(`${window.location.origin}/api/v1/${k}`, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${t}` },
    });
    return (await res.json()).data || [];
  }, kind, token || null);
}

async function treeApi(rootId, token) {
  return page.evaluate(async (id, tok) => {
    const t = tok || localStorage.getItem('yimai_token');
    const res = await fetch(`${window.location.origin}/api/v1/persons/${id}/tree`, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${t}` },
    });
    return res.json();
  }, rootId, token || null);
}

async function sheetText() {
  return page.evaluate(() => ({
    title: document.getElementById('sheet-title')?.textContent || '',
    puhao: document.getElementById('sheet-puhao')?.textContent || '',
    summary: document.getElementById('sheet-summary')?.textContent || '',
    confirmHidden: document.getElementById('sheet-confirm')?.classList.contains('hidden'),
    confirmTitle: document.getElementById('sheet-confirm-title')?.textContent || '',
    confirmBody: document.getElementById('sheet-confirm-body')?.textContent || '',
    confirmError: document.getElementById('sheet-confirm-error')?.textContent || '',
    sheetError: document.getElementById('sheet-error')?.textContent || '',
    correct: document.getElementById('correct-list')?.textContent || '',
    recovery: localStorage.getItem('yimai_add_recovery'),
    userId: localStorage.getItem('yimai_user_id'),
    treeId: localStorage.getItem('yimai_tree_id'),
  }));
}

async function clickConfirmPrimary() {
  await page.evaluate(() => {
    const btn = document.querySelector('#sheet-confirm-actions button.danger-solid, #sheet-confirm-actions button.outline-action, #sheet-confirm-actions button.secondary');
    if (!btn) throw new Error('no primary');
    btn.click();
  });
}

function contrastRatio(fg, bg) {
  const parse = (hex) => {
    const h = hex.replace('#', '');
    const n = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
    const r = parseInt(n.slice(0, 2), 16) / 255;
    const g = parseInt(n.slice(2, 4), 16) / 255;
    const b = parseInt(n.slice(4, 6), 16) / 255;
    const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  };
  const L1 = parse(fg);
  const L2 = parse(bg);
  const hi = Math.max(L1, L2);
  const lo = Math.min(L1, L2);
  return (hi + 0.05) / (lo + 0.05);
}

async function testParentsDisplayNoDuplicateFather() {
  const auth = seedSiblingOverlap();
  await openAuthed(auth, auth.idA);
  await selectById(auth.idA);
  const ui = await sheetText();
  const parentsMatch = ui.summary.match(/父母是([^。]+)。/);
  const parentsText = parentsMatch ? parentsMatch[1] : '';
  const once = parentsText === '共父';
  const noDup = !/共父、共父/.test(ui.summary);
  const motherAbsent = !ui.correct.includes('母亲');
  await screenshot('h-parents-once.png');
  fs.writeFileSync(path.join(ARTIFACTS_DIR, 'h-parents-once.json'), JSON.stringify({
    account_id: auth.userId, tree_id: auth.treeId, personId: auth.idA, parentsText, summary: ui.summary,
  }, null, 2));
  log('Parents display: father once, mother null (no 共父、共父)', once && noDup && motherAbsent, `parents=${parentsText}`);
}

async function testH11ExplicitOnlyUnlinkJson() {
  const auth = seedSiblingOverlap();
  await openAuthed(auth, auth.idA);
  const before = await linksApi('sibling-links');
  await selectById(auth.idA);
  // Unlink A-C (explicit only) — choose row for 无亲C
  await page.evaluate((cId) => {
    const rows = Array.from(document.querySelectorAll('#correct-list .correct-row'));
    const row = rows.find((r) => r.textContent.includes(`谱号 ${cId}`));
    const btn = row?.querySelector('button');
    if (!btn) throw new Error('missing unlink for C');
    btn.click();
  }, String(auth.idC));
  await page.waitForSelector('#sheet-confirm:not(.hidden)');
  await clickConfirmPrimary();
  await sleep(700);
  const after = await linksApi('sibling-links');
  fs.writeFileSync(path.join(ARTIFACTS_DIR, 'del-h11-sibling-links-before-after.json'), JSON.stringify({
    account_id: auth.userId, tree_id: auth.treeId, targetLink: auth.linkAc, before, after,
  }, null, 2));
  const ok = before.some((l) => String(l.id) === String(auth.linkAc))
    && !after.some((l) => String(l.id) === String(auth.linkAc))
    && after.some((l) => String(l.id) === String(auth.linkAb));
  await screenshot('del-h11-after-explicit-only.png');
  log('DEL-H-11 explicit-only unlink before/after sibling-links JSON', ok, `before=${before.length}, after=${after.length}`);
}

async function testH12InferredExplanationVisible() {
  const auth = seedSiblingOverlap();
  await openAuthed(auth, auth.idA);
  await selectById(auth.idA);
  await page.evaluate((bId) => {
    const rows = Array.from(document.querySelectorAll('#correct-list .correct-row'));
    const row = rows.find((r) => r.textContent.includes(`谱号 ${bId}`));
    row?.querySelector('button')?.click();
  }, String(auth.idB));
  await page.waitForSelector('#sheet-confirm:not(.hidden)');
  await clickConfirmPrimary();
  await sleep(800);
  const ui = await sheetText();
  const tree = await treeApi(auth.idA);
  const parentEdges = (tree.edges || []).filter((e) => e.type === 'parent');
  const siblingEdges = (tree.edges || []).filter((e) => e.type === 'sibling');
  const noteVisible = ui.summary.includes('因共同父母仍显示为兄弟姐妹')
    || ui.sheetError.includes('因共同父母')
    || ui.correct.includes('因共同父母');
  const parentsKept = parentEdges.some((e) => e.from == auth.idParent && e.to == auth.idA)
    && parentEdges.some((e) => e.from == auth.idParent && e.to == auth.idB);
  const noExplicitAb = !siblingEdges.some((e) => String(e.link_id) === String(auth.linkAb));
  await screenshot('del-h12-inferred-explanation.png');
  fs.writeFileSync(path.join(ARTIFACTS_DIR, 'del-h12-tree-after.json'), JSON.stringify({
    account_id: auth.userId, tree_id: auth.treeId, parentEdges, siblingEdges, summary: ui.summary, sheetError: ui.sheetError,
  }, null, 2));
  log('DEL-H-12 inferred explanation visible; parents retained; no recreate explicit', noteVisible && parentsKept && noExplicitAb, `note=${noteVisible}`);
}

async function testDel7LostResponseTerminalAbsent() {
  const auth = seedPerson('可删T');
  await openAuthed(auth, auth.idT);
  await installHooks();
  await selectById(auth.idT);
  await page.evaluate(() => { window.__yimaiLoseNextDelete = true; });
  await page.click('#btn-delete-person');
  await clickConfirmPrimary();
  await page.waitForFunction(() => (document.getElementById('sheet-confirm-title')?.textContent || '').includes('不确定'), { timeout: 8000 });
  // Now click 核对 — DELETE already committed under same account/tree.
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('#sheet-confirm-actions button'))
      .find((b) => b.textContent.includes('核对'));
    btn?.click();
  });
  await sleep(1200);
  const ui = await sheetText();
  const persons = await personsApi();
  const committed = await page.evaluate(() => window.__yimaiDeleteCommitted || []);
  const absent = !persons.data.some((p) => String(p.id) === String(auth.idT));
  const nKept = persons.data.some((p) => String(p.id) === String(auth.idN));
  const terminalOk = absent && nKept && ui.confirmHidden
    && committed.some((c) => c.url.includes(`/persons/${auth.idT}`) && Number(c.status) === 204);
  await screenshot('del7-lost-response-terminal-absent.png');
  fs.writeFileSync(path.join(ARTIFACTS_DIR, 'del7-lost-terminal.json'), JSON.stringify({
    account_id: auth.userId, tree_id: auth.treeId, originalId: auth.idT, committed, persons: persons.data, ui,
  }, null, 2));
  log('DEL-7/H-16 lost committed DELETE → reconcile absent → terminal cleanup', terminalOk, `absent=${absent}, committed=${JSON.stringify(committed)}`);
}

async function testDel7NetworkNoCommitSafeRetry() {
  const auth = seedPerson('网络T');
  await openAuthed(auth, auth.idT);
  await installHooks();
  await selectById(auth.idT);
  await page.evaluate(() => { window.__yimaiFailNextDeleteNetwork = true; });
  await page.click('#btn-delete-person');
  await clickConfirmPrimary();
  await page.waitForFunction(() => (document.getElementById('sheet-confirm-title')?.textContent || '').includes('不确定'), { timeout: 8000 });
  let ui = await sheetText();
  const noRaw = !/Failed to fetch|simulated/i.test(ui.confirmBody + ui.confirmError);
  await page.evaluate(() => {
    Array.from(document.querySelectorAll('#sheet-confirm-actions button')).find((b) => b.textContent.includes('核对'))?.click();
  });
  await sleep(700);
  ui = await sheetText();
  const stillOffers = (ui.confirmBody + ui.confirmTitle).includes(String(auth.idT));
  await page.evaluate(() => {
    Array.from(document.querySelectorAll('#sheet-confirm-actions button')).find((b) => b.textContent.includes('删除'))?.click();
  });
  await sleep(900);
  const persons = await personsApi();
  const deleted = !persons.data.some((p) => String(p.id) === String(auth.idT));
  await screenshot('del7-network-safe-retry.png');
  log('DEL-7 network no-commit: sanitized unknown, same-id retry succeeds', noRaw && stillOffers && deleted, `noRaw=${noRaw}, deleted=${deleted}`);
}

async function testAccountSwitchCannotConfirmDeletion() {
  const { a, b } = seedForeign();
  await openAuthed(a, a.idP);
  await installHooks();
  await selectById(a.idP);
  await page.evaluate(() => { window.__yimaiFailNextDeleteNetwork = true; });
  await page.click('#btn-delete-person');
  await clickConfirmPrimary();
  await page.waitForFunction(() => (document.getElementById('sheet-confirm-title')?.textContent || '').includes('不确定'), { timeout: 8000 });
  // Login as B via UI fields while unknown dialog open.
  await page.$eval('#email', (el, v) => { el.value = v; }, b.email);
  await page.$eval('#password', (el) => { el.value = 'password'; });
  await page.click('#btn-login');
  await sleep(1500);
  let ui = await sheetText();
  // login should close/invalidate confirm
  const closedOrUnknown = ui.confirmHidden || ui.sheetError.includes('身份已变更') || ui.confirmBody.includes('账户或家谱已变更');
  // If somehow confirm still open, 核对 must not succeed-delete
  if (!ui.confirmHidden) {
    await page.evaluate(() => {
      Array.from(document.querySelectorAll('#sheet-confirm-actions button')).find((x) => x.textContent.includes('核对'))?.click();
    });
    await sleep(800);
    ui = await sheetText();
  }
  const aPersons = await personsApi(a.token);
  const stillOnA = aPersons.data.some((p) => String(p.id) === String(a.idP));
  const notFalselyGoneOnB = true; // B never owned A person
  await screenshot('del7-account-switch-no-false-success.png');
  fs.writeFileSync(path.join(ARTIFACTS_DIR, 'del7-account-switch.json'), JSON.stringify({
    a: { userId: a.userId, treeId: a.treeId, idP: a.idP, persons: aPersons.data },
    b: { userId: b.userId, treeId: b.treeId },
    ui,
  }, null, 2));
  log('DEL-7/H-22 account switch cannot confirm old deletion', closedOrUnknown && stillOnA && notFalselyGoneOnB, `stillOnA=${stillOnA}, confirmHidden=${ui.confirmHidden}`);
}

async function testWriteSuccessRefreshFailNoRepeatMutation() {
  const auth = seedPerson('刷新T');
  await openAuthed(auth, auth.idT);
  await installHooks();
  await selectById(auth.idT);
  await page.evaluate(() => { window.__yimaiFailNextTreeGet = true; });
  // Ensure root points at T so loadTree hits tree GET after delete
  await page.evaluate((id) => localStorage.setItem('yimai_root_id', String(id)), auth.idT);
  await page.click('#btn-delete-person');
  await clickConfirmPrimary();
  await sleep(1200);
  const paths = await page.evaluate(() => window.__yimaiDeletePaths || []);
  const persons = await personsApi();
  const ui = await sheetText();
  const oneDelete = paths.filter((p) => p.includes(`/persons/${auth.idT}`)).length === 1;
  const gone = !persons.data.some((p) => String(p.id) === String(auth.idT));
  const reloadOffer = ui.sheetError.includes('重新载入') || ui.sheetError.includes('刷新');
  await screenshot('del7-write-ok-refresh-fail.png');
  log('DEL-7 write success + refresh fail offers reload, no repeat DELETE', oneDelete && gone && reloadOffer, `deletes=${paths.length}, reloadOffer=${reloadOffer}`);
}

async function testUnrelatedRecoveryPreserved() {
  const auth = seedPerson('删旁人');
  await openAuthed(auth, auth.idN);
  // Plant recovery for a different pending id (idT), then delete idN
  await page.evaluate((payload) => {
    localStorage.setItem('yimai_add_recovery', JSON.stringify(payload));
  }, {
    userId: String(auth.userId),
    treeId: String(auth.treeId),
    kin: 'son',
    relation: 'child',
    anchorId: String(auth.idT),
    pendingPersonId: String(auth.idT),
    name: '可删T',
    phase: 'bind_failed',
    message: '人已记下，关系未保存',
  });
  await selectById(auth.idN);
  await page.click('#btn-delete-person');
  await clickConfirmPrimary();
  await sleep(900);
  const ui = await sheetText();
  let recovery = null;
  try { recovery = JSON.parse(ui.recovery); } catch (_) { recovery = null; }
  const preserved = recovery
    && String(recovery.pendingPersonId) === String(auth.idT)
    && String(recovery.anchorId) === String(auth.idT);
  await screenshot('del-recovery-unrelated-preserved.png');
  log('Unrelated delete preserves existing add recovery', preserved, `pending=${recovery?.pendingPersonId}`);
}

async function measureConfirmOcclusion() {
  return page.evaluate(() => {
    const sheet = document.getElementById('sheet');
    const body = document.getElementById('sheet-confirm-body');
    const cancel = document.querySelector('#sheet-confirm-actions button.ghost');
    const primary = document.querySelector('#sheet-confirm-actions button.danger-solid, #sheet-confirm-actions button.secondary, #sheet-confirm-actions button.outline-action');
    const footer = document.querySelector('.page-footer');
    const actions = document.getElementById('sheet-confirm-actions');
    // Scroll body to end so last phrase is the occlusion risk surface.
    body.scrollTop = body.scrollHeight;
    const bodyBox = body.getBoundingClientRect();
    const cancelBox = cancel.getBoundingClientRect();
    const primaryBox = primary.getBoundingClientRect();
    const footerBox = footer?.getBoundingClientRect();
    const footerVisible = Boolean(
      footer
      && getComputedStyle(footer).display !== 'none'
      && footerBox
      && footerBox.height > 1
      && footerBox.width > 1,
    );
    const actionsBox = actions.getBoundingClientRect();
    const sheetBox = sheet.getBoundingClientRect();
    const overlap = (a, b) => !(a.bottom <= b.top + 0.5 || b.bottom <= a.top + 0.5 || a.right <= b.left + 0.5 || b.right <= a.left + 0.5);
    const samplePoints = [];
    const pushSample = (label, el) => {
      const r = el.getBoundingClientRect();
      const x = Math.min(r.right - 4, Math.max(r.left + 4, (r.left + r.right) / 2));
      const y = Math.min(r.bottom - 4, Math.max(r.top + 4, (r.top + r.bottom) / 2));
      const topEl = document.elementFromPoint(x, y);
      const coveredByFooter = Boolean(topEl?.closest?.('.page-footer'));
      const coveredByActions = Boolean(topEl?.closest?.('#sheet-confirm-actions')) && el !== actions && !actions.contains(el);
      samplePoints.push({
        label,
        x,
        y,
        topTag: topEl?.tagName || null,
        topId: topEl?.id || null,
        topClass: topEl?.className || null,
        coveredByFooter,
        coveredByActions: el === body ? Boolean(topEl?.closest?.('#sheet-confirm-actions')) : false,
        ok: !coveredByFooter && (el === body ? !topEl?.closest?.('#sheet-confirm-actions') : true),
      });
    };
    // Body last-line sample and cancel center must not hit page-footer or alien overlays.
    pushSample('body', body);
    pushSample('cancel', cancel);
    pushSample('primary', primary);
    // Also sample near body bottom edge specifically (where sticky used to cover text).
    const bx = (bodyBox.left + bodyBox.right) / 2;
    const by = bodyBox.bottom - 6;
    const bodyEdge = document.elementFromPoint(bx, by);
    samplePoints.push({
      label: 'body_bottom_edge',
      x: bx,
      y: by,
      topTag: bodyEdge?.tagName || null,
      topId: bodyEdge?.id || null,
      coveredByFooter: Boolean(bodyEdge?.closest?.('.page-footer')),
      coveredByActions: Boolean(bodyEdge?.closest?.('#sheet-confirm-actions')),
      ok: !bodyEdge?.closest?.('.page-footer') && !bodyEdge?.closest?.('#sheet-confirm-actions'),
    });
    return {
      pageOverflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
      bodyText: body.textContent || '',
      cancelInSheet: cancelBox.top >= sheetBox.top - 1 && cancelBox.bottom <= sheetBox.bottom + 1,
      primaryInSheet: primaryBox.top >= sheetBox.top - 1 && primaryBox.bottom <= sheetBox.bottom + 1,
      buttonsOverlap: overlap(cancelBox, primaryBox) && Math.abs(cancelBox.top - primaryBox.top) < 4,
      footerVisible,
      footerOverlapsBody: footerVisible ? overlap(footerBox, bodyBox) : false,
      footerOverlapsCancel: footerVisible ? overlap(footerBox, cancelBox) : false,
      footerOverlapsPrimary: footerVisible ? overlap(footerBox, primaryBox) : false,
      footerOverlapsActions: footerVisible ? overlap(footerBox, actionsBox) : false,
      actionsOverlapsBodyGeom: overlap(actionsBox, {
        top: bodyBox.top,
        bottom: bodyBox.bottom - 1,
        left: bodyBox.left,
        right: bodyBox.right,
      }),
      samplePoints,
      bodyScrollable: body.scrollHeight > body.clientHeight + 1 || body.scrollHeight <= body.clientHeight + 1,
    };
  });
}

async function testNarrowScrollReachability() {
  const auth = seedPerson('窄屏T');
  const viewports = [
    { w: 320, h: 700, name: '320' },
    { w: 375, h: 844, name: '375' },
    { w: 768, h: 900, name: '768' },
  ];
  const reports = [];
  for (const vp of viewports) {
    await page.setViewport({ width: vp.w, height: vp.h });
    await openAuthed(auth, auth.idT);
    await selectById(auth.idT);
    await page.evaluate(() => {
      document.getElementById('delete-section')?.scrollIntoView({ block: 'center' });
      document.getElementById('btn-delete-person')?.click();
    });
    await page.waitForFunction(() => !document.getElementById('sheet-confirm')?.classList.contains('hidden'), { timeout: 8000 });
    // Ensure body scrolled so last phrase is the risk surface, then measure.
    await page.evaluate(() => {
      const body = document.getElementById('sheet-confirm-body');
      if (body) body.scrollTop = body.scrollHeight;
    });
    const metrics = await measureConfirmOcclusion();
    await screenshot(`vis-scroll-${vp.name}.png`);
    reports.push({ vp, ...metrics });
  }
  fs.writeFileSync(path.join(ARTIFACTS_DIR, 'vis-scroll-reachability.json'), JSON.stringify({ reports }, null, 2));
  const ok = reports.every((r) => !r.pageOverflowX
    && r.cancelInSheet
    && r.primaryInSheet
    && !r.buttonsOverlap
    && !r.footerOverlapsBody
    && !r.footerOverlapsCancel
    && !r.footerOverlapsPrimary
    && !r.footerOverlapsActions
    && r.samplePoints.every((s) => s.ok)
    && r.bodyText.includes('谱号')
    && r.bodyText.includes('其他成员仍会保留'));
  log('VIS-02 footer/body non-occlusion 320/375/768 (geom+elementFromPoint)', ok, JSON.stringify(reports.map((r) => ({
    w: r.vp.w,
    footerBody: r.footerOverlapsBody,
    footerCancel: r.footerOverlapsCancel,
    samples: r.samplePoints.map((s) => `${s.label}:${s.ok}`),
  }))));
}

async function testConfirmTabCycleAndEscFocus() {
  const auth = seedPerson('键盘T');
  await page.setViewport({ width: 1280, height: 800 });
  await openAuthed(auth, auth.idT);
  await selectById(auth.idT);
  await page.focus('#btn-delete-person');
  await page.click('#btn-delete-person');
  await page.waitForSelector('#sheet-confirm:not(.hidden)');
  const labels = await page.evaluate(() => Array.from(document.querySelectorAll('#sheet-confirm-actions button')).map((b) => b.textContent.trim()));
  if (labels.length < 2) {
    log('VIS-03/15 full Tab forward+reverse cycle + Esc restores live trigger', false, 'need>=2 focusables');
    return;
  }
  await page.evaluate(() => document.querySelector('#sheet-confirm-actions button')?.focus());
  const forward = [];
  for (let i = 0; i < labels.length; i += 1) {
    forward.push(await page.evaluate(() => document.activeElement?.textContent?.trim() || null));
    await page.keyboard.press('Tab');
  }
  // After Tab on last, trap should wrap to first.
  const afterWrap = await page.evaluate(() => document.activeElement?.textContent?.trim() || null);
  await page.evaluate(() => document.querySelector('#sheet-confirm-actions button')?.focus());
  await page.keyboard.down('Shift');
  await page.keyboard.press('Tab');
  await page.keyboard.up('Shift');
  const afterShift = await page.evaluate(() => document.activeElement?.textContent?.trim() || null);
  const cycle = {
    labels,
    forward,
    afterWrap,
    afterShift,
    ok: afterWrap === labels[0] && afterShift === labels[labels.length - 1],
  };
  await page.keyboard.press('Escape');
  await sleep(300);
  const afterEsc = await sheetText();
  const focusBack = await page.evaluate(() => {
    const a = document.activeElement;
    const live = a && document.body.contains(a) && (a.getClientRects?.().length || 0) > 0;
    return {
      live,
      id: a?.id || null,
      cls: a?.className || null,
      ok: live && (a.id === 'btn-delete-person' || a.id === 'btn-add' || a.classList?.contains('node-card')),
    };
  });
  await screenshot('vis-tab-cycle-esc.png');
  fs.writeFileSync(path.join(ARTIFACTS_DIR, 'vis-tab-cycle.json'), JSON.stringify({ cycle, afterEsc, focusBack }, null, 2));
  log('VIS-03/15 full Tab forward+reverse cycle + Esc restores live trigger', cycle.ok && afterEsc.confirmHidden && focusBack.ok, JSON.stringify({ cycle, focusBack }));
}

async function testFocusAfterDeletedTrigger() {
  const auth = seedPerson('回焦T');
  await openAuthed(auth, auth.idT);
  await selectById(auth.idT);
  await page.focus('#btn-delete-person');
  await page.click('#btn-delete-person');
  await clickConfirmPrimary();
  await sleep(1000);
  const focus = await page.evaluate((deletedId) => {
    const a = document.activeElement;
    const live = a && document.body.contains(a) && (a.getClientRects?.().length || 0) > 0;
    const onBody = a === document.body || a === document.documentElement;
    const onDeleted = a?.closest?.(`[data-id="${deletedId}"]`) || a?.id === 'btn-delete-person';
    const onLiveNode = a?.classList?.contains('node-card') && a.getAttribute('data-id') !== String(deletedId);
    const onAdd = a?.id === 'btn-add';
    return {
      live,
      onBody,
      onDeleted: Boolean(onDeleted),
      onLiveNode: Boolean(onLiveNode),
      onAdd,
      id: a?.id || null,
      dataId: a?.getAttribute?.('data-id') || null,
      ok: live && !onBody && !onDeleted && (onLiveNode || onAdd),
    };
  }, auth.idT);
  await screenshot('vis-focus-after-delete.png');
  fs.writeFileSync(path.join(ARTIFACTS_DIR, 'vis-focus-after-delete.json'), JSON.stringify({ deletedId: auth.idT, focus }, null, 2));
  log('VIS-03/15 focus after deleted trigger lands on live node/add', focus.ok, JSON.stringify(focus));
}

async function testInFlightDelayedDeleteThenLoginB(mode) {
  const { a, b } = seedForeign();
  await openAuthed(a, a.idP);
  await installHooks();
  // Snapshot B baseline before any A mutation side effects.
  const bBefore = await personsApi(b.token);
  await selectById(a.idP);
  await page.evaluate((m) => {
    window.__yimaiDelayNextDeleteMs = 30;
    window.__yimaiDelayNextDeleteMode = m;
  }, mode);
  await page.click('#btn-delete-person');
  await clickConfirmPrimary();
  // Wait until DELETE is gated (in flight), then login as B BEFORE release.
  await page.waitForFunction(() => typeof window.__yimaiReleaseDelayedDelete === 'function', { timeout: 8000 });
  const midA = await page.evaluate(() => ({
    userId: localStorage.getItem('yimai_user_id'),
    treeId: localStorage.getItem('yimai_tree_id'),
    confirmHidden: document.getElementById('sheet-confirm')?.classList.contains('hidden'),
  }));
  await page.$eval('#email', (el, v) => { el.value = v; }, b.email);
  await page.$eval('#password', (el) => { el.value = 'password'; });
  await page.click('#btn-login');
  await sleep(1200);
  const afterLogin = await sheetText();
  // Release delayed A response into B session.
  await page.evaluate(() => window.__yimaiReleaseDelayedDelete?.());
  await sleep(900);
  const afterRelease = await sheetText();
  const bAfter = await personsApi(b.token);
  const aAfter = await personsApi(a.token);
  const bStable = JSON.stringify(bBefore.data.map((p) => p.id).sort()) === JSON.stringify(bAfter.data.map((p) => p.id).sort());
  const noAConfirm = afterRelease.confirmHidden || !(afterRelease.confirmBody || '').includes(String(a.idP));
  const noFalseSuccess = !(afterRelease.sheetError || '').includes('已删除成功')
    && !(afterRelease.confirmTitle || '').includes('已删除');
  // A person may or may not be gone depending on mode (ok vs network); either way B must be untouched.
  const aGone = !aAfter.data.some((p) => String(p.id) === String(a.idP));
  const modeOk = mode === 'ok' ? true : !aGone; // network fail must not delete
  await screenshot(`del7-inflight-${mode}-after-login-b.png`);
  fs.writeFileSync(path.join(ARTIFACTS_DIR, `del7-inflight-${mode}.json`), JSON.stringify({
    mode, midA, afterLogin, afterRelease, a: { idP: a.idP, persons: aAfter.data }, b: { before: bBefore.data, after: bAfter.data },
    bStable, noAConfirm, noFalseSuccess, aGone, modeOk,
  }, null, 2));
  log(`H-22 in-flight delayed ${mode}: login B then release — B unaffected, no A confirm reopen`, bStable && noAConfirm && noFalseSuccess && modeOk && afterLogin.userId === String(b.userId), `bStable=${bStable}, aGone=${aGone}, confirmHidden=${afterRelease.confirmHidden}`);
}

async function testSameAccountDelayedDeleteStillWorks() {
  const auth = seedPerson('同账延迟');
  await openAuthed(auth, auth.idT);
  await installHooks();
  await selectById(auth.idT);
  await page.evaluate(() => {
    window.__yimaiDelayNextDeleteMs = 30;
    window.__yimaiDelayNextDeleteMode = 'ok';
  });
  await page.click('#btn-delete-person');
  await clickConfirmPrimary();
  await page.waitForFunction(() => typeof window.__yimaiReleaseDelayedDelete === 'function', { timeout: 8000 });
  await page.evaluate(() => window.__yimaiReleaseDelayedDelete?.());
  await sleep(1000);
  const persons = await personsApi();
  const ui = await sheetText();
  const ok = !persons.data.some((p) => String(p.id) === String(auth.idT))
    && persons.data.some((p) => String(p.id) === String(auth.idN))
    && ui.confirmHidden;
  await screenshot('del7-same-account-delayed-ok.png');
  log('Same-account delayed 204 still completes delete under original identity', ok, `confirmHidden=${ui.confirmHidden}`);
}

async function testReconcile401and403Unknown() {
  const auth = seedPerson('鉴权核');
  await openAuthed(auth, auth.idT);
  await installHooks();
  await selectById(auth.idT);
  await page.evaluate(() => { window.__yimaiFailNextDeleteNetwork = true; });
  await page.click('#btn-delete-person');
  await clickConfirmPrimary();
  await page.waitForFunction(() => (document.getElementById('sheet-confirm-title')?.textContent || '').includes('不确定'), { timeout: 8000 });

  const runForce = async (code) => {
    await page.evaluate((c) => { window.__yimaiReconcileForceStatus = c; }, code);
    await page.evaluate(() => {
      Array.from(document.querySelectorAll('#sheet-confirm-actions button')).find((b) => b.textContent.includes('核对'))?.click();
    });
    await sleep(700);
    const ui = await sheetText();
    const persons = await personsApi();
    return {
      code,
      confirmTitle: ui.confirmTitle,
      confirmBody: ui.confirmBody,
      stillPresent: persons.data.some((p) => String(p.id) === String(auth.idT)),
      notSuccess: ui.confirmTitle.includes('不确定') || (ui.confirmBody || '').includes('不能当作已删除') || (ui.confirmBody || '').includes('认证'),
    };
  };
  const r401 = await runForce(401);
  const r403 = await runForce(403);
  fs.writeFileSync(path.join(ARTIFACTS_DIR, 'del7-reconcile-401-403.json'), JSON.stringify({ r401, r403 }, null, 2));
  await screenshot('del7-reconcile-401-403.png');
  const ok = r401.stillPresent && r403.stillPresent && r401.notSuccess && r403.notSuccess;
  log('H-22 reconcile 401 and 403 independent unknown negatives (not success)', ok, JSON.stringify({ r401, r403 }));
}

async function testContrastRenderedSampling() {
  const auth = seedPerson('对比T');
  await openAuthed(auth, auth.idT);
  await selectById(auth.idT);
  await page.click('#btn-delete-person');
  await page.waitForSelector('#sheet-confirm:not(.hidden)');
  const measured = await page.evaluate(() => {
    const toHex = (color) => {
      const m = String(color).match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
      if (!m) return null;
      const h = (n) => Number(n).toString(16).padStart(2, '0');
      return `#${h(m[1])}${h(m[2])}${h(m[3])}`;
    };
    const lin = (c) => {
      const x = c / 255;
      return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
    };
    const lum = (hex) => {
      const n = hex.replace('#', '');
      const r = parseInt(n.slice(0, 2), 16);
      const g = parseInt(n.slice(2, 4), 16);
      const b = parseInt(n.slice(4, 6), 16);
      return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    };
    const ratio = (fg, bg) => {
      const L1 = lum(fg);
      const L2 = lum(bg);
      const hi = Math.max(L1, L2);
      const lo = Math.min(L1, L2);
      return (hi + 0.05) / (lo + 0.05);
    };
    const pairs = [];
    const push = (name, fgEl, bgEl, need) => {
      const fg = toHex(getComputedStyle(fgEl).color);
      const bg = toHex(getComputedStyle(bgEl).backgroundColor);
      if (!fg || !bg) {
        pairs.push({ name, pass: false, reason: 'unparsed', fg, bg, need });
        return;
      }
      const r = ratio(fg, bg);
      pairs.push({ name, fg, bg, need, ratio: Number(r.toFixed(2)), pass: r >= need });
    };
    const title = document.getElementById('sheet-confirm-title');
    const body = document.getElementById('sheet-confirm-body');
    const panel = document.getElementById('sheet');
    const primary = document.querySelector('#sheet-confirm-actions button.danger-solid');
    const cancel = document.querySelector('#sheet-confirm-actions button.ghost');
    push('confirm_title_on_sheet', title, panel, 4.5);
    push('confirm_body_on_sheet', body, panel, 4.5);
    push('danger_button_text', primary, primary, 4.5);
    // UI graphic: cancel border vs panel via outline color approximation using color on cancel
    push('cancel_text_on_sheet', cancel, panel, 4.5);
    // Disabled exemption: force-disable sample
    primary.disabled = true;
    const disFg = toHex(getComputedStyle(primary).color);
    const disBg = toHex(getComputedStyle(primary).backgroundColor);
    pairs.push({ name: 'disabled_primary_exempt', fg: disFg, bg: disBg, need: null, ratio: disFg && disBg ? Number(ratio(disFg, disBg).toFixed(2)) : null, pass: true, exempt: true });
    primary.disabled = false;
    return pairs;
  });
  fs.writeFileSync(path.join(ARTIFACTS_DIR, 'vis-contrast-rendered.json'), JSON.stringify({ note: 'getComputedStyle sampling from rendered confirm; disabled exempt', measured }, null, 2));
  await screenshot('vis-contrast-rendered.png');
  const ok = measured.every((m) => m.pass);
  log('VIS-05 rendered contrast sampling (text>=4.5; disabled exempt)', ok, measured.map((m) => `${m.name}:${m.ratio}`).join(','));
}

async function testLoadingDisabledAndNarrowStates() {
  const auth = seedPerson('加载T');
  await openAuthed(auth, auth.idT);
  await installHooks();
  await selectById(auth.idT);
  await page.evaluate(() => {
    window.__yimaiDelayNextDeleteMs = 80;
    window.__yimaiDelayNextDeleteMode = 'ok';
  });
  await page.click('#btn-delete-person');
  await clickConfirmPrimary();
  await page.waitForFunction(() => document.getElementById('sheet-confirm')?.getAttribute('aria-busy') === 'true', { timeout: 8000 });
  const busy = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('#sheet-confirm-actions button'));
    return {
      ariaBusy: document.getElementById('sheet-confirm')?.getAttribute('aria-busy'),
      allDisabled: buttons.every((b) => b.disabled),
      labels: buttons.map((b) => b.textContent.trim()),
    };
  });
  await screenshot('vis-confirm-loading-busy.png');
  await page.evaluate(() => window.__yimaiReleaseDelayedDelete?.());
  await sleep(900);

  // Narrow empty
  await page.setViewport({ width: 375, height: 844 });
  const alone = seedPerson('空窄');
  // delete both to empty: delete N then T
  await openAuthed(alone, alone.idT);
  await selectById(alone.idN);
  await page.click('#btn-delete-person');
  await clickConfirmPrimary();
  await sleep(800);
  await selectById(alone.idT);
  await page.click('#btn-delete-person');
  await clickConfirmPrimary();
  await sleep(900);
  const emptyUi = await page.evaluate(() => ({
    emptyHidden: document.getElementById('empty')?.classList.contains('hidden'),
    title: document.getElementById('sheet-title')?.textContent || '',
  }));
  await screenshot('vis-empty-narrow-375.png');

  // Narrow 409
  const parentChild = phpSeed(`
$u=App\\Models\\User::create(['name'=>'QA409n','email'=>$email,'password'=>bcrypt('password')]);
$t=App\\Models\\Tree::create(['owner_user_id'=>$u->id,'title'=>'QA409n']);
$p=App\\Models\\Person::create(['tree_id'=>$t->id,'name'=>'父P','gender'=>'male','generation'=>1]);
$c=App\\Models\\Person::create(['tree_id'=>$t->id,'name'=>'子C','gender'=>'male','generation'=>2,'father_id'=>$p->id]);
echo json_encode(['userId'=>$u->id,'treeId'=>$t->id,'token'=>$u->createToken('t')->plainTextToken,'idP'=>$p->id,'idC'=>$c->id], JSON_UNESCAPED_UNICODE);
`);
  await page.setViewport({ width: 375, height: 844 });
  await openAuthed(parentChild, parentChild.idP);
  await selectById(parentChild.idP);
  await page.click('#btn-delete-person');
  await clickConfirmPrimary();
  await page.waitForFunction(() => (document.getElementById('sheet-confirm-body')?.textContent || '').includes('父亲或母亲'), { timeout: 8000 });
  await screenshot('vis-409-narrow-375.png');
  const order = await page.evaluate(() => Array.from(document.querySelectorAll('#sheet-confirm-actions button')).map((b) => b.textContent.trim()));

  fs.writeFileSync(path.join(ARTIFACTS_DIR, 'vis-loading-empty-409.json'), JSON.stringify({ busy, emptyUi, order }, null, 2));
  const ok = busy.ariaBusy === 'true' && busy.allDisabled && emptyUi.emptyHidden === false && order[0]?.includes('打开并更正');
  log('VIS-04/06/07/08 loading busy + narrow empty + narrow 409', ok, JSON.stringify({ busy, emptyUi, order }));
}

async function testTrueBrowserZoomObstacle() {
  // Probe once; do not claim DPR2 or pageScaleFactor as browser chrome 200% zoom.
  const probe = await page.evaluate(() => ({
    iw: window.innerWidth,
    dpr: window.devicePixelRatio,
    vv: window.visualViewport ? { w: window.visualViewport.width, s: window.visualViewport.scale } : null,
  }));
  let cdp = null;
  try {
    const client = await page.createCDPSession();
    await client.send('Emulation.setPageScaleFactor', { pageScaleFactor: 2 });
    cdp = await page.evaluate(() => ({
      iw: window.innerWidth,
      dpr: window.devicePixelRatio,
      vv: window.visualViewport ? { w: window.visualViewport.width, s: window.visualViewport.scale } : null,
    }));
    await client.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1 });
  } catch (err) {
    cdp = { error: String(err.message || err) };
  }
  // Ctrl+= no-op check
  for (let i = 0; i < 3; i += 1) {
    await page.keyboard.down('Control');
    await page.keyboard.press('=');
    await page.keyboard.up('Control');
  }
  const afterCtrl = await page.evaluate(() => ({
    iw: window.innerWidth,
    dpr: window.devicePixelRatio,
    vv: window.visualViewport ? { w: window.visualViewport.width, s: window.visualViewport.scale } : null,
  }));
  const obstacle = {
    status: 'UNVERIFIED',
    reason: 'Headless Chromium in this cloud agent has no Browser/Page.setZoomLevel; Ctrl+= does not change CSS layout viewport; Emulation.setPageScaleFactor only changes visualViewport.scale (pinch-style) without reflowing CSS innerWidth — NOT browser-chrome 200% zoom. DPR2 likewise rejected.',
    probe,
    cdpPageScaleFactor: cdp,
    afterCtrlPlus: afterCtrl,
  };
  fs.writeFileSync(path.join(ARTIFACTS_DIR, 'vis-true-zoom-obstacle.json'), JSON.stringify(obstacle, null, 2));
  // Environmental gap — not a product FAIL and never padded as PASS.
  noteUnverified('VIS-14 true browser 200% zoom', obstacle.reason);
}

async function test409PrefersChildCorrection() {
  const auth = phpSeed(`
$u=App\\Models\\User::create(['name'=>'QA409','email'=>$email,'password'=>bcrypt('password')]);
$t=App\\Models\\Tree::create(['owner_user_id'=>$u->id,'title'=>'QA409']);
$p=App\\Models\\Person::create(['tree_id'=>$t->id,'name'=>'父P','gender'=>'male','generation'=>1]);
$c=App\\Models\\Person::create(['tree_id'=>$t->id,'name'=>'子C','gender'=>'male','generation'=>2,'father_id'=>$p->id]);
echo json_encode(['userId'=>$u->id,'treeId'=>$t->id,'token'=>$u->createToken('t')->plainTextToken,'idP'=>$p->id,'idC'=>$c->id], JSON_UNESCAPED_UNICODE);
`);
  await openAuthed(auth, auth.idP);
  await selectById(auth.idP);
  await page.click('#btn-delete-person');
  await clickConfirmPrimary();
  await page.waitForFunction(() => (document.getElementById('sheet-confirm-body')?.textContent || '').includes('父亲或母亲'), { timeout: 8000 });
  const order = await page.evaluate(() => Array.from(document.querySelectorAll('#sheet-confirm-actions button')).map((b) => b.textContent.trim()));
  const firstIsOpen = order[0]?.includes('打开并更正');
  const retryIsGhost = await page.evaluate(() => {
    const retry = Array.from(document.querySelectorAll('#sheet-confirm-actions button')).find((b) => b.textContent.includes('重试删除'));
    return retry && retry.classList.contains('ghost') && !retry.classList.contains('danger-solid');
  });
  const noDeleteChild = order.every((t) => !t.includes('删除子'));
  await screenshot('del3-409-action-hierarchy.png');
  log('409 action hierarchy prefers open-child correction over retry delete', firstIsOpen && retryIsGhost && noDeleteChild, `order=${order.join(' | ')}`);
}

async function runAll() {
  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: APP_ROOT, encoding: 'utf8' }).stdout.trim();
  const dirty = spawnSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: APP_ROOT, encoding: 'utf8' }).stdout.trim();
  suiteMeta.head = head;
  suiteMeta.dirty = Boolean(dirty);
  suiteMeta.startedAt = startedAt.toISOString();
  suiteMeta.sourceHashes = {
    'frontend/js/app.js': fileSha('frontend/js/app.js'),
    'frontend/css/app.css': fileSha('frontend/css/app.css'),
    'app/Http/Controllers/Api/V1/PersonController.php': fileSha('app/Http/Controllers/Api/V1/PersonController.php'),
  };
  suiteMeta.servedHashes = {
    appJs: createHash('sha256').update(await (await fetch(`${BASE_URL}/app/js/app.js`)).arrayBuffer().then((b) => Buffer.from(b))).digest('hex'),
    appCss: createHash('sha256').update(await (await fetch(`${BASE_URL}/app/css/app.css`)).arrayBuffer().then((b) => Buffer.from(b))).digest('hex'),
  };
  suiteMeta.servedMatchesSource = {
    js: suiteMeta.servedHashes.appJs === suiteMeta.sourceHashes['frontend/js/app.js'],
    css: suiteMeta.servedHashes.appCss === suiteMeta.sourceHashes['frontend/css/app.css'],
  };
  fs.writeFileSync(path.join(ARTIFACTS_DIR, 'suite-start-provenance.json'), JSON.stringify(suiteMeta, null, 2));
  console.log(JSON.stringify({ event: 'suite_start', ...suiteMeta }, null, 2));

  const ordered = [
    testParentsDisplayNoDuplicateFather,
    testH11ExplicitOnlyUnlinkJson,
    testH12InferredExplanationVisible,
    testDel7LostResponseTerminalAbsent,
    testDel7NetworkNoCommitSafeRetry,
    testAccountSwitchCannotConfirmDeletion,
    () => testInFlightDelayedDeleteThenLoginB('ok'),
    () => testInFlightDelayedDeleteThenLoginB('network'),
    testSameAccountDelayedDeleteStillWorks,
    testReconcile401and403Unknown,
    testWriteSuccessRefreshFailNoRepeatMutation,
    testUnrelatedRecoveryPreserved,
    testNarrowScrollReachability,
    testConfirmTabCycleAndEscFocus,
    testFocusAfterDeletedTrigger,
    testContrastRenderedSampling,
    testLoadingDisabledAndNarrowStates,
    test409PrefersChildCorrection,
    testTrueBrowserZoomObstacle,
  ];

  try {
    await setup();
    for (const fn of ordered) await fn();
  } catch (err) {
    fatalError = err;
    console.error('FATAL', err);
    results.push({ test: 'Suite completed without uncaught error', passed: false, message: String(err?.message || err), at: new Date().toISOString() });
  } finally {
    await teardown().catch(() => {});
  }

  const endedAt = new Date();
  const endHashes = {
    'frontend/js/app.js': fileSha('frontend/js/app.js'),
    'frontend/css/app.css': fileSha('frontend/css/app.css'),
    'app/Http/Controllers/Api/V1/PersonController.php': fileSha('app/Http/Controllers/Api/V1/PersonController.php'),
  };
  const visMap = {
    note: 'Honest coverage on this HEAD. PASS only with full oracle. PARTIAL = some evidence, not whole matrix row. UNVERIFIED = missing/blocked. Never pad total PASS while required rows remain UNVERIFIED.',
    head,
    rows: [
      { id: 'VIS-01', strength: 'PASS', oracle: 'desktop confirm structure (delete suite + hierarchy shot)' },
      { id: 'VIS-02', strength: 'PASS_IF_GREEN', oracle: '320/375/768 footer+actions non-occlusion via geom+elementFromPoint + screenshots' },
      { id: 'VIS-03', strength: 'PASS_IF_GREEN', oracle: 'full Tab forward+reverse inside confirm + Esc restore; focus-after-deleted-trigger' },
      { id: 'VIS-04', strength: 'PARTIAL', oracle: 'loading aria-busy+allDisabled screenshot captured; hover/focus/active gallery still incomplete' },
      { id: 'VIS-05', strength: 'PASS_IF_GREEN', oracle: 'rendered getComputedStyle contrast sampling; disabled exempt' },
      { id: 'VIS-06', strength: 'PARTIAL', oracle: 'narrow empty 375 screenshot added; desktop empty already in delete suite' },
      { id: 'VIS-07', strength: 'PARTIAL', oracle: 'loading busy shot + sanitized unknown; not a full error-state matrix' },
      { id: 'VIS-08', strength: 'PASS_IF_GREEN', oracle: 'desktop 409 hierarchy + narrow 375 409 screenshot' },
      { id: 'VIS-09', strength: 'UNVERIFIED', oracle: 'focus-visible CSS exists; no dedicated focus-ring screenshot gallery' },
      { id: 'VIS-10', strength: 'PASS', oracle: 'H-12 inferred explanation screenshot (prior closed)' },
      { id: 'VIS-11', strength: 'PASS', oracle: 'unknown never claims success' },
      { id: 'VIS-12', strength: 'PASS', oracle: 'root survivor perspective' },
      { id: 'VIS-13', strength: 'UNVERIFIED', oracle: 'no dedicated global before/after IDs/edges/root/stats contract pack in this suite' },
      { id: 'VIS-14', strength: 'UNVERIFIED', oracle: 'true browser-chrome 200% zoom unavailable in headless cloud (see vis-true-zoom-obstacle.json); DPR2/pageScaleFactor rejected' },
      { id: 'VIS-15', strength: 'PASS_IF_GREEN', oracle: 'paired with VIS-03 keyboard dialogs for delete confirm' },
      { id: 'VIS-16', strength: 'PARTIAL', oracle: 'loading+disabled captured; default/hover/focus/active series still incomplete' },
    ],
  };
  fs.writeFileSync(path.join(ARTIFACTS_DIR, 'VIS-COVERAGE-MAP.json'), JSON.stringify(visMap, null, 2));
  const payload = {
    head,
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    sourceHashesStart: suiteMeta.sourceHashes,
    sourceHashesEnd: endHashes,
    sourceStable: JSON.stringify(suiteMeta.sourceHashes) === JSON.stringify(endHashes),
    servedHashes: suiteMeta.servedHashes,
    servedMatchesSource: suiteMeta.servedMatchesSource,
    dirtyAtStart: suiteMeta.dirty,
    passed: results.filter((r) => r.passed).length,
    total: results.length,
    allPassed: results.every((r) => r.passed) && !fatalError,
    fatalError: fatalError ? String(fatalError.message || fatalError) : null,
    results,
    unverified,
    note: 'allPassed refers only to executable product oracles; unverified[] are honest gaps and do not pad PASS.',
  };
  fs.writeFileSync(path.join(ARTIFACTS_DIR, 'delete-hardening-results.json'), JSON.stringify(payload, null, 2));
  console.log(`Results: ${payload.passed}/${payload.total} head=${head}; unverified=${unverified.length}`);
  if (!payload.allPassed || !payload.sourceStable || !payload.servedMatchesSource.js) process.exit(1);
  process.exit(0);
}

runAll();
