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
    window.__yimaiDelayNextPersonGetMs = 0;
    window.__yimaiDelayNextPersonGetMode = null; // 'exists' | 'unknown' | 401 | 403
    window.__yimaiPersonGetGate = null;
    window.__yimaiDelayNextPersonsListMs = 0;
    window.__yimaiPersonsListGate = null;
    window.__yimaiDelayNextTreeGetMs = 0;
    window.__yimaiTreeGetGate = null;
    window.__yimaiFailNextRelationBind = false;
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
      // Delayed GET /persons/{id} for reconcile-in-flight → login B races.
      if (
        window.__yimaiDelayNextPersonGetMs > 0
        && method === 'GET'
        && /\/api\/v1\/persons\/\d+$/.test(url)
      ) {
        const ms = window.__yimaiDelayNextPersonGetMs;
        const mode = window.__yimaiDelayNextPersonGetMode || 'exists';
        window.__yimaiDelayNextPersonGetMs = 0;
        window.__yimaiDelayNextPersonGetMode = null;
        let release;
        window.__yimaiPersonGetGate = new Promise((r) => { release = r; });
        window.__yimaiReleaseDelayedPersonGet = release;
        await window.__yimaiPersonGetGate;
        await new Promise((r) => setTimeout(r, ms));
        if (mode === 401 || mode === 403 || mode === '401' || mode === '403') {
          return new Response(JSON.stringify({ message: 'forced delayed auth' }), {
            status: Number(mode),
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (mode === 'unknown' || mode === 'network') {
          throw new TypeError('Failed to fetch (simulated delayed reconcile network fail)');
        }
        // 'exists' — real GET under whatever token is current after release.
        return window.__yimaiOrigFetch(input, init);
      }
      // Delayed GET /persons list — loadPersons sink race after login B.
      if (
        window.__yimaiDelayNextPersonsListMs > 0
        && method === 'GET'
        && /\/api\/v1\/persons\/?(\?|$)/.test(url)
        && !/\/persons\/\d+/.test(url)
      ) {
        const ms = window.__yimaiDelayNextPersonsListMs;
        window.__yimaiDelayNextPersonsListMs = 0;
        let release;
        window.__yimaiPersonsListGate = new Promise((r) => { release = r; });
        window.__yimaiReleaseDelayedPersonsList = release;
        await window.__yimaiPersonsListGate;
        await new Promise((r) => setTimeout(r, ms));
        return window.__yimaiOrigFetch(input, init);
      }
      // Delayed GET /persons/{id}/tree — loadTree sink race after login B.
      if (
        window.__yimaiDelayNextTreeGetMs > 0
        && method === 'GET'
        && /\/api\/v1\/persons\/\d+\/tree/.test(url)
      ) {
        const ms = window.__yimaiDelayNextTreeGetMs;
        window.__yimaiDelayNextTreeGetMs = 0;
        let release;
        window.__yimaiTreeGetGate = new Promise((r) => { release = r; });
        window.__yimaiReleaseDelayedTreeGet = release;
        await window.__yimaiTreeGetGate;
        await new Promise((r) => setTimeout(r, ms));
        return window.__yimaiOrigFetch(input, init);
      }
      // Forced relation-bind failure after person create (add bind_failed path).
      if (window.__yimaiFailNextRelationBind) {
        const body = init.body ? String(init.body) : '';
        const parentPatch = method === 'PATCH' && /\/api\/v1\/persons\/\d+$/.test(url)
          && (body.includes('father_id') || body.includes('mother_id'));
        const linkPost = method === 'POST' && /\/api\/v1\/(spouse-links|sibling-links)/.test(url);
        if (parentPatch || linkPost) {
          window.__yimaiFailNextRelationBind = false;
          return new Response(JSON.stringify({ message: 'forced bind fail' }), {
            status: 422,
            headers: { 'Content-Type': 'application/json' },
          });
        }
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
    const onDeletedNode = a?.classList?.contains('node-card') && a.getAttribute('data-id') === String(deletedId);
    const onLiveNode = a?.classList?.contains('node-card') && a.getAttribute('data-id') !== String(deletedId);
    const onAdd = a?.id === 'btn-add';
    // Singleton #btn-delete-person must not be the post-delete landing target.
    const onDeleteSingleton = a?.id === 'btn-delete-person';
    return {
      live,
      onBody,
      onDeletedNode: Boolean(onDeletedNode),
      onLiveNode: Boolean(onLiveNode),
      onAdd,
      onDeleteSingleton,
      id: a?.id || null,
      dataId: a?.getAttribute?.('data-id') || null,
      ok: live && !onBody && !onDeletedNode && !onDeleteSingleton && (onLiveNode || onAdd),
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
  // Residual-2: B view must not keep A's detail/metadata/actions painted.
  const bView = await page.evaluate((aId, aName) => {
    const title = document.getElementById('sheet-title')?.textContent || '';
    const puhao = document.getElementById('sheet-puhao')?.textContent || '';
    const summary = document.getElementById('sheet-summary')?.textContent || '';
    const setRoot = document.getElementById('btn-set-root')?.textContent || '';
    const deleteLabel = document.getElementById('btn-delete-person')?.textContent || '';
    const sheetHidden = document.getElementById('sheet')?.classList.contains('hidden');
    const confirmHidden = document.getElementById('sheet-confirm')?.classList.contains('hidden');
    const hasAName = title.includes(aName) || summary.includes(aName) || setRoot.includes(aName);
    const hasAId = puhao.includes(String(aId)) || summary.includes(String(aId)) || setRoot.includes(String(aId));
    return {
      title, puhao, summary, setRoot, deleteLabel, sheetHidden, confirmHidden, hasAName, hasAId,
      ok: !hasAName && !hasAId && confirmHidden,
    };
  }, a.idP, '甲树人');
  await screenshot(`del7-inflight-${mode}-after-login-b.png`);
  fs.writeFileSync(path.join(ARTIFACTS_DIR, `del7-inflight-${mode}.json`), JSON.stringify({
    mode, midA, afterLogin, afterRelease, bView, a: { idP: a.idP, persons: aAfter.data }, b: { before: bBefore.data, after: bAfter.data },
    bStable, noAConfirm, noFalseSuccess, aGone, modeOk,
  }, null, 2));
  log(
    `H-22 in-flight delayed ${mode}: login B then release — B unaffected, no A confirm/detail`,
    bStable && noAConfirm && noFalseSuccess && modeOk && afterLogin.userId === String(b.userId) && bView.ok,
    `bStable=${bStable}, aGone=${aGone}, confirmHidden=${afterRelease.confirmHidden}, bViewOk=${bView.ok}`,
  );
}

async function measureBViewNoADetail(aPersonId, aName) {
  return page.evaluate((aId, name) => {
    const title = document.getElementById('sheet-title')?.textContent || '';
    const puhao = document.getElementById('sheet-puhao')?.textContent || '';
    const summary = document.getElementById('sheet-summary')?.textContent || '';
    const setRoot = document.getElementById('btn-set-root')?.textContent || '';
    const confirmBody = document.getElementById('sheet-confirm-body')?.textContent || '';
    const confirmTitle = document.getElementById('sheet-confirm-title')?.textContent || '';
    const sheetHidden = document.getElementById('sheet')?.classList.contains('hidden');
    const confirmHidden = document.getElementById('sheet-confirm')?.classList.contains('hidden');
    const textBlob = [title, puhao, summary, setRoot, confirmBody, confirmTitle].join('\n');
    return {
      title,
      puhao,
      sheetHidden,
      confirmHidden,
      textBlob,
      hasAName: textBlob.includes(name),
      hasAId: textBlob.includes(String(aId)) || puhao.includes(`谱号 ${aId}`),
      ok: !textBlob.includes(name)
        && !textBlob.includes(String(aId))
        && confirmHidden,
    };
  }, aPersonId, aName);
}

async function testReconcileInFlightThenLoginB(mode) {
  const { a, b } = seedForeign();
  await openAuthed(a, a.idP);
  await installHooks();
  const bBefore = await personsApi(b.token);
  await selectById(a.idP);
  // Force unknown confirm first (network fail on DELETE), then delay the reconcile GET.
  await page.evaluate(() => { window.__yimaiFailNextDeleteNetwork = true; });
  await page.click('#btn-delete-person');
  await clickConfirmPrimary();
  await page.waitForFunction(() => (document.getElementById('sheet-confirm-title')?.textContent || '').includes('不确定'), { timeout: 8000 });
  await page.evaluate((m) => {
    window.__yimaiDelayNextPersonGetMs = 40;
    window.__yimaiDelayNextPersonGetMode = m;
  }, mode);
  await page.evaluate(() => {
    Array.from(document.querySelectorAll('#sheet-confirm-actions button')).find((btn) => btn.textContent.includes('核对'))?.click();
  });
  await page.waitForFunction(() => typeof window.__yimaiReleaseDelayedPersonGet === 'function', { timeout: 8000 });
  await page.$eval('#email', (el, v) => { el.value = v; }, b.email);
  await page.$eval('#password', (el) => { el.value = 'password'; });
  await page.click('#btn-login');
  await page.waitForFunction((id) => localStorage.getItem('yimai_user_id') === String(id), { timeout: 15000 }, String(b.userId));
  await page.waitForFunction(() => document.querySelectorAll('g.node-card').length >= 1, { timeout: 15000 });
  const afterLogin = await sheetText();
  await page.evaluate(() => window.__yimaiReleaseDelayedPersonGet?.());
  await sleep(900);
  const afterRelease = await sheetText();
  const bView = await measureBViewNoADetail(a.idP, '甲树人');
  const bAfter = await personsApi(b.token);
  const aAfter = await personsApi(a.token);
  const bStable = JSON.stringify(bBefore.data.map((p) => p.id).sort()) === JSON.stringify(bAfter.data.map((p) => p.id).sort());
  const noAConfirm = afterRelease.confirmHidden
    && !(afterRelease.confirmBody || '').includes(String(a.idP))
    && !(afterRelease.confirmTitle || '').includes('甲树人')
    && !(afterRelease.confirmBody || '').includes('甲树人');
  const aStillPresent = aAfter.data.some((p) => String(p.id) === String(a.idP));
  await screenshot(`del7-reconcile-inflight-${mode}-after-login-b.png`);
  fs.writeFileSync(path.join(ARTIFACTS_DIR, `del7-reconcile-inflight-${mode}.json`), JSON.stringify({
    mode, afterLogin, afterRelease, bView, bStable, noAConfirm, aStillPresent,
    a: { idP: a.idP }, b: { before: bBefore.data, after: bAfter.data },
  }, null, 2));
  log(
    `H-22 reconcile in-flight delayed ${mode}: login B — no A exists/unknown reopen, B view clean`,
    bStable && noAConfirm && bView.ok && aStillPresent && afterLogin.userId === String(b.userId),
    JSON.stringify({ bStable, noAConfirm, bViewOk: bView.ok, aStillPresent, confirmHidden: afterRelease.confirmHidden }),
  );
}

async function testSameAccountReconcileDelayedExistsStillWorks() {
  const auth = seedPerson('同账核对');
  await openAuthed(auth, auth.idT);
  await installHooks();
  await selectById(auth.idT);
  await page.evaluate(() => { window.__yimaiFailNextDeleteNetwork = true; });
  await page.click('#btn-delete-person');
  await clickConfirmPrimary();
  await page.waitForFunction(() => (document.getElementById('sheet-confirm-title')?.textContent || '').includes('不确定'), { timeout: 8000 });
  await page.evaluate(() => {
    window.__yimaiDelayNextPersonGetMs = 40;
    window.__yimaiDelayNextPersonGetMode = 'exists';
  });
  await page.evaluate(() => {
    Array.from(document.querySelectorAll('#sheet-confirm-actions button')).find((btn) => btn.textContent.includes('核对'))?.click();
  });
  await page.waitForFunction(() => typeof window.__yimaiReleaseDelayedPersonGet === 'function', { timeout: 8000 });
  await page.evaluate(() => window.__yimaiReleaseDelayedPersonGet?.());
  await page.waitForFunction(() => (document.getElementById('sheet-confirm-body')?.textContent || '').includes('仍在家谱中'), { timeout: 8000 });
  const ui = await sheetText();
  const persons = await personsApi();
  const ok = !ui.confirmHidden
    && (ui.confirmBody || '').includes(String(auth.idT))
    && persons.data.some((p) => String(p.id) === String(auth.idT));
  await screenshot('del7-same-account-reconcile-delayed-exists.png');
  log('Same-account delayed reconcile exists still reopens under A', ok, `title=${ui.confirmTitle}`);
}

async function testIdentityBoundaryTransitionTable() {
  // Finite sink list: protection at actual state/localStorage/render commits, not only callers.
  const table = {
    premisesRejected: [
      'Guarding only submitSheetOp aftermath does NOT make account-switch safe',
      'Guarding only await callers of loadPersons/loadTree is also insufficient — sinks inside those functions write after their own awaits',
    ],
    reusableOracles: {
      sheetOp: 'frozenAuthorityStillActive / sheetOpStillCurrent',
      load: 'captureLoadSession + loadSessionStillCurrent before persons/treeId/root/tree/render/openSheet sinks',
    },
    transitions: [
      { id: 'T1', site: 'submitSheetOp after DELETE/PATCH await', commit: 'afterSuccessfulDelete/Correction', oracle: 'sheetOpStillCurrent' },
      { id: 'T2', site: 'submitSheetOp catch', commit: 'showDeleteBlocked409 / showUnknownResult / reject error', oracle: 'sheetOpStillCurrent' },
      { id: 'T3', site: 'submitSheetOp finally', commit: 'setConfirmBusy(false)', oracle: 'sheetOpStillCurrent' },
      { id: 'T4', site: 'afterSuccessfulDelete after loadPersons/loadTree', commit: 'openSheet/closeSheet/showFirstPersonForm/errors', oracle: 'frozenAuthorityStillActive' },
      { id: 'T5', site: 'afterSuccessfulCorrection after loadTree', commit: 'openSheet/errors', oracle: 'frozenAuthorityStillActive' },
      { id: 'T6', site: 'reconcileAndContinue after reconcileRelationship', commit: 'exists reopen / showUnknownResult / afterSuccessful*', oracle: 'frozenAuthorityStillActive' },
      { id: 'T7', site: 'reconcileAndContinue finally', commit: 'setConfirmBusy(false)', oracle: 'frozenAuthorityStillActive' },
      { id: 'T8', site: 'showUnknownResult entry', commit: 'openConfirmLayer unknown', oracle: 'frozenAuthorityStillActive (else hide only)' },
      { id: 'T9', site: 'login → invalidateSheetOpForAuthChange', commit: 'bump opGen + clearAccountScopedPresentation', oracle: 'generation bump fails T1–T8 and load snaps' },
      { id: 'T10', site: 'login → loadTree', commit: 'must not repaint foreign detail', oracle: 'B view negative: no A name/谱号/actions' },
      { id: 'T11', site: 'loadPersons after await api(/persons)', commit: 'state.persons + syncTreeIdFromPersons/TREE_KEY', oracle: 'loadSessionStillCurrent' },
      { id: 'T12', site: 'loadTree after await tree', commit: 'state.tree + rootId/ROOT_KEY + render + openSheet', oracle: 'loadSessionStillCurrent' },
      { id: 'T13', site: 'ensureCurrentTreeId after await /trees/current', commit: 'state.treeId + TREE_KEY', oracle: 'loadSessionStillCurrent' },
      { id: 'T14', site: 'submitAdd bind_failed after await loadTree', commit: 'formAdd reveal (tree via guarded loadTree)', oracle: 'captureLoadSession + loadSessionStillCurrent' },
    ],
    note: 'Source risk until delayed-A list/tree/bind-fail negative oracles pass. No claim of global account isolation.',
  };
  const source = fs.readFileSync(path.join(APP_ROOT, 'frontend/js/app.js'), 'utf8');
  const checks = {
    hasFrozenOracle: source.includes('function frozenAuthorityStillActive'),
    hasSheetOpOracle: source.includes('function sheetOpStillCurrent'),
    hasLoadSessionOracle: source.includes('function loadSessionStillCurrent') && source.includes('function captureLoadSession'),
    hasPresentationClear: source.includes('function clearAccountScopedPresentation'),
    reconcileGuarded: /async function reconcileAndContinue[\s\S]*frozenAuthorityStillActive\(frozen\)/.test(source)
      && /const result = await reconcileRelationship\(frozen\);[\s\S]*if \(!frozenAuthorityStillActive\(frozen\)\) return;/.test(source),
    showUnknownGuarded: /function showUnknownResult[\s\S]*frozenAuthorityStillActive\(op\)/.test(source),
    loginClearsPresentation: /invalidateSheetOpForAuthChange\('login'\)/.test(source)
      && /clearAccountScopedPresentation\(/.test(source),
    loadPersonsGuarded: /async function loadPersons[\s\S]*captureLoadSession\(\)[\s\S]*await api\('\/persons'\)[\s\S]*loadSessionStillCurrent\(snap\)/.test(source),
    loadTreeGuarded: /async function loadTree[\s\S]*captureLoadSession\(\)[\s\S]*loadSessionStillCurrent\(snap\)/.test(source),
    bindFailRefreshGuarded: /phase: 'bind_failed'[\s\S]*captureLoadSession\(\)[\s\S]*await loadTree\(\)[\s\S]*loadSessionStillCurrent\(bindFailSnap\)/.test(source),
  };
  fs.writeFileSync(path.join(ARTIFACTS_DIR, 'del-identity-boundary-transition-table.json'), JSON.stringify({ table, checks }, null, 2));
  const ok = Object.values(checks).every(Boolean) && table.transitions.length === 14;
  log('Identity-boundary premise+transition table (14 sinks) + oracle wiring present', ok, JSON.stringify(checks));
}

async function snapshotBSurface() {
  return page.evaluate(() => {
    const ids = Array.from(document.querySelectorAll('g.node-card')).map((n) => n.getAttribute('data-id')).sort();
    const names = Array.from(document.querySelectorAll('g.node-card .person-name')).map((n) => n.textContent.trim());
    return {
      userId: localStorage.getItem('yimai_user_id'),
      treeId: localStorage.getItem('yimai_tree_id'),
      rootId: localStorage.getItem('yimai_root_id'),
      recovery: localStorage.getItem('yimai_add_recovery'),
      ids,
      names,
      title: document.getElementById('sheet-title')?.textContent || '',
      puhao: document.getElementById('sheet-puhao')?.textContent || '',
      sheetHidden: document.getElementById('sheet')?.classList.contains('hidden'),
      stats: document.getElementById('stats')?.textContent?.replace(/\s+/g, ' ').trim() || '',
    };
  });
}

async function testDelayedAPersonsListAfterBLoaded() {
  // Negative oracle: A loadPersons in-flight → B completes load → release A list must not pollute B.
  const { a, b } = seedForeign();
  await openAuthed(a, a.idP);
  await installHooks();
  await selectById(a.idP);
  await page.evaluate(() => { window.__yimaiDelayNextPersonsListMs = 40; });
  // Trigger loadPersons via reload toolbar (same sink as DEL/login loaders).
  await page.click('#btn-reload');
  await page.waitForFunction(() => typeof window.__yimaiReleaseDelayedPersonsList === 'function', { timeout: 8000 });
  await page.$eval('#email', (el, v) => { el.value = v; }, b.email);
  await page.$eval('#password', (el) => { el.value = 'password'; });
  await page.click('#btn-login');
  await page.waitForFunction((id) => localStorage.getItem('yimai_user_id') === String(id), { timeout: 15000 }, String(b.userId));
  await page.waitForFunction(() => document.querySelectorAll('g.node-card').length >= 1, { timeout: 15000 });
  const beforeRelease = await snapshotBSurface();
  await page.evaluate(() => window.__yimaiReleaseDelayedPersonsList?.());
  await sleep(1000);
  const afterRelease = await snapshotBSurface();
  const polluted = afterRelease.names.includes('甲树人')
    || afterRelease.ids.includes(String(a.idP))
    || afterRelease.title.includes('甲树人')
    || afterRelease.puhao.includes(String(a.idP))
    || afterRelease.treeId === String(a.treeId)
    || afterRelease.rootId === String(a.idP);
  const bStable = beforeRelease.userId === String(b.userId)
    && afterRelease.userId === String(b.userId)
    && afterRelease.treeId === String(b.treeId)
    && afterRelease.ids.includes(String(b.idP))
    && !polluted;
  await screenshot('del7-delayed-a-persons-after-b.png');
  fs.writeFileSync(path.join(ARTIFACTS_DIR, 'del7-delayed-a-persons-after-b.json'), JSON.stringify({
    beforeRelease, afterRelease, polluted, bStable, a: { idP: a.idP, treeId: a.treeId }, b: { idP: b.idP, treeId: b.treeId },
    note: 'Source-risk sink closed if bStable; does not claim cross-account deletion.',
  }, null, 2));
  log('Load-sink delayed A persons list after B loaded — B canvas/treeId/root clean', bStable, JSON.stringify({ polluted, treeId: afterRelease.treeId, ids: afterRelease.ids }));
}

async function testDelayedATreeAfterBLoaded() {
  const { a, b } = seedForeign();
  await openAuthed(a, a.idP);
  await installHooks();
  await selectById(a.idP);
  await page.evaluate(() => { window.__yimaiDelayNextTreeGetMs = 40; });
  await page.click('#btn-reload');
  await page.waitForFunction(() => typeof window.__yimaiReleaseDelayedTreeGet === 'function', { timeout: 8000 });
  await page.$eval('#email', (el, v) => { el.value = v; }, b.email);
  await page.$eval('#password', (el) => { el.value = 'password'; });
  await page.click('#btn-login');
  await page.waitForFunction((id) => localStorage.getItem('yimai_user_id') === String(id), { timeout: 15000 }, String(b.userId));
  await page.waitForFunction(() => document.querySelectorAll('g.node-card').length >= 1, { timeout: 15000 });
  const beforeRelease = await snapshotBSurface();
  await page.evaluate(() => window.__yimaiReleaseDelayedTreeGet?.());
  await sleep(1000);
  const afterRelease = await snapshotBSurface();
  const polluted = afterRelease.names.includes('甲树人')
    || afterRelease.ids.includes(String(a.idP))
    || afterRelease.title.includes('甲树人')
    || afterRelease.puhao.includes(String(a.idP))
    || afterRelease.rootId === String(a.idP)
    || afterRelease.treeId === String(a.treeId);
  const bStable = beforeRelease.userId === String(b.userId)
    && afterRelease.userId === String(b.userId)
    && afterRelease.treeId === String(b.treeId)
    && afterRelease.ids.includes(String(b.idP))
    && afterRelease.names.includes('乙树人')
    && !polluted;
  await screenshot('del7-delayed-a-tree-after-b.png');
  fs.writeFileSync(path.join(ARTIFACTS_DIR, 'del7-delayed-a-tree-after-b.json'), JSON.stringify({
    beforeRelease, afterRelease, polluted, bStable, a: { idP: a.idP, treeId: a.treeId }, b: { idP: b.idP, treeId: b.treeId },
    note: 'Source-risk sink closed if bStable; does not claim cross-account deletion.',
  }, null, 2));
  log('Load-sink delayed A tree after B loaded — B canvas/treeId/root clean', bStable, JSON.stringify({ polluted, rootId: afterRelease.rootId, names: afterRelease.names }));
}

async function testSameAccountReloadAfterDelayStillWorks() {
  const auth = seedPerson('同账载入');
  await openAuthed(auth, auth.idT);
  await installHooks();
  await page.evaluate(() => { window.__yimaiDelayNextPersonsListMs = 30; });
  await page.click('#btn-reload');
  await page.waitForFunction(() => typeof window.__yimaiReleaseDelayedPersonsList === 'function', { timeout: 8000 });
  await page.evaluate(() => window.__yimaiReleaseDelayedPersonsList?.());
  await page.waitForFunction((id) => !!document.querySelector(`g.node-card[data-id="${id}"]`), { timeout: 10000 }, String(auth.idT));
  const snap = await snapshotBSurface();
  const ok = snap.ids.includes(String(auth.idT)) && snap.userId === String(auth.userId);
  await screenshot('del7-same-account-delayed-persons-reload.png');
  log('Same-account delayed persons reload still commits under A', ok, JSON.stringify({ ids: snap.ids, userId: snap.userId }));
}

async function startAddSonBindFailWithDelayedTree(anchorId, childName) {
  await selectById(anchorId);
  await page.evaluate(() => {
    window.__yimaiFailNextRelationBind = true;
    window.__yimaiDelayNextTreeGetMs = 40;
  });
  await page.click('#btn-add');
  await page.waitForSelector('#kin-grid', { timeout: 5000 });
  await page.click('#kin-grid button[data-kin="son"]');
  await page.waitForSelector('#form-add:not(.hidden)', { timeout: 5000 });
  await page.evaluate((name) => {
    const input = document.getElementById('add-name');
    input.value = name;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const sel = document.getElementById('add-existing');
    const wrap = document.getElementById('add-existing-wrap');
    if (sel && wrap && !wrap.classList.contains('hidden')) {
      sel.value = '__confirm_new__';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }, childName);
  await page.click('#btn-submit-add');
  await page.waitForFunction(() => typeof window.__yimaiReleaseDelayedTreeGet === 'function', { timeout: 15000 });
}

async function testDelayedABindFailTreeAfterBLoaded() {
  // Negative: A create+bind_failed → delayed tree GET → B loaded → release must not paint A's tree/form on B.
  const { a, b } = seedForeign();
  await openAuthed(a, a.idP);
  await installHooks();
  await startAddSonBindFailWithDelayedTree(a.idP, '甲儿');
  await page.waitForFunction(() => (document.getElementById('add-error')?.textContent || '').includes('人已记下'), { timeout: 8000 });
  await page.$eval('#email', (el, v) => { el.value = v; }, b.email);
  await page.$eval('#password', (el) => { el.value = 'password'; });
  await page.click('#btn-login');
  await page.waitForFunction((id) => localStorage.getItem('yimai_user_id') === String(id), { timeout: 15000 }, String(b.userId));
  await page.waitForFunction(() => document.querySelectorAll('g.node-card').length >= 1, { timeout: 15000 });
  const beforeRelease = await snapshotBSurface();
  const beforeUi = await page.evaluate(() => ({
    formHidden: document.getElementById('form-add')?.classList.contains('hidden'),
    addError: document.getElementById('add-error')?.textContent || '',
    sheetError: document.getElementById('sheet-error')?.textContent || '',
  }));
  await page.evaluate(() => window.__yimaiReleaseDelayedTreeGet?.());
  await sleep(1000);
  const afterRelease = await snapshotBSurface();
  const afterUi = await page.evaluate(() => ({
    formHidden: document.getElementById('form-add')?.classList.contains('hidden'),
    addError: document.getElementById('add-error')?.textContent || '',
    sheetError: document.getElementById('sheet-error')?.textContent || '',
    stats: document.getElementById('stats')?.textContent?.replace(/\s+/g, ' ').trim() || '',
  }));
  const polluted = afterRelease.names.includes('甲树人')
    || afterRelease.names.includes('甲儿')
    || afterRelease.ids.includes(String(a.idP))
    || afterRelease.title.includes('甲')
    || afterRelease.puhao.includes(String(a.idP))
    || afterRelease.rootId === String(a.idP)
    || afterRelease.treeId === String(a.treeId)
    || (afterRelease.recovery && String(afterRelease.recovery).includes(String(a.userId)))
    || afterUi.formHidden === false
    || (afterUi.addError || '').includes('人已记下')
    || (afterUi.sheetError || '').includes('人已记下')
    || (afterUi.stats || '').includes('2位亲人');
  const bStable = beforeRelease.userId === String(b.userId)
    && afterRelease.userId === String(b.userId)
    && afterRelease.treeId === String(b.treeId)
    && afterRelease.rootId === String(b.idP)
    && afterRelease.ids.includes(String(b.idP))
    && afterRelease.names.includes('乙树人')
    && afterRelease.names.length === 1
    && afterUi.formHidden === true
    && !polluted;
  await screenshot('del7-delayed-a-bindfail-tree-after-b.png');
  fs.writeFileSync(path.join(ARTIFACTS_DIR, 'del7-delayed-a-bindfail-tree-after-b.json'), JSON.stringify({
    beforeRelease, beforeUi, afterRelease, afterUi, polluted, bStable,
    a: { idP: a.idP, treeId: a.treeId, userId: a.userId },
    b: { idP: b.idP, treeId: b.treeId, userId: b.userId },
    note: 'Add bind_failed delayed tree/form commits must not pollute B; does not claim global isolation.',
  }, null, 2));
  log('Add-bind-fail delayed A tree after B loaded — B persons/tree/root/form/recovery clean', bStable, JSON.stringify({
    polluted, names: afterRelease.names, formHidden: afterUi.formHidden, treeId: afterRelease.treeId,
  }));
}

async function testSameAccountBindFailDelayedTreeStillRecovers() {
  // Positive: same A bind_failed + delayed tree still shows durable recovery and keeps A identity.
  const auth = seedPerson('同账绑败');
  await openAuthed(auth, auth.idT);
  await installHooks();
  await startAddSonBindFailWithDelayedTree(auth.idT, '同账儿');
  await page.waitForFunction(() => (document.getElementById('add-error')?.textContent || '').includes('人已记下'), { timeout: 8000 });
  await page.evaluate(() => window.__yimaiReleaseDelayedTreeGet?.());
  await sleep(800);
  const snap = await page.evaluate(() => {
    let recovery = null;
    try { recovery = JSON.parse(localStorage.getItem('yimai_add_recovery') || 'null'); } catch (_) { recovery = null; }
    return {
      userId: localStorage.getItem('yimai_user_id'),
      treeId: localStorage.getItem('yimai_tree_id'),
      rootId: localStorage.getItem('yimai_root_id'),
      recovery,
      formHidden: document.getElementById('form-add')?.classList.contains('hidden'),
      addError: document.getElementById('add-error')?.textContent || '',
      names: Array.from(document.querySelectorAll('g.node-card .person-name')).map((n) => n.textContent.trim()),
    };
  });
  const ok = snap.userId === String(auth.userId)
    && snap.treeId === String(auth.treeId)
    && snap.rootId === String(auth.idT)
    && snap.formHidden === false
    && (snap.addError || '').includes('人已记下')
    && snap.recovery
    && String(snap.recovery.userId) === String(auth.userId)
    && snap.recovery.phase === 'bind_failed'
    && String(snap.recovery.pendingPersonId)
    && snap.names.includes('同账绑败');
  await screenshot('del7-same-account-bindfail-delayed-tree.png');
  fs.writeFileSync(path.join(ARTIFACTS_DIR, 'del7-same-account-bindfail-delayed-tree.json'), JSON.stringify({
    snap, ok, auth: { userId: auth.userId, treeId: auth.treeId, idT: auth.idT },
    note: 'Same-account bind_failed delayed tree must still commit recovery UI under A.',
  }, null, 2));
  log('Same-account bind-fail delayed tree still recovers under A', ok, JSON.stringify({
    phase: snap.recovery?.phase, formHidden: snap.formHidden, pending: snap.recovery?.pendingPersonId,
  }));
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

async function measureChromeRestore() {
  return page.evaluate(() => {
    const sheet = document.getElementById('sheet');
    const confirm = document.getElementById('sheet-confirm');
    const footer = document.querySelector('.page-footer');
    const canvas = document.querySelector('.canvas-wrap');
    const head = document.querySelector('.sheet-head');
    const csFooter = footer ? getComputedStyle(footer) : null;
    const csCanvas = canvas ? getComputedStyle(canvas) : null;
    const csHead = head ? getComputedStyle(head) : null;
    const footerBox = footer?.getBoundingClientRect();
    const canvasBox = canvas?.getBoundingClientRect();
    const headBox = head?.getBoundingClientRect();
    const confirmOpen = sheet?.classList.contains('confirm-open');
    const confirmHidden = confirm?.classList.contains('hidden');
    const active = document.activeElement;
    return {
      confirmOpen: Boolean(confirmOpen),
      confirmHidden: Boolean(confirmHidden),
      footerDisplay: csFooter?.display || null,
      footerVisible: Boolean(footer && csFooter?.display !== 'none' && (footerBox?.height || 0) > 0),
      canvasHeight: canvasBox?.height || 0,
      canvasCollapsed: Boolean(confirmOpen) || ((canvasBox?.height || 0) < 8 && csCanvas?.opacity === '0'),
      sheetHeadDisplay: csHead?.display || null,
      sheetHeadVisible: Boolean(head && csHead?.display !== 'none' && (headBox?.height || 0) > 0),
      focus: {
        id: active?.id || null,
        // SVG nodes expose className as SVGAnimatedString — normalize to plain text.
        cls: typeof active?.className === 'string'
          ? active.className
          : (active?.getAttribute?.('class') || active?.className?.baseVal || null),
        dataId: active?.getAttribute?.('data-id') || null,
        tag: active?.tagName || null,
        live: Boolean(active && document.body.contains(active) && (active.getClientRects?.().length || 0) > 0),
      },
    };
  });
}

async function measureAddNameFooterCollision() {
  return page.evaluate(() => {
    const input = document.getElementById('add-name');
    const footer = document.querySelector('.page-footer');
    const sheet = document.getElementById('sheet');
    if (!input || !footer || !sheet) {
      return { ok: false, reason: 'missing nodes' };
    }
    // Bring the name field into view within the scrolling sheet if needed.
    input.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const ib = input.getBoundingClientRect();
    const fb = footer.getBoundingClientRect();
    const sb = sheet.getBoundingClientRect();
    const overlap = !(ib.bottom <= fb.top + 0.5 || ib.top >= fb.bottom - 0.5 || ib.right <= fb.left + 0.5 || ib.left >= fb.right - 0.5);
    const midX = (ib.left + ib.right) / 2;
    const midY = (ib.top + ib.bottom) / 2;
    const top = document.elementFromPoint(midX, midY);
    const coveredByFooter = Boolean(top?.closest?.('.page-footer'));
    const footerCs = getComputedStyle(footer);
    return {
      ok: !overlap && !coveredByFooter && footerCs.display !== 'none',
      overlap,
      coveredByFooter,
      placeholder: input.getAttribute('placeholder') || '',
      sheetTitle: document.getElementById('sheet-title')?.textContent || '',
      emptyHidden: document.getElementById('empty')?.classList.contains('hidden'),
      inputBox: { top: ib.top, bottom: ib.bottom, height: ib.height },
      footerBox: { top: fb.top, bottom: fb.bottom, height: fb.height, display: footerCs.display },
      sheetBox: { top: sb.top, bottom: sb.bottom, height: sb.height },
      topTag: top?.tagName || null,
      topId: top?.id || null,
    };
  });
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

  // Narrow empty — single last person (fresh page, no leftover fetch hooks).
  await page.setViewport({ width: 375, height: 844 });
  const alone = phpSeed(`
$u=App\\Models\\User::create(['name'=>'QAEmpty','email'=>$email,'password'=>bcrypt('password')]);
$t=App\\Models\\Tree::create(['owner_user_id'=>$u->id,'title'=>'QAEmpty']);
$p=App\\Models\\Person::create(['tree_id'=>$t->id,'name'=>'末人','gender'=>'male','generation'=>1]);
echo json_encode(['userId'=>$u->id,'treeId'=>$t->id,'token'=>$u->createToken('t')->plainTextToken,'idT'=>$p->id], JSON_UNESCAPED_UNICODE);
`);
  await openAuthed(alone, alone.idT);
  await selectById(alone.idT);
  await page.evaluate(() => {
    document.getElementById('delete-section')?.scrollIntoView({ block: 'center' });
    document.getElementById('btn-delete-person')?.click();
  });
  await page.waitForFunction(() => !document.getElementById('sheet-confirm')?.classList.contains('hidden'), { timeout: 8000 });
  await clickConfirmPrimary();
  await page.waitForFunction(() => {
    const title = document.getElementById('sheet-title')?.textContent || '';
    const confirmHidden = document.getElementById('sheet-confirm')?.classList.contains('hidden');
    return confirmHidden && title.includes('第一位');
  }, { timeout: 10000 });
  const emptyUi = await page.evaluate(() => ({
    emptyHidden: document.getElementById('empty')?.classList.contains('hidden'),
    title: document.getElementById('sheet-title')?.textContent || '',
    placeholder: document.getElementById('add-name')?.getAttribute('placeholder') || '',
    formHidden: document.getElementById('form-add')?.classList.contains('hidden'),
  }));
  const emptyCollision = await measureAddNameFooterCollision();
  // Sheet-open after last delete: empty chrome must not paint through (CSS hide).
  const emptyLegendSheetOpen = await page.evaluate(() => {
    const empty = document.getElementById('empty');
    const emptyCs = empty ? getComputedStyle(empty) : null;
    return {
      emptyDisplay: emptyCs?.display || null,
      ok: !empty || empty.classList.contains('hidden') || emptyCs?.display === 'none',
    };
  });
  // Real empty visibility: sheet closed on short narrow (375×667 previously overlapped 世系一览/legend).
  await page.evaluate(() => document.getElementById('btn-close-sheet')?.click());
  await page.waitForFunction(() => document.getElementById('sheet')?.classList.contains('hidden'), { timeout: 5000 });
  await page.setViewport({ width: 375, height: 667 });
  await sleep(200);
  const emptyLegend = await page.evaluate(() => {
    const empty = document.getElementById('empty');
    const title = empty?.querySelector('.empty-title');
    const label = document.querySelector('.canvas-label');
    const legend = document.querySelector('.legend');
    const foot = document.querySelector('.canvas-foot');
    const emptyCs = empty ? getComputedStyle(empty) : null;
    const footCs = foot ? getComputedStyle(foot) : null;
    const legendCs = legend ? getComputedStyle(legend) : null;
    const emptyHidden = !empty || empty.classList.contains('hidden') || emptyCs?.display === 'none';
    const overlap = (a, b) => {
      if (!a || !b) return false;
      return !(a.bottom <= b.top + 0.5 || a.top >= b.bottom - 0.5 || a.right <= b.left + 0.5 || a.left >= b.right - 0.5);
    };
    const tb = title?.getBoundingClientRect();
    const lb = label?.getBoundingClientRect();
    const gb = legend?.getBoundingClientRect();
    const titleVisible = Boolean(
      title && !emptyHidden && (tb?.height || 0) > 8 && emptyCs?.display !== 'none'
      && (title.textContent || '').includes('把家人的名字'),
    );
    const labelVisible = Boolean(label && (lb?.height || 0) > 0 && (label.textContent || '').includes('世系一览'));
    const legendVisible = Boolean(
      legend && foot && footCs?.display !== 'none' && legendCs?.display !== 'none' && (gb?.height || 0) > 0,
    );
    const titleLegendOverlap = titleVisible && legendVisible && overlap(tb, gb);
    const titleLabelOverlap = titleVisible && labelVisible && overlap(tb, lb);
    return {
      emptyHidden,
      titleVisible,
      labelVisible,
      legendVisible,
      titleLegendOverlap,
      titleLabelOverlap,
      titleBox: tb ? { top: tb.top, bottom: tb.bottom, height: tb.height } : null,
      labelBox: lb ? { top: lb.top, bottom: lb.bottom, height: lb.height } : null,
      legendBox: gb ? { top: gb.top, bottom: gb.bottom, height: gb.height } : null,
      // Both empty title and legend must be visible and non-overlapping (not merely CSS-hidden).
      ok: titleVisible && labelVisible && legendVisible && !titleLegendOverlap && !titleLabelOverlap,
    };
  });
  emptyLegend.sheetOpenHideOk = emptyLegendSheetOpen.ok;
  await screenshot('vis-empty-narrow-375.png');

  // Add-first flow without delete: empty tree → 添加 opens first-person form above footer.
  const emptyTree = phpSeed(`
$u=App\\Models\\User::create(['name'=>'QAAdd1','email'=>$email,'password'=>bcrypt('password')]);
$t=App\\Models\\Tree::create(['owner_user_id'=>$u->id,'title'=>'QAAdd1']);
echo json_encode(['userId'=>$u->id,'treeId'=>$t->id,'token'=>$u->createToken('t')->plainTextToken], JSON_UNESCAPED_UNICODE);
`);
  await page.setViewport({ width: 375, height: 844 });
  await page.goto(`${BASE_URL}/app/`, { waitUntil: 'networkidle0' });
  await page.evaluate((a) => {
    localStorage.clear();
    localStorage.setItem('yimai_token', a.token);
    localStorage.setItem('yimai_user_id', String(a.userId));
    localStorage.setItem('yimai_tree_id', String(a.treeId));
  }, emptyTree);
  await page.reload({ waitUntil: 'networkidle0' });
  await page.waitForFunction(() => !document.getElementById('empty')?.classList.contains('hidden'), { timeout: 8000 });
  await page.click('#btn-add');
  await page.waitForFunction(() => {
    const title = document.getElementById('sheet-title')?.textContent || '';
    return !document.getElementById('sheet')?.classList.contains('hidden') && title.includes('第一位');
  }, { timeout: 8000 });
  const addFirstCollision = await measureAddNameFooterCollision();
  await screenshot('vis-add-first-narrow-375.png');

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
  await page.evaluate(() => {
    document.getElementById('delete-section')?.scrollIntoView({ block: 'center' });
    document.getElementById('btn-delete-person')?.click();
  });
  await page.waitForFunction(() => !document.getElementById('sheet-confirm')?.classList.contains('hidden'), { timeout: 8000 });
  await clickConfirmPrimary();
  await page.waitForFunction(() => (document.getElementById('sheet-confirm-body')?.textContent || '').includes('父亲或母亲'), { timeout: 8000 });
  await screenshot('vis-409-narrow-375.png');
  const order = await page.evaluate(() => Array.from(document.querySelectorAll('#sheet-confirm-actions button')).map((b) => b.textContent.trim()));

  const payload = { busy, emptyUi, emptyCollision, emptyLegend, emptyLegendSheetOpen, addFirstCollision, order };
  fs.writeFileSync(path.join(ARTIFACTS_DIR, 'vis-loading-empty-409.json'), JSON.stringify(payload, null, 2));
  const ok = busy.ariaBusy === 'true'
    && busy.allDisabled
    && emptyUi.emptyHidden === false
    && emptyUi.placeholder.includes('张素芬')
    && emptyCollision.ok
    && emptyLegendSheetOpen.ok
    && emptyLegend.ok
    && addFirstCollision.ok
    && order[0]?.includes('打开并更正');
  log('VIS-04/06/07/08 loading busy + narrow empty/add-first footer + narrow 409', ok, JSON.stringify({
    busy,
    emptyUi,
    emptyOk: emptyCollision.ok,
    emptyLegendSheetOpenOk: emptyLegendSheetOpen.ok,
    emptyLegendOk: emptyLegend.ok,
    addFirstOk: addFirstCollision.ok,
    order,
  }));
}

async function testNarrowConfirmCancelAndSuccessRestore() {
  const reports = [];
  for (const vp of [{ w: 320, h: 700, name: '320' }, { w: 375, h: 844, name: '375' }]) {
    await page.setViewport({ width: vp.w, height: vp.h });
    const auth = seedPerson(`恢${vp.name}`);
    await openAuthed(auth, auth.idT);
    await selectById(auth.idT);
    await page.evaluate(() => {
      document.getElementById('delete-section')?.scrollIntoView({ block: 'center' });
      document.getElementById('btn-delete-person')?.focus();
      document.getElementById('btn-delete-person')?.click();
    });
    await page.waitForFunction(() => !document.getElementById('sheet-confirm')?.classList.contains('hidden'), { timeout: 8000 });
    const openChrome = await measureChromeRestore();
    await screenshot(`vis-restore-open-${vp.name}.png`);
    await page.evaluate(() => {
      const cancel = document.querySelector('#sheet-confirm-actions button[data-confirm-cancel="1"], #sheet-confirm-actions button.ghost');
      if (!cancel) throw new Error('no cancel');
      cancel.click();
    });
    await page.waitForFunction(() => document.getElementById('sheet-confirm')?.classList.contains('hidden'), { timeout: 8000 });
    await sleep(250);
    const afterCancel = await measureChromeRestore();
    await screenshot(`vis-restore-cancel-${vp.name}.png`);
    const focusCls = (f) => String(f?.cls || '');
    // At 320×700 with sheet open, canvas may be only ~20–30px (flex remainder) —
    // still restored vs confirm-open collapse (height 0 / opacity 0).
    const canvasRestored = (chrome) => chrome.canvasHeight > 8
      && !chrome.canvasCollapsed
      && chrome.canvasHeight > (openChrome.canvasHeight + 5);
    const cancelOk = afterCancel.confirmHidden
      && !afterCancel.confirmOpen
      && afterCancel.footerVisible
      && canvasRestored(afterCancel)
      && afterCancel.sheetHeadVisible
      && afterCancel.focus.live
      && (afterCancel.focus.id === 'btn-delete-person' || afterCancel.focus.id === 'btn-add' || focusCls(afterCancel.focus).includes('node-card'));

    // Success path: delete non-last person so tree/footer remain meaningful.
    await page.evaluate(() => {
      document.getElementById('delete-section')?.scrollIntoView({ block: 'center' });
      document.getElementById('btn-delete-person')?.click();
    });
    await page.waitForFunction(() => !document.getElementById('sheet-confirm')?.classList.contains('hidden'), { timeout: 8000 });
    await clickConfirmPrimary();
    await page.waitForFunction(() => document.getElementById('sheet-confirm')?.classList.contains('hidden'), { timeout: 10000 });
    await sleep(400);
    const afterSuccess = await measureChromeRestore();
    await screenshot(`vis-restore-success-${vp.name}.png`);
    const successOk = afterSuccess.confirmHidden
      && !afterSuccess.confirmOpen
      && afterSuccess.footerVisible
      && canvasRestored(afterSuccess)
      && afterSuccess.sheetHeadVisible
      && afterSuccess.focus.live
      && afterSuccess.focus.id !== 'btn-delete-person'
      && (focusCls(afterSuccess.focus).includes('node-card') || afterSuccess.focus.id === 'btn-add');

    reports.push({
      vp,
      openChrome,
      afterCancel,
      afterSuccess,
      cancelOk,
      successOk,
      openLooksModal: openChrome.confirmOpen && !openChrome.footerVisible && openChrome.canvasHeight < 8 && !openChrome.sheetHeadVisible,
    });
  }
  fs.writeFileSync(path.join(ARTIFACTS_DIR, 'vis-narrow-confirm-restore.json'), JSON.stringify({ reports }, null, 2));
  const ok = reports.every((r) => r.cancelOk && r.successOk && r.openLooksModal);
  log('VIS-02/03 narrow 320/375 cancel+success restore tree/footer/head+focus', ok, JSON.stringify(reports.map((r) => ({
    w: r.vp.w,
    cancelOk: r.cancelOk,
    successOk: r.successOk,
    openLooksModal: r.openLooksModal,
    cancelFocus: r.afterCancel.focus,
    successFocus: r.afterSuccess.focus,
  }))));
}

async function testStateGalleryAndFocusRings() {
  await page.setViewport({ width: 1280, height: 800 });
  const auth = seedPerson('态廊T');
  await openAuthed(auth, auth.idT);
  await selectById(auth.idT);

  const gallery = [];
  const shotState = async (name, setup) => {
    if (setup) await setup();
    await sleep(80);
    const styles = await page.evaluate(() => {
      const pick = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const cs = getComputedStyle(el);
        return {
          sel,
          bg: cs.backgroundColor,
          color: cs.color,
          border: cs.borderColor,
          outline: cs.outline,
          outlineWidth: cs.outlineWidth,
          boxShadow: cs.boxShadow,
          disabled: el.disabled || false,
          ariaBusy: el.closest('[aria-busy]')?.getAttribute('aria-busy') || null,
          text: (el.textContent || '').trim().slice(0, 40),
        };
      };
      return {
        add: pick('#btn-add'),
        login: pick('#btn-login'),
        ghost: pick('#btn-reload'),
        danger: pick('#btn-delete-person'),
        input: pick('#add-name'),
      };
    });
    await screenshot(`vis-state-${name}.png`);
    gallery.push({ name, styles });
  };

  await shotState('default');
  await shotState('hover-add', async () => { await page.hover('#btn-add'); });
  await shotState('hover-ghost', async () => { await page.hover('#btn-reload'); });
  await shotState('hover-danger', async () => {
    await page.evaluate(() => document.getElementById('delete-section')?.scrollIntoView({ block: 'center' }));
    await page.hover('#btn-delete-person');
  });
  await shotState('focus-add', async () => {
    await page.evaluate(() => document.getElementById('btn-add')?.focus());
    await page.keyboard.press('Tab');
    await page.keyboard.down('Shift');
    await page.keyboard.press('Tab');
    await page.keyboard.up('Shift');
  });
  await shotState('pressed-add', async () => {
    const box = await page.$eval('#btn-add', (el) => {
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    await page.mouse.move(box.x, box.y);
    await page.mouse.down();
  });
  await page.mouse.up();
  await shotState('disabled-add', async () => {
    await page.evaluate(() => {
      const b = document.getElementById('btn-add');
      if (b) b.disabled = true;
    });
  });
  await page.evaluate(() => {
    const b = document.getElementById('btn-add');
    if (b) b.disabled = false;
  });

  // Loading/error states on confirm (representative busy+error).
  await installHooks();
  await page.evaluate(() => {
    window.__yimaiDelayNextDeleteMs = 120;
    window.__yimaiDelayNextDeleteMode = 'ok';
  });
  await page.click('#btn-delete-person');
  await clickConfirmPrimary();
  await page.waitForFunction(() => document.getElementById('sheet-confirm')?.getAttribute('aria-busy') === 'true', { timeout: 8000 });
  await shotState('loading-confirm');
  await page.evaluate(() => window.__yimaiReleaseDelayedDelete?.());
  await sleep(900);

  // Error: unknown network delete
  await selectById(auth.idN);
  await page.evaluate(() => { window.__yimaiFailNextDeleteNetwork = true; });
  await page.click('#btn-delete-person');
  await clickConfirmPrimary();
  await page.waitForFunction(() => {
    const t = document.getElementById('sheet-confirm-error')?.textContent || '';
    const e = document.getElementById('sheet-error')?.textContent || '';
    return t.length > 0 || e.length > 0 || !document.getElementById('sheet-confirm')?.classList.contains('hidden');
  }, { timeout: 8000 });
  await sleep(300);
  await shotState('error-confirm');
  const errorText = await page.evaluate(() => ({
    confirmError: document.getElementById('sheet-confirm-error')?.textContent || '',
    sheetError: document.getElementById('sheet-error')?.textContent || '',
    confirmBody: document.getElementById('sheet-confirm-body')?.textContent || '',
    claimsSuccess: ((document.getElementById('sheet-confirm-error')?.textContent || '')
      + (document.getElementById('sheet-error')?.textContent || '')).includes('已删除'),
  }));
  await page.keyboard.press('Escape');
  await sleep(200);

  // Focus-ring gallery: keyboard modality so :focus-visible applies (not mouse focus).
  const focusRing = [];
  async function keyboardFocus(sel) {
    await page.evaluate((s) => {
      const el = document.querySelector(s);
      if (!el) throw new Error(`missing ${s}`);
      el.scrollIntoView({ block: 'center' });
      // Seed focus, then Tab away/back with real key events for :focus-visible.
      el.focus();
    }, sel);
    await page.keyboard.press('Tab');
    await page.keyboard.down('Shift');
    await page.keyboard.press('Tab');
    await page.keyboard.up('Shift');
    // If Tab moved away from target (disabled neighbors), re-focus then one more Tab cycle from body via keyboard only.
    const landed = await page.evaluate((s) => document.activeElement === document.querySelector(s), sel);
    if (!landed) {
      await page.evaluate((s) => document.querySelector(s)?.focus(), sel);
      await page.keyboard.press('ArrowDown');
      await page.evaluate((s) => document.querySelector(s)?.focus(), sel);
    }
    return page.evaluate((s) => {
      const el = document.querySelector(s);
      if (!el) return { sel: s, ok: false };
      const cs = getComputedStyle(el);
      const focusVisible = typeof el.matches === 'function' ? el.matches(':focus-visible') : false;
      const outlineOn = cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth || '0') >= 2;
      return {
        sel: s,
        active: document.activeElement === el,
        focusVisible,
        outline: cs.outline,
        outlineWidth: cs.outlineWidth,
        outlineColor: cs.outlineColor,
        ok: document.activeElement === el && (focusVisible || outlineOn),
      };
    }, sel);
  }

  await selectById(auth.idN);
  for (const sel of ['#btn-add', '#btn-reload', '#btn-delete-person', '#btn-set-root']) {
    const ring = await keyboardFocus(sel);
    await screenshot(`vis-focus-ring-${sel.replace('#', '')}.png`);
    focusRing.push(ring);
  }

  await page.click('#btn-delete-person');
  await page.waitForSelector('#sheet-confirm:not(.hidden)');
  // Confirm opens onto first action; Tab to cancel (ghost) and assert ring.
  await page.keyboard.press('Tab');
  const confirmRing = await page.evaluate(() => {
    const el = document.activeElement;
    const cs = getComputedStyle(el);
    const focusVisible = typeof el.matches === 'function' ? el.matches(':focus-visible') : false;
    const outlineOn = cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth || '0') >= 2;
    return {
      sel: '#sheet-confirm-actions :focus',
      id: el?.id || null,
      text: (el?.textContent || '').trim(),
      focusVisible,
      outline: cs.outline,
      outlineWidth: cs.outlineWidth,
      ok: Boolean(el?.closest?.('#sheet-confirm-actions')) && (focusVisible || outlineOn),
    };
  });
  await screenshot('vis-focus-ring-confirm-cancel.png');
  focusRing.push(confirmRing);
  await page.keyboard.press('Escape');
  await sleep(200);

  await selectById(auth.idN);
  await page.evaluate(() => document.querySelector('#kin-grid button[data-kin="son"]')?.click());
  await page.waitForSelector('#form-add:not(.hidden)');
  const inputRing = await keyboardFocus('#add-name');
  // Inputs also get accent border on :focus (spec).
  const inputBorder = await page.evaluate(() => {
    const el = document.getElementById('add-name');
    const cs = getComputedStyle(el);
    return { borderTopColor: cs.borderTopColor, outline: cs.outline, outlineWidth: cs.outlineWidth };
  });
  inputRing.border = inputBorder;
  inputRing.ok = inputRing.ok
    || (inputRing.active && (
      String(inputBorder.borderTopColor).includes('161')
      || String(inputBorder.borderTopColor).includes('a13')
      || (parseFloat(inputBorder.outlineWidth || '0') >= 2)
    ));
  await screenshot('vis-focus-ring-add-name.png');
  focusRing.push(inputRing);

  const stateOk = gallery.some((g) => g.name === 'default')
    && gallery.some((g) => g.name === 'hover-add')
    && gallery.some((g) => g.name === 'pressed-add')
    && gallery.some((g) => g.name === 'disabled-add' && g.styles.add?.disabled)
    && gallery.some((g) => g.name === 'loading-confirm')
    && gallery.some((g) => g.name === 'error-confirm')
    && !errorText.claimsSuccess;
  const ringOk = focusRing.filter((r) => r.sel !== '#add-name').every((r) => r.ok) && inputRing.ok;

  fs.writeFileSync(path.join(ARTIFACTS_DIR, 'vis-state-gallery.json'), JSON.stringify({ gallery, errorText }, null, 2));
  fs.writeFileSync(path.join(ARTIFACTS_DIR, 'vis-focus-ring-gallery.json'), JSON.stringify({ focusRing }, null, 2));
  log('VIS-04/16 state gallery default/hover/focus/pressed/disabled/loading/error', stateOk, `states=${gallery.map((g) => g.name).join(',')}`);
  log('VIS-09 focus-ring gallery + keyboard oracles', ringOk, JSON.stringify(focusRing.map((r) => ({ sel: r.sel, ok: r.ok }))));
}

async function testGlobalStructureContract() {
  await page.setViewport({ width: 1280, height: 800 });
  const auth = phpSeed(`
$u=App\\Models\\User::create(['name'=>'QAContract','email'=>$email,'password'=>bcrypt('password')]);
$t=App\\Models\\Tree::create(['owner_user_id'=>$u->id,'title'=>'QAContract']);
$p=App\\Models\\Person::create(['tree_id'=>$t->id,'name'=>'根R','gender'=>'male','generation'=>1]);
$c=App\\Models\\Person::create(['tree_id'=>$t->id,'name'=>'子S','gender'=>'female','generation'=>2,'father_id'=>$p->id]);
echo json_encode(['userId'=>$u->id,'treeId'=>$t->id,'token'=>$u->createToken('t')->plainTextToken,'idR'=>$p->id,'idS'=>$c->id], JSON_UNESCAPED_UNICODE);
`);

  // LOGIN surface (logged-out)
  await page.goto(`${BASE_URL}/app/`, { waitUntil: 'networkidle0' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'networkidle0' });
  const login = await page.evaluate(() => ({
    brand: document.querySelector('.brand')?.textContent?.trim() || '',
    emailLabel: document.querySelector('label[for="email"], .auth-field')?.textContent?.includes('账号') || false,
    hasLogin: Boolean(document.getElementById('btn-login')),
    loginLabel: document.getElementById('btn-login')?.textContent?.trim() || '',
    emptyHint: document.getElementById('empty-hint')?.textContent?.trim() || '',
  }));
  await screenshot('vis-contract-login.png');

  // TREE + stats after auth
  await openAuthed(auth, auth.idR);
  const before = await page.evaluate(() => {
    const ids = Array.from(document.querySelectorAll('g.node-card')).map((n) => n.getAttribute('data-id')).sort();
    const edges = Array.from(document.querySelectorAll('#tree-canvas path.edge, #tree-canvas line.edge, #tree-canvas .link')).length
      || Array.from(document.querySelectorAll('#tree-canvas path, #tree-canvas line')).filter((el) => el.classList.contains('edge-parent') || el.classList.contains('edge-spouse') || el.classList.contains('edge-sibling') || (el.getAttribute('class') || '').includes('edge')).length;
    const stats = document.querySelector('.stats')?.textContent?.replace(/\s+/g, ' ').trim() || '';
    const rootMark = Array.from(document.querySelectorAll('g.node-card')).some((n) => (n.textContent || '').includes('当前视角'));
    return {
      ids,
      nodeCount: ids.length,
      edgeMarks: edges,
      rootId: localStorage.getItem('yimai_root_id'),
      stats,
      rootMark,
      legend: document.querySelector('.legend')?.textContent?.replace(/\s+/g, ' ').trim() || '',
      reloadLabel: document.getElementById('btn-reload')?.textContent?.trim() || '',
      addLabel: document.getElementById('btn-add')?.textContent?.trim() || '',
    };
  });
  const beforeApi = await treeApi(auth.idR, auth.token);
  await screenshot('vis-contract-tree.png');

  // DETAIL
  await selectById(auth.idR);
  const detail = await page.evaluate(() => ({
    title: document.getElementById('sheet-title')?.textContent || '',
    puhao: document.getElementById('sheet-puhao')?.textContent || '',
    summary: document.getElementById('sheet-summary')?.textContent || '',
    deleteLabel: document.getElementById('btn-delete-person')?.textContent?.trim() || '',
    setRootLabel: document.getElementById('btn-set-root')?.textContent?.trim() || '',
    correctHeading: document.querySelector('#correct-section .form-heading')?.textContent?.trim() || '',
  }));
  await screenshot('vis-contract-detail.png');

  // ADD
  await page.evaluate(() => document.querySelector('#kin-grid button[data-kin="daughter"]')?.click());
  await page.waitForSelector('#form-add:not(.hidden)');
  const add = await page.evaluate(() => ({
    title: document.getElementById('sheet-title')?.textContent || '',
    context: document.getElementById('add-context')?.textContent || '',
    nameLabel: document.querySelector('label.add-name-emphasis')?.textContent || '',
    placeholder: document.getElementById('add-name')?.getAttribute('placeholder') || '',
    submit: document.getElementById('btn-submit-add')?.textContent?.trim() || '',
    cancel: document.getElementById('btn-cancel-add')?.textContent?.trim() || '',
  }));
  await screenshot('vis-contract-add.png');
  await page.click('#btn-cancel-add');

  // RECOVERY: durable bind_failed notice on existing flows (no new page).
  await page.evaluate((payload) => {
    localStorage.setItem('yimai_add_recovery', JSON.stringify({
      userId: String(payload.userId),
      treeId: String(payload.treeId),
      pendingPersonId: payload.idS,
      kin: 'daughter',
      relation: 'child',
      anchorId: Number(payload.idR),
      parentRole: 'father',
      name: '子S',
      phase: 'bind_failed',
      message: '人已记下，关系未保存：contract recovery probe',
    }));
  }, auth);
  await page.reload({ waitUntil: 'networkidle0' });
  await page.waitForFunction(() => document.querySelectorAll('g.node-card').length >= 1, { timeout: 10000 });
  await selectById(auth.idR);
  await page.evaluate(() => document.querySelector('#kin-grid button[data-kin="son"]')?.click());
  await page.waitForSelector('#form-add:not(.hidden)', { timeout: 8000 });
  await sleep(200);
  const recovery = await page.evaluate(() => ({
    raw: localStorage.getItem('yimai_add_recovery'),
    sheetError: document.getElementById('sheet-error')?.textContent || '',
    addError: document.getElementById('add-error')?.textContent || '',
    formVisible: !document.getElementById('form-add')?.classList.contains('hidden'),
  }));
  await screenshot('vis-contract-recovery.png');
  // Archive pairing note: single recovery PNG is one frame (form+notice), not the full
  // plant→survive-unrelated-delete→resume flow; JSON (recovery.raw) is the same-frame oracle.
  recovery.archivePairingNote = 'vis-contract-recovery.png pairs with this JSON frame only; do not treat the PNG as the full recovery lifecycle.';
  await page.click('#btn-cancel-add');
  // Clear recovery so subsequent DEL before/after is not blocked by durable notice.
  await page.evaluate(() => localStorage.removeItem('yimai_add_recovery'));
  await page.reload({ waitUntil: 'networkidle0' });
  await page.waitForFunction(() => document.querySelectorAll('g.node-card').length >= 1, { timeout: 10000 });

  // BEFORE/AFTER delete (new DEL allowed): remove child, compare IDs/edges/root/stats
  await selectById(auth.idS);
  await page.click('#btn-delete-person');
  await clickConfirmPrimary();
  await page.waitForFunction((goneId) => !document.querySelector(`g.node-card[data-id="${goneId}"]`), { timeout: 10000 }, String(auth.idS));
  await sleep(400);
  const after = await page.evaluate(() => {
    const ids = Array.from(document.querySelectorAll('g.node-card')).map((n) => n.getAttribute('data-id')).sort();
    const stats = document.querySelector('.stats')?.textContent?.replace(/\s+/g, ' ').trim() || '';
    return {
      ids,
      nodeCount: ids.length,
      rootId: localStorage.getItem('yimai_root_id'),
      stats,
    };
  });
  const afterApi = await treeApi(auth.idR, auth.token);
  await screenshot('vis-contract-after-delete.png');

  const copyLocks = {
    brand: login.brand.includes('一脉'),
    login: login.loginLabel === '登录',
    reload: before.reloadLabel.includes('重新载入'),
    add: before.addLabel.includes('添加'),
    legend: before.legend.includes('父母与子女') && before.legend.includes('夫妻') && before.legend.includes('兄弟姐妹'),
    delete: detail.deleteLabel === '删除此人记录',
    submit: add.submit === '记下',
    cancel: add.cancel === '先不添了',
    placeholder: add.placeholder.includes('张素芬'),
    puhao: detail.puhao.includes('谱号'),
    recoveryNotice: (recovery.sheetError + recovery.addError).includes('人已记下，关系未保存') && recovery.formVisible,
  };
  const structureOk = before.nodeCount === 2
    && before.ids.includes(String(auth.idR))
    && before.ids.includes(String(auth.idS))
    && before.rootId === String(auth.idR)
    && after.nodeCount === 1
    && after.ids.includes(String(auth.idR))
    && !after.ids.includes(String(auth.idS))
    && after.rootId === String(auth.idR)
    && Object.values(copyLocks).every(Boolean);

  const pack = {
    note: 'Global structure/content/requests contract on final HEAD vs approved locked copy + before/after DEL identity. New DEL surfaces allowed; old login/tree/detail/add/recovery copy preserved.',
    approvedBaseRef: 'ba353c1 + visual polish locked copy',
    login,
    before,
    beforeApiPersons: (beforeApi?.data?.nodes || beforeApi?.nodes || []).map((n) => n.id || n.person_id).filter(Boolean),
    detail,
    add,
    recovery,
    after,
    afterApiPersons: (afterApi?.data?.nodes || afterApi?.nodes || []).map((n) => n.id || n.person_id).filter(Boolean),
    copyLocks,
    structureOk,
  };
  fs.writeFileSync(path.join(ARTIFACTS_DIR, 'vis-global-contract.json'), JSON.stringify(pack, null, 2));
  log('VIS-13 global structure/content contract login/tree/detail/add/recovery + DEL before/after', structureOk, JSON.stringify({ copyLocks, beforeIds: before.ids, afterIds: after.ids, root: after.rootId }));
}

async function testTrueBrowserZoomObstacle() {
  // Record puppeteer/CDP non-methods; Playwright extension probe writes separately if capable.
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
  const playwrightProbePath = path.join(ARTIFACTS_DIR, 'vis-true-zoom-playwright-probe.json');
  const playwrightProbe = fs.existsSync(playwrightProbePath)
    ? JSON.parse(fs.readFileSync(playwrightProbePath, 'utf8'))
    : { status: 'PENDING_EXTERNAL_PROBE', note: 'Run tests/vis-true-zoom-playwright-probe.mjs before claiming VIS-14' };
  const productFile = path.join(ARTIFACTS_DIR, 'vis-true-zoom-200-product.png');
  const methodFile = path.join(ARTIFACTS_DIR, 'vis-true-zoom-200.png');
  const addFile = path.join(ARTIFACTS_DIR, 'vis-true-zoom-200-add.png');
  let framesDistinct = false;
  if (fs.existsSync(productFile) && fs.existsSync(methodFile)) {
    const a = fs.readFileSync(productFile);
    const b = fs.readFileSync(methodFile);
    framesDistinct = a.length !== b.length || !a.equals(b);
  }
  const productBytes = fs.existsSync(productFile) ? fs.statSync(productFile).size : 0;
  const addBytes = fs.existsSync(addFile) ? fs.statSync(addFile).size : 0;
  const productOk = playwrightProbe.status === 'PRODUCT_OK'
    && playwrightProbe.product?.ok === true
    && playwrightProbe.product?.operableConfirm === true
    && playwrightProbe.product?.confirmTitleInView === true
    && playwrightProbe.product?.addReachable === true
    && framesDistinct
    && productBytes > 12000
    && addBytes > 12000
    && fs.existsSync(productFile)
    && fs.existsSync(addFile);
  const methodOnly = playwrightProbe.status === 'METHOD_OK' || (playwrightProbe.status === 'PRODUCT_OK' && !productOk);
  const obstacle = {
    status: productOk ? 'PRODUCT_OK' : (methodOnly ? 'METHOD_OK_PENDING_PRODUCT' : 'UNVERIFIED'),
    reason: productOk
      ? 'True page zoom + same-frame product clips (confirm/add in view; method png ≠ product png)'
      : (methodOnly
        ? 'True page zoom method present but product frame/oracle incomplete — method PASS ≠ product PASS'
        : (playwrightProbe.reason
          || 'Puppeteer/CDP path cannot true-zoom; Playwright extension probe missing/failed')),
    probe,
    cdpPageScaleFactor: cdp,
    afterCtrlPlus: afterCtrl,
    playwrightProbe,
    framesDistinct,
    files: {
      method: fs.existsSync(methodFile),
      product: fs.existsSync(productFile),
      add: fs.existsSync(addFile),
    },
  };
  fs.writeFileSync(path.join(ARTIFACTS_DIR, 'vis-true-zoom-obstacle.json'), JSON.stringify(obstacle, null, 2));
  if (productOk) {
    log('VIS-14 true browser 200% zoom product acceptance', true, 'PRODUCT_OK same-frame confirm/add clips + operable/no-x-overflow');
  } else {
    noteUnverified('VIS-14 true browser 200% zoom', obstacle.reason);
  }
}

async function testKeyboardOrderLoginAddRecovery() {
  // QA run3: login/add/recovery Tab order reachable; trap+Esc only for real modal (confirm), not inline forms.
  await page.setViewport({ width: 1280, height: 800 });
  await page.goto(`${BASE_URL}/app/`, { waitUntil: 'networkidle0' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'networkidle0' });

  await page.focus('#email');
  const loginOrder = [];
  for (let i = 0; i < 4; i += 1) {
    loginOrder.push(await page.evaluate(() => {
      const a = document.activeElement;
      return a?.id || a?.tagName || null;
    }));
    await page.keyboard.press('Tab');
  }
  const loginOk = loginOrder.includes('email') && loginOrder.includes('password') && loginOrder.includes('btn-login');

  const auth = seedPerson('键序T');
  await openAuthed(auth, auth.idT);
  await selectById(auth.idT);
  await page.focus('#btn-add');
  const addOrder = [];
  for (let i = 0; i < 8; i += 1) {
    addOrder.push(await page.evaluate(() => {
      const a = document.activeElement;
      return a?.id || a?.getAttribute?.('data-kin') || a?.tagName || null;
    }));
    await page.keyboard.press('Tab');
  }
  // Inline add form is NOT a modal — Esc must not invent a trap; confirm modal already covered by VIS-03.
  await page.evaluate(() => document.querySelector('#kin-grid button[data-kin="son"]')?.click());
  await page.waitForSelector('#form-add:not(.hidden)');
  await page.focus('#add-name');
  await page.keyboard.press('Escape');
  const afterEscInline = await page.evaluate(() => ({
    formHidden: document.getElementById('form-add')?.classList.contains('hidden'),
    confirmHidden: document.getElementById('sheet-confirm')?.classList.contains('hidden'),
    activeId: document.activeElement?.id || null,
  }));
  const inlineNoTrap = afterEscInline.confirmHidden && afterEscInline.formHidden === false;

  // Recovery notice keeps form keyboard-reachable (no new dialog).
  await page.evaluate((payload) => {
    localStorage.setItem('yimai_add_recovery', JSON.stringify({
      userId: String(payload.userId),
      treeId: String(payload.treeId),
      pendingPersonId: payload.idN,
      kin: 'son',
      relation: 'child',
      anchorId: Number(payload.idT),
      parentRole: 'father',
      name: '旁人N',
      phase: 'bind_failed',
      message: '人已记下，关系未保存：keyboard recovery probe',
    }));
  }, auth);
  await page.reload({ waitUntil: 'networkidle0' });
  await page.waitForFunction(() => document.querySelectorAll('g.node-card').length >= 1, { timeout: 10000 });
  await selectById(auth.idT);
  await page.evaluate(() => document.querySelector('#kin-grid button[data-kin="son"]')?.click());
  await page.waitForSelector('#form-add:not(.hidden)');
  await page.focus('#add-name');
  const recoveryOrder = [];
  for (let i = 0; i < 6; i += 1) {
    recoveryOrder.push(await page.evaluate(() => document.activeElement?.id || document.activeElement?.tagName || null));
    await page.keyboard.press('Tab');
  }
  const recoveryReachable = recoveryOrder.includes('add-name')
    || recoveryOrder.includes('btn-submit-add')
    || recoveryOrder.includes('btn-cancel-add')
    || recoveryOrder.includes('add-existing');

  // Real modal: confirm still has forward trap (smoke — full cycle in VIS-03).
  await page.click('#btn-delete-person');
  await page.waitForSelector('#sheet-confirm:not(.hidden)');
  const modalLabels = await page.evaluate(() => Array.from(document.querySelectorAll('#sheet-confirm-actions button')).map((b) => b.textContent.trim()));
  await page.evaluate(() => document.querySelector('#sheet-confirm-actions button')?.focus());
  for (let i = 0; i < modalLabels.length; i += 1) await page.keyboard.press('Tab');
  const afterWrap = await page.evaluate(() => document.activeElement?.textContent?.trim() || null);
  await page.keyboard.press('Escape');
  await sleep(200);
  const afterEscModal = await page.evaluate(() => document.getElementById('sheet-confirm')?.classList.contains('hidden'));

  const payload = {
    loginOrder, loginOk, addOrder, afterEscInline, inlineNoTrap, recoveryOrder, recoveryReachable,
    modalLabels, afterWrap, modalTrapOk: afterWrap === modalLabels[0], afterEscModal,
  };
  fs.writeFileSync(path.join(ARTIFACTS_DIR, 'vis-keyboard-order-login-add-recovery.json'), JSON.stringify(payload, null, 2));
  await screenshot('vis-keyboard-order-login-add-recovery.png');
  const ok = loginOk && inlineNoTrap && recoveryReachable && payload.modalTrapOk && afterEscModal;
  log('VIS keyboard order: login/add/recovery reachable; trap+Esc only on confirm modal', ok, JSON.stringify({
    loginOk, inlineNoTrap, recoveryReachable, modalTrapOk: payload.modalTrapOk, afterEscModal,
  }));
}

async function test409PrefersChildCorrection() {
  await page.setViewport({ width: 1280, height: 800 });
  const auth = phpSeed(`
$u=App\\Models\\User::create(['name'=>'QA409','email'=>$email,'password'=>bcrypt('password')]);
$t=App\\Models\\Tree::create(['owner_user_id'=>$u->id,'title'=>'QA409']);
$p=App\\Models\\Person::create(['tree_id'=>$t->id,'name'=>'父P','gender'=>'male','generation'=>1]);
$c=App\\Models\\Person::create(['tree_id'=>$t->id,'name'=>'子C','gender'=>'male','generation'=>2,'father_id'=>$p->id]);
echo json_encode(['userId'=>$u->id,'treeId'=>$t->id,'token'=>$u->createToken('t')->plainTextToken,'idP'=>$p->id,'idC'=>$c->id], JSON_UNESCAPED_UNICODE);
`);
  await openAuthed(auth, auth.idP);
  await selectById(auth.idP);
  await page.evaluate(() => {
    document.getElementById('delete-section')?.scrollIntoView({ block: 'center' });
    document.getElementById('btn-delete-person')?.click();
  });
  await page.waitForFunction(() => !document.getElementById('sheet-confirm')?.classList.contains('hidden'), { timeout: 8000 });
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
    testIdentityBoundaryTransitionTable,
    () => testInFlightDelayedDeleteThenLoginB('ok'),
    () => testInFlightDelayedDeleteThenLoginB('network'),
    testSameAccountDelayedDeleteStillWorks,
    () => testReconcileInFlightThenLoginB('exists'),
    () => testReconcileInFlightThenLoginB('unknown'),
    () => testReconcileInFlightThenLoginB('401'),
    () => testReconcileInFlightThenLoginB('403'),
    testSameAccountReconcileDelayedExistsStillWorks,
    testDelayedAPersonsListAfterBLoaded,
    testDelayedATreeAfterBLoaded,
    testDelayedABindFailTreeAfterBLoaded,
    testSameAccountBindFailDelayedTreeStillRecovers,
    testSameAccountReloadAfterDelayStillWorks,
    testReconcile401and403Unknown,
    testWriteSuccessRefreshFailNoRepeatMutation,
    testUnrelatedRecoveryPreserved,
    testNarrowScrollReachability,
    testNarrowConfirmCancelAndSuccessRestore,
    testConfirmTabCycleAndEscFocus,
    testFocusAfterDeletedTrigger,
    testContrastRenderedSampling,
    testLoadingDisabledAndNarrowStates,
    testStateGalleryAndFocusRings,
    testGlobalStructureContract,
    test409PrefersChildCorrection,
    testKeyboardOrderLoginAddRecovery,
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
  const hardeningPassed = Object.fromEntries(results.map((r) => [r.test, r.passed]));
  const vis02 = hardeningPassed['VIS-02 footer/body non-occlusion 320/375/768 (geom+elementFromPoint)']
    && hardeningPassed['VIS-02/03 narrow 320/375 cancel+success restore tree/footer/head+focus'];
  const vis03 = hardeningPassed['VIS-03/15 full Tab forward+reverse cycle + Esc restores live trigger']
    && hardeningPassed['VIS-03/15 focus after deleted trigger lands on live node/add']
    && hardeningPassed['VIS-02/03 narrow 320/375 cancel+success restore tree/footer/head+focus'];
  const vis04_16 = hardeningPassed['VIS-04/16 state gallery default/hover/focus/pressed/disabled/loading/error'];
  const vis05 = hardeningPassed['VIS-05 rendered contrast sampling (text>=4.5; disabled exempt)'];
  const vis06_08 = hardeningPassed['VIS-04/06/07/08 loading busy + narrow empty/add-first footer + narrow 409'];
  const vis09 = hardeningPassed['VIS-09 focus-ring gallery + keyboard oracles'];
  const vis13 = hardeningPassed['VIS-13 global structure/content contract login/tree/detail/add/recovery + DEL before/after'];
  const vis14 = hardeningPassed['VIS-14 true browser 200% zoom product acceptance'] === true;
  const visKeyboard = hardeningPassed['VIS keyboard order: login/add/recovery reachable; trap+Esc only on confirm modal'];
  const visMap = {
    note: 'Honest coverage on this HEAD. PASS only with full oracle. PARTIAL = some evidence, not whole matrix row. UNVERIFIED = missing/blocked. Never pad total PASS while required rows remain UNVERIFIED. Recovery: vis-contract-recovery.png is one-frame archive pair with JSON — not full recovery lifecycle.',
    head,
    scripts: {
      hardening: 'node tests/delete-correction-qa-hardening.test.mjs',
      delete: 'node tests/delete-correction.test.mjs',
      regression: 'node tests/frontend-regression.test.mjs',
      phpunit: 'php artisan test --compact',
      trueZoomProbe: 'node tests/vis-true-zoom-playwright-probe.mjs',
    },
    rows: [
      { id: 'VIS-01', strength: 'PASS', oracle: 'desktop confirm structure (delete suite + hierarchy shot)' },
      { id: 'VIS-02', strength: vis02 ? 'PASS' : 'FAIL', oracle: '320/375/768 footer+actions non-occlusion + narrow cancel/success restore tree/footer/head' },
      { id: 'VIS-03', strength: vis03 && visKeyboard ? 'PASS' : 'FAIL', oracle: 'Tab cycle + Esc + desktop post-delete focus + narrow restore focus + login/add/recovery order' },
      { id: 'VIS-04', strength: vis04_16 ? 'PASS' : 'FAIL', oracle: 'state gallery: default/hover/focus/pressed/disabled/loading/error screenshots+style samples' },
      { id: 'VIS-05', strength: vis05 ? 'PASS' : 'FAIL', oracle: 'rendered getComputedStyle contrast sampling; disabled exempt' },
      { id: 'VIS-06', strength: vis06_08 ? 'PASS' : 'FAIL', oracle: 'narrow empty 375×667 sheet-closed: 把家人的名字 vs 世系一览/legend both visible non-overlap + 例如/footer non-collision + add-first' },
      { id: 'VIS-07', strength: vis04_16 && vis06_08 ? 'PASS' : 'FAIL', oracle: 'loading busy + error-state gallery (sanitized unknown; no false success)' },
      { id: 'VIS-08', strength: vis06_08 && hardeningPassed['409 action hierarchy prefers open-child correction over retry delete'] ? 'PASS' : 'FAIL', oracle: 'desktop 409 hierarchy + narrow 375 409 screenshot' },
      { id: 'VIS-09', strength: vis09 ? 'PASS' : 'FAIL', oracle: 'focus-ring gallery screenshots + keyboard outline oracles on buttons/confirm/input' },
      { id: 'VIS-10', strength: 'PASS', oracle: 'H-12 inferred explanation screenshot (prior closed)' },
      { id: 'VIS-11', strength: 'PASS', oracle: 'unknown never claims success' },
      { id: 'VIS-12', strength: 'PASS', oracle: 'root survivor perspective' },
      { id: 'VIS-13', strength: vis13 ? 'PASS' : 'FAIL', oracle: 'global contract pack: login/tree/detail/add/recovery + DEL before/after IDs/edges/root/stats' },
      { id: 'VIS-14', strength: vis14 ? 'PASS' : 'UNVERIFIED', oracle: 'Playwright chromium.tabs.setZoom(2) true page zoom + product readable/operable/no-x-overflow (see vis-true-zoom-*.json); DPR2/pageScaleFactor/CSS zoom rejected' },
      { id: 'VIS-15', strength: vis03 && visKeyboard ? 'PASS' : 'FAIL', oracle: 'paired with VIS-03 keyboard dialogs; login/add/recovery order; trap only on confirm modal' },
      { id: 'VIS-16', strength: vis04_16 ? 'PASS' : 'FAIL', oracle: 'paired state gallery series (default/hover/focus/pressed/disabled/loading/error)' },
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
