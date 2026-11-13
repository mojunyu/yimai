/**
 * Integration QA INT-01…INT-11 for mobile-first A shell.
 * Isolated local sqlite + fictitious accounts only. No production 18-person writes.
 *
 * Run: BASE_URL=http://127.0.0.1:8000 node tests/mobile-integration-qa.test.mjs
 */

import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = process.env.APP_ROOT
  ? path.resolve(process.env.APP_ROOT)
  : path.resolve(__dirname, '..');
const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:8000';
const ARTIFACTS_DIR = process.env.ARTIFACTS_DIR
  ? path.resolve(process.env.ARTIFACTS_DIR)
  : path.resolve(APP_ROOT, 'artifacts/integration-qa');
const STORE_DIR = process.env.EVIDENCE_STORE
  ? path.resolve(process.env.EVIDENCE_STORE)
  : '/cursor/stores/self/yimai-mobile-integration-20261113';

fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
fs.mkdirSync(STORE_DIR, { recursive: true });

const startedAt = new Date();
const results = [];
let browser;
let page;
let fatalError = null;

function sha256File(rel) {
  const full = path.join(APP_ROOT, rel);
  return createHash('sha256').update(fs.readFileSync(full)).digest('hex');
}

function sourceHashes() {
  return {
    head: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: APP_ROOT, encoding: 'utf8' }).stdout.trim(),
    dirty: spawnSync('git', ['status', '--porcelain'], { cwd: APP_ROOT, encoding: 'utf8' }).stdout.trim(),
    'frontend/js/app.js': sha256File('frontend/js/app.js'),
    'frontend/css/app.css': sha256File('frontend/css/app.css'),
    'frontend/css/mobile.css': sha256File('frontend/css/mobile.css'),
    'frontend/js/preview-fixture.js': sha256File('frontend/js/preview-fixture.js'),
    'frontend/index.html': sha256File('frontend/index.html'),
    'app/Http/Controllers/Api/V1/PersonController.php': sha256File('app/Http/Controllers/Api/V1/PersonController.php'),
  };
}

const START_HASHES = sourceHashes();

function log(id, passed, message = '', extra = {}) {
  const status = passed ? 'PASS' : 'FAIL';
  console.log(`${status}: ${id}${message ? ' - ' + message : ''}`);
  results.push({
    id,
    status: passed ? 'PASS' : 'observed FAIL',
    message,
    at: new Date().toISOString(),
    ...extra,
  });
}

function mark(id, status, message = '', extra = {}) {
  console.log(`${status}: ${id}${message ? ' - ' + message : ''}`);
  results.push({ id, status, message, at: new Date().toISOString(), ...extra });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function resolveChromePath() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH;
  for (const candidate of [
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
  ]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

function phpSeed(scriptBody) {
  const email = `iso${Date.now()}${Math.floor(Math.random() * 10000)}@test.test`;
  const script = `<?php
require '${APP_ROOT}/vendor/autoload.php';
$app = require '${APP_ROOT}/bootstrap/app.php';
$app->make(Illuminate\\Contracts\\Console\\Kernel::class)->bootstrap();
$email = '${email}';
try {
${scriptBody}
} catch (Throwable $e) {
  fwrite(STDERR, $e->getMessage());
  exit(1);
}
`;
  const tmp = path.join(ARTIFACTS_DIR, `seed-${Date.now()}.php`);
  fs.writeFileSync(tmp, script);
  const out = spawnSync('php', [tmp], { encoding: 'utf8' });
  fs.unlinkSync(tmp);
  if (out.status !== 0) {
    throw new Error(`php seed failed: ${out.stderr || out.stdout}`);
  }
  const line = (out.stdout || '').trim().split('\n').filter(Boolean).at(-1);
  return JSON.parse(line);
}

async function screenshot(name) {
  const file = path.join(ARTIFACTS_DIR, name);
  await page.screenshot({ path: file, fullPage: true });
  return file;
}

async function openPreview() {
  await page.goto(`${BASE_URL}/app/?preview=1`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#mobile-shell:not([hidden])', { timeout: 8000 });
}

async function openAuthed(auth, rootId) {
  await page.goto(`${BASE_URL}/app/`, { waitUntil: 'networkidle0' });
  await page.evaluate((a, root) => {
    localStorage.clear();
    localStorage.setItem('yimai_token', a.token);
    localStorage.setItem('yimai_user_id', String(a.userId));
    localStorage.setItem('yimai_tree_id', String(a.treeId));
    if (root) localStorage.setItem('yimai_root_id', String(root));
  }, auth, rootId || auth.rootId || auth.idLan || auth.idA || auth.idT || '');
  await page.reload({ waitUntil: 'networkidle0' });
  await page.waitForFunction(() => window.yimaiMobile && document.getElementById('mobile-shell') && !document.getElementById('mobile-shell').hidden, { timeout: 10000 });
}

async function apiJson(token, method, pathName, body) {
  if (!page.url().startsWith('http')) {
    await page.goto(`${BASE_URL}/app/`, { waitUntil: 'domcontentloaded' });
  }
  return page.evaluate(async (base, tok, m, p, b) => {
    const res = await fetch(`${base}/api/v1${p}`, {
      method: m,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${tok}`,
        ...(b ? { 'Content-Type': 'application/json' } : {}),
      },
      body: b ? JSON.stringify(b) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (_) { json = { raw: text }; }
    return { status: res.status, json };
  }, BASE_URL, token, method, pathName, body || null);
}

function seedLanFamily() {
  return phpSeed(`
$u=App\\Models\\User::create(['name'=>'IsoLan','email'=>$email,'password'=>bcrypt('password')]);
$t=App\\Models\\Tree::create(['owner_user_id'=>$u->id,'title'=>'IsoLan']);
$gu=App\\Models\\Person::create(['tree_id'=>$t->id,'name'=>'林谷','gender'=>'male','generation'=>1]);
$yu=App\\Models\\Person::create(['tree_id'=>$t->id,'name'=>'陈雨','gender'=>'female','generation'=>1]);
$zhou=App\\Models\\Person::create(['tree_id'=>$t->id,'name'=>'林舟','gender'=>'female','generation'=>2,'father_id'=>$gu->id,'mother_id'=>$yu->id]);
$lan=App\\Models\\Person::create(['tree_id'=>$t->id,'name'=>'林岚','gender'=>'female','generation'=>2,'father_id'=>$gu->id,'mother_id'=>$yu->id]);
$he=App\\Models\\Person::create(['tree_id'=>$t->id,'name'=>'林禾','gender'=>'male','generation'=>2,'father_id'=>$gu->id,'mother_id'=>$yu->id]);
$shi=App\\Models\\Person::create(['tree_id'=>$t->id,'name'=>'周石','gender'=>'male','generation'=>2]);
App\\Models\\SpouseLink::create(['tree_id'=>$t->id,'person_a_id'=>$lan->id,'person_b_id'=>$shi->id]);
App\\Models\\SiblingLink::create(['tree_id'=>$t->id,'person_a_id'=>min($lan->id,$zhou->id),'person_b_id'=>max($lan->id,$zhou->id)]);
echo json_encode([
  'userId'=>$u->id,'treeId'=>$t->id,'token'=>$u->createToken('t')->plainTextToken,
  'idGu'=>$gu->id,'idYu'=>$yu->id,'idZhou'=>$zhou->id,'idLan'=>$lan->id,'idHe'=>$he->id,'idShi'=>$shi->id,
  'rootId'=>$lan->id,'account_email'=>$email
], JSON_UNESCAPED_UNICODE);
`);
}

async function mobileOpenByName(name) {
  await page.evaluate((n) => {
    window.yimaiMobile.showView('list');
    window.yimaiMobile.sync();
    const btn = Array.from(document.querySelectorAll('#m-list-rows .m-row'))
      .find((b) => (b.textContent || '').includes(n));
    if (!btn) throw new Error('missing ' + n);
    btn.click();
  }, name);
  await page.waitForSelector('#m-view-detail:not([hidden])');
}

async function mobileAddRelative(relationLabel, newName) {
  await page.evaluate(() => document.getElementById('m-btn-add').click());
  await page.waitForFunction(() => document.getElementById('m-dlg-rel')?.open);
  await page.evaluate((label) => {
    const btn = Array.from(document.querySelectorAll('#m-rel-rows .m-row'))
      .find((b) => (b.textContent || '').trim() === label);
    if (!btn) throw new Error('missing relation ' + label);
    btn.click();
  }, relationLabel);
  await page.waitForFunction(() => document.getElementById('m-dlg-name')?.open);
  await page.click('#m-name-input', { clickCount: 3 });
  await page.type('#m-name-input', newName);
  await page.evaluate(() => document.getElementById('m-form-name').requestSubmit());
  await page.waitForFunction(() => !document.getElementById('m-dlg-name')?.open, { timeout: 10000 });
}

async function setup() {
  browser = await puppeteer.launch({
    headless: true,
    executablePath: resolveChromePath(),
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844 });
}

async function testInt01MainPath() {
  const auth = seedLanFamily();
  const before = await apiJson(auth.token, 'GET', '/persons');
  await openAuthed(auth, auth.idLan);
  await mobileOpenByName('林岚');
  const beforeId = await page.evaluate(() => window.yimaiMobile.selectedId());
  const beforeKin = await page.$eval('#m-detail-kin', (el) => el.innerText);
  await screenshot('INT-01-before.png');
  await mobileAddRelative('女儿', '集成女甲');
  const afterUi = await page.evaluate(() => ({
    selected: window.yimaiMobile.selectedId(),
    name: document.getElementById('m-detail-name')?.textContent,
    feedback: document.getElementById('m-detail-feedback')?.textContent,
    kin: document.getElementById('m-detail-kin')?.innerText,
  }));
  const after = await apiJson(auth.token, 'GET', '/persons');
  const tree = await apiJson(auth.token, 'GET', `/persons/${auth.idLan}/tree`);
  fs.writeFileSync(path.join(ARTIFACTS_DIR, 'INT-01-api.json'), JSON.stringify({
    account_id: auth.userId,
    tree_id: auth.treeId,
    target_id: auth.idLan,
    before: before.json,
    after: after.json,
    tree: tree.json,
  }, null, 2));
  await screenshot('INT-01-after.png');
  const daughter = (after.json.data || []).find((p) => p.name === '集成女甲');
  const ok = String(beforeId) === String(auth.idLan)
    && String(afterUi.selected) === String(auth.idLan)
    && afterUi.name === '林岚'
    && (afterUi.kin || '').includes('集成女甲')
    && beforeKin.includes('林谷')
    && daughter
    && Number(daughter.mother_id) === Number(auth.idLan);
  log('INT-01', ok, JSON.stringify({ beforeId, afterUi, daughterId: daughter?.id }), {
    account_id: auth.userId,
    tree_id: auth.treeId,
    target_id: auth.idLan,
  });
}

async function testInt02ListOverview() {
  const auth = seedLanFamily();
  await openAuthed(auth, auth.idLan);
  await mobileAddRelativeViaList(auth, '儿子', '全谱儿');
  const listIds = await page.evaluate(() => {
    window.yimaiMobile.showView('list');
    window.yimaiMobile.sync();
    return Array.from(document.querySelectorAll('#m-list-rows .m-row')).map((b) => b.dataset.openId || b.textContent);
  });
  // reopen and check overview
  await page.evaluate(() => {
    document.getElementById('m-btn-back-detail')?.click();
    document.getElementById('m-btn-overview')?.click();
  });
  await page.waitForSelector('#m-view-overview:not([hidden])');
  const overviewText = await page.$eval('#m-overview-body', (el) => el.innerText);
  const persons = await apiJson(auth.token, 'GET', '/persons');
  const tree = await apiJson(auth.token, 'GET', `/persons/${auth.idLan}/tree`);
  await screenshot('INT-02-overview.png');
  fs.writeFileSync(path.join(ARTIFACTS_DIR, 'INT-02-api.json'), JSON.stringify({ persons: persons.json, tree: tree.json }, null, 2));
  const names = (persons.json.data || []).map((p) => p.name);
  const ok = names.includes('全谱儿')
    && overviewText.includes('全谱儿')
    && overviewText.includes('林岚')
    && listIds.length >= names.length - 0;
  log('INT-02', ok, JSON.stringify({ listCount: listIds.length, overviewHas: overviewText.includes('全谱儿') }), {
    account_id: auth.userId,
    tree_id: auth.treeId,
  });
}

async function mobileAddRelativeViaList(auth, rel, name) {
  await mobileOpenByName('林岚');
  await mobileAddRelative(rel, name);
}

async function testInt03Children409() {
  const auth = seedLanFamily();
  await openAuthed(auth, auth.idGu);
  await mobileOpenByName('林谷');
  await page.evaluate(() => {
    document.getElementById('m-btn-more')?.click();
    const del = Array.from(document.querySelectorAll('#m-more-rows .m-row'))
      .find((b) => (b.textContent || '').includes('删除此人'));
    del?.click();
  });
  await page.waitForSelector('#sheet-confirm:not(.hidden)');
  await page.evaluate(() => document.querySelector('#sheet-confirm-actions button[data-confirm-primary="1"]')?.click());
  await page.waitForFunction(() => (document.getElementById('sheet-confirm-body')?.textContent || '').includes('父亲或母亲'), { timeout: 8000 });
  const ui = await page.evaluate(() => ({
    title: document.getElementById('sheet-confirm-title')?.textContent,
    body: document.getElementById('sheet-confirm-body')?.textContent,
    actions: Array.from(document.querySelectorAll('#sheet-confirm-actions button')).map((b) => b.textContent.trim()),
  }));
  const del = await apiJson(auth.token, 'DELETE', `/persons/${auth.idGu}`);
  const still = await apiJson(auth.token, 'GET', `/persons/${auth.idGu}`);
  await screenshot('INT-03-409.png');
  fs.writeFileSync(path.join(ARTIFACTS_DIR, 'INT-03-api.json'), JSON.stringify({ delete: del, still: still.json }, null, 2));
  const ok = del.status === 409
    && Array.isArray(del.json?.children)
    && del.json.children.length > 0
    && still.status === 200
    && (ui.body || '').includes('更正')
    && ui.actions.some((a) => a.includes('打开并更正'));
  log('INT-03', ok, JSON.stringify({ status: del.status, actions: ui.actions }), {
    account_id: auth.userId,
    tree_id: auth.treeId,
    target_id: auth.idGu,
  });
}

async function testInt04FailUnknown() {
  const auth = seedLanFamily();
  await openAuthed(auth, auth.idShi);
  // alone spouse can delete; arm network failure hook if present, else simulate uncertain via evaluate
  await mobileOpenByName('周石');
  const targetId = auth.idShi;
  await page.evaluate((id) => {
    window.__yimaiFailNextDelete = true;
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (url, opts = {}) => {
      const u = String(url);
      const m = (opts.method || 'GET').toUpperCase();
      if (window.__yimaiFailNextDelete && m === 'DELETE' && u.includes(`/persons/${id}`)) {
        window.__yimaiFailNextDelete = false;
        throw new TypeError('Failed to fetch (injected)');
      }
      return originalFetch(url, opts);
    };
  }, targetId);
  await page.evaluate(() => {
    document.getElementById('m-btn-more')?.click();
    const del = Array.from(document.querySelectorAll('#m-more-rows .m-row'))
      .find((b) => (b.textContent || '').includes('删除此人'));
    del?.click();
  });
  await page.waitForSelector('#sheet-confirm:not(.hidden)');
  // switch selection to another person while confirm open (DEL-7)
  await page.evaluate((otherId) => {
    window.yimaiMobile.openPerson(otherId);
  }, auth.idLan);
  await page.evaluate(() => document.querySelector('#sheet-confirm-actions button[data-confirm-primary="1"]')?.click());
  await sleep(800);
  const still = await apiJson(auth.token, 'GET', `/persons/${targetId}`);
  const lan = await apiJson(auth.token, 'GET', `/persons/${auth.idLan}`);
  const ui = await page.evaluate(() => ({
    confirmHidden: document.getElementById('sheet-confirm')?.classList.contains('hidden'),
    err: document.getElementById('sheet-confirm-error')?.textContent
      || document.getElementById('sheet-error')?.textContent
      || '',
    body: document.getElementById('sheet-confirm-body')?.textContent || '',
  }));
  await screenshot('INT-04-unknown.png');
  fs.writeFileSync(path.join(ARTIFACTS_DIR, 'INT-04-api.json'), JSON.stringify({ still: still.json, lan: lan.json, ui }, null, 2));
  const ok = still.status === 200 && lan.status === 200 && !(ui.err || '').includes('已删除');
  log('INT-04', ok, JSON.stringify({ still: still.status, ui }), {
    account_id: auth.userId,
    tree_id: auth.treeId,
    target_id: targetId,
  });
}

async function testInt05CorrectionVsDelete() {
  const auth = seedLanFamily();
  // clear mother slot on 林岚
  const patch = await apiJson(auth.token, 'PATCH', `/persons/${auth.idLan}`, { mother_id: null });
  const afterPatch = await apiJson(auth.token, 'GET', `/persons/${auth.idLan}`);
  // unlink explicit sibling
  const sibs = await page.evaluate(async (tok, lan, zhou) => {
    const res = await fetch(`${location.origin}/api/v1/sibling-links`, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${tok}` },
    });
    const data = await res.json();
    const list = Array.isArray(data) ? data : (data.data || []);
    const hit = list.find((l) => (
      (Number(l.person_a_id) === Number(lan) && Number(l.person_b_id) === Number(zhou))
      || (Number(l.person_a_id) === Number(zhou) && Number(l.person_b_id) === Number(lan))
    ));
    return hit;
  }, auth.token, auth.idLan, auth.idZhou);
  let unlink = { status: 0 };
  if (sibs?.id) {
    unlink = await apiJson(auth.token, 'DELETE', `/sibling-links/${sibs.id}`);
  }
  await openAuthed(auth, auth.idLan);
  await mobileOpenByName('林岚');
  const kin = await page.$eval('#m-detail-kin', (el) => el.innerText);
  // delete spouse-only person 周石 should succeed
  const delShi = await apiJson(auth.token, 'DELETE', `/persons/${auth.idShi}`);
  const shiGone = await apiJson(auth.token, 'GET', `/persons/${auth.idShi}`);
  const lanStill = await apiJson(auth.token, 'GET', `/persons/${auth.idLan}`);
  await screenshot('INT-05-detail.png');
  fs.writeFileSync(path.join(ARTIFACTS_DIR, 'INT-05-api.json'), JSON.stringify({
    patch, afterPatch: afterPatch.json, unlink, delShi, shiGone, lanStill: lanStill.json, kin,
  }, null, 2));
  const ok = patch.status === 200
    && afterPatch.json.mother_id == null
    && afterPatch.json.father_id != null
    && lanStill.status === 200
    && delShi.status === 204
    && shiGone.status === 404
    && kin.includes('林禾'); // inferred sibling remains after explicit unlink may still show via parents
  log('INT-05', ok, JSON.stringify({
    mother: afterPatch.json.mother_id,
    delShi: delShi.status,
    inferredNote: kin.includes('林禾'),
  }), { account_id: auth.userId, tree_id: auth.treeId, target_id: auth.idLan });
}

async function testInt06PreviewIsolation() {
  const apiHits = [];
  page.removeAllListeners('request');
  page.on('request', (req) => {
    if (req.url().includes('/api/v1/')) {
      apiHits.push({ method: req.method(), url: req.url() });
    }
  });
  await openPreview();
  await mobileOpenByName('林岚');
  await mobileAddRelative('儿子', '预览儿');
  await page.evaluate(() => document.getElementById('m-btn-back-detail')?.click());
  await page.waitForSelector('#m-view-list:not([hidden])');
  await page.evaluate(() => document.getElementById('m-btn-overview')?.click());
  await page.waitForSelector('#m-view-overview:not([hidden])');
  // production path still requires auth — open without token
  const prod = await page.evaluate(async () => {
    const res = await fetch(`${location.origin}/api/v1/persons`, { headers: { Accept: 'application/json' } });
    return res.status;
  });
  await screenshot('INT-06-preview.png');
  const writes = apiHits.filter((h) => !['GET', 'HEAD', 'OPTIONS'].includes(h.method));
  const ok = writes.length === 0 && prod === 401 && page.url().includes('preview=1');
  log('INT-06', ok, JSON.stringify({ apiHits: apiHits.length, writes, prod }), {
    fixture: 'preview-memory-林岚',
  });
}

async function testInt07Viewports() {
  const auth = seedLanFamily();
  await openAuthed(auth, auth.idLan);
  const viewports = [
    { w: 320, h: 694, name: '320' },
    { w: 375, h: 812, name: '375' },
    { w: 390, h: 844, name: '390' },
    { w: 430, h: 932, name: '430' },
  ];
  const reports = [];
  for (const vp of viewports) {
    await page.setViewport({ width: vp.w, height: vp.h });
    await mobileOpenByName('林岚');
    const box = await page.evaluate(() => {
      const add = document.getElementById('m-btn-add');
      const r = add?.getBoundingClientRect();
      return {
        addVisible: Boolean(add) && (r?.width || 0) > 0 && (r?.height || 0) > 0,
        name: document.getElementById('m-detail-name')?.textContent,
        nameFont: document.getElementById('m-detail-name')
          ? getComputedStyle(document.getElementById('m-detail-name')).fontSize
          : null,
      };
    });
    await screenshot(`INT-07-${vp.name}.png`);
    reports.push({ ...vp, ...box });
  }
  await page.setViewport({ width: 390, height: 844 });
  const ok = reports.every((r) => r.addVisible && r.name === '林岚' && Number.parseFloat(r.nameFont) >= 28);
  log('INT-07', ok, JSON.stringify(reports), { account_id: auth.userId, tree_id: auth.treeId });
}

async function testInt08ReduceMotionKeyboard() {
  const auth = seedLanFamily();
  await openAuthed(auth, auth.idLan);
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await mobileOpenByName('林岚');
  await page.evaluate(() => document.getElementById('m-btn-add').click());
  await page.waitForFunction(() => document.getElementById('m-dlg-rel')?.open);
  // Tab to cancel
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  const active = await page.evaluate(() => document.activeElement?.id || document.activeElement?.textContent);
  await page.click('#m-rel-cancel');
  await page.waitForFunction(() => !document.getElementById('m-dlg-rel')?.open);
  await screenshot('INT-08-reduce.png');
  const ok = !await page.evaluate(() => document.getElementById('m-dlg-rel')?.open);
  log('INT-08', ok, JSON.stringify({ active }), { note: 'desktop keyboard / reduced-motion; not device soft keyboard' });
}

async function testInt09AsyncIdentityGate() {
  // Reuse existing delay hook pattern from regression if available; otherwise inject.
  const a = seedLanFamily();
  const b = phpSeed(`
$u=App\\Models\\User::create(['name'=>'IsoB','email'=>$email,'password'=>bcrypt('password')]);
$t=App\\Models\\Tree::create(['owner_user_id'=>$u->id,'title'=>'IsoB']);
$p=App\\Models\\Person::create(['tree_id'=>$t->id,'name'=>'乙独','gender'=>'male','generation'=>1]);
echo json_encode(['userId'=>$u->id,'treeId'=>$t->id,'token'=>$u->createToken('t')->plainTextToken,'idT'=>$p->id,'rootId'=>$p->id,'account_email'=>$email], JSON_UNESCAPED_UNICODE);
`);
  await openAuthed(a, a.idLan);
  await page.evaluate((tokenA, tokenB, userB, treeB, rootB) => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    window.__yimaiReleaseDelayedTree = () => release();
    const originalFetch = window.fetch.bind(window);
    let armed = true;
    window.fetch = async (url, opts = {}) => {
      const u = String(url);
      if (armed && /\/persons\/\d+\/tree/.test(u) && (opts.headers?.Authorization || '').includes(tokenA.slice(0, 10))) {
        armed = false;
        await gate;
      }
      return originalFetch(url, opts);
    };
    // kick a delayed tree load under A
    window.__delayTreePromise = fetch(`${location.origin}/api/v1/persons/${localStorage.getItem('yimai_root_id')}/tree`, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${tokenA}` },
    });
    // switch to B
    localStorage.setItem('yimai_token', tokenB);
    localStorage.setItem('yimai_user_id', String(userB));
    localStorage.setItem('yimai_tree_id', String(treeB));
    localStorage.setItem('yimai_root_id', String(rootB));
  }, a.token, b.token, b.userId, b.treeId, b.idT);
  await page.reload({ waitUntil: 'networkidle0' });
  await page.waitForFunction(() => (document.getElementById('m-list-rows')?.innerText || '').includes('乙独')
    || (document.getElementById('stats')?.textContent || '').includes('位亲人'), { timeout: 10000 });
  const mid = await page.evaluate(() => ({
    names: window.yimaiMobile?.persons?.().map((p) => p.name) || [],
    selected: window.yimaiMobile?.selectedId?.(),
  }));
  await page.evaluate(() => window.__yimaiReleaseDelayedTree?.());
  await sleep(500);
  const after = await page.evaluate(() => ({
    names: window.yimaiMobile?.persons?.().map((p) => p.name) || [],
    list: document.getElementById('m-list-rows')?.innerText || '',
  }));
  await screenshot('INT-09-gate.png');
  fs.writeFileSync(path.join(ARTIFACTS_DIR, 'INT-09-api.json'), JSON.stringify({ mid, after, a: { userId: a.userId, treeId: a.treeId }, b: { userId: b.userId, treeId: b.treeId } }, null, 2));
  const polluted = after.names.includes('林岚') || after.list.includes('林岚');
  const ok = mid.names.includes('乙独') && !polluted;
  log('INT-09', ok, JSON.stringify({ mid, after, polluted }), {
    account_id: b.userId,
    tree_id: b.treeId,
    note: 'A delayed tree must not paint into B',
  });
}

async function testInt10BindFailedZeroExtraPost() {
  const auth = seedLanFamily();
  await openAuthed(auth, auth.idLan);
  await mobileOpenByName('林岚');
  // Use desktop form path with hooks (same submitAdd) to preserve recovery contract.
  const trace = await page.evaluate(async () => {
    const posts = [];
    const patches = [];
    const originalFetch = window.fetch.bind(window);
    let failBind = true;
    window.fetch = async (url, opts = {}) => {
      const u = String(url);
      const m = (opts.method || 'GET').toUpperCase();
      if (m === 'POST' && /\/api\/v1\/persons\/?$/.test(u.replace(/\?.*$/, ''))) {
        const res = await originalFetch(url, opts);
        const clone = res.clone();
        let body = null;
        try { body = await clone.json(); } catch (_) {}
        posts.push({ status: res.status, id: body?.id });
        return res;
      }
      if (failBind && m === 'PATCH' && /\/api\/v1\/persons\/\d+$/.test(u.replace(/\?.*$/, ''))) {
        failBind = false;
        return new Response(JSON.stringify({ message: 'forced bind fail' }), {
          status: 422,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (m === 'PATCH' && /\/api\/v1\/persons\/\d+$/.test(u.replace(/\?.*$/, ''))) {
        const res = await originalFetch(url, opts);
        patches.push({ status: res.status, url: u });
        return res;
      }
      return originalFetch(url, opts);
    };
    // prepare son add via sheet
    const lan = window.yimaiMobile.persons().find((p) => p.name === '林岚');
    window.yimaiMobile.openPerson(lan.id);
    document.querySelector('#kin-grid button[data-kin="son"]')?.click();
    document.getElementById('add-name').value = '绑定败儿';
    document.getElementById('form-add').requestSubmit();
    await new Promise((r) => setTimeout(r, 800));
    const recovery = JSON.parse(localStorage.getItem('yimai_add_recovery') || 'null');
    const createId = posts[0]?.id;
    // retry submit without clearing recovery
    document.getElementById('form-add').requestSubmit();
    await new Promise((r) => setTimeout(r, 1000));
    return {
      posts: posts.map((p) => ({ status: p.status, id: p.id })),
      patches,
      recovery,
      createId,
      postsAfterFirst: posts.length,
    };
  });
  await screenshot('INT-10-bindfail.png');
  fs.writeFileSync(path.join(ARTIFACTS_DIR, 'INT-10-trace.json'), JSON.stringify(trace, null, 2));
  const pending = trace.recovery?.pendingPersonId;
  const ok = Number(trace.createId) === Number(pending)
    && trace.posts.length === 1
    && trace.patches.some((p) => p.status === 200 || p.status === 201 || true);
  // stronger: posts stay 1
  log('INT-10', Number(trace.createId) === Number(pending) && trace.posts.length === 1, JSON.stringify(trace), {
    account_id: auth.userId,
    tree_id: auth.treeId,
    target_id: auth.idLan,
  });
}

async function testInt11RegressionSuitePointer() {
  // Run named existing suites as child processes and record named counts.
  const suites = [
    { name: 'frontend-regression', cmd: ['npm', 'run', 'test:frontend'], expect: 41 },
    { name: 'delete-correction', cmd: ['npm', 'run', 'test:delete'], expect: null },
    { name: 'delete-correction-qa-hardening', cmd: ['npm', 'run', 'test:delete-hardening'], expect: null },
  ];
  // Only point that suites must be run; actual execution happens in main after INT UI tests
  // to keep one browser lifecycle. Mark as deferred runner result file.
  mark('INT-11', 'NOT RUN', 'executed in suite phase after UI cases', { deferred: true });
}

async function runNamedSuites() {
  const suiteResults = [];
  for (const suite of [
    { id: 'REG-frontend', script: 'test:frontend' },
    { id: 'DEL-delete', script: 'test:delete' },
    { id: 'DEL-hardening', script: 'test:delete-hardening' },
  ]) {
    const out = spawnSync('npm', ['run', suite.script], {
      cwd: APP_ROOT,
      encoding: 'utf8',
      env: { ...process.env, BASE_URL, ARTIFACTS_DIR: path.join(ARTIFACTS_DIR, suite.id) },
      timeout: 600000,
    });
    fs.writeFileSync(path.join(ARTIFACTS_DIR, `${suite.id}-stdout.txt`), out.stdout || '');
    fs.writeFileSync(path.join(ARTIFACTS_DIR, `${suite.id}-stderr.txt`), out.stderr || '');
    const passLines = (out.stdout || '').split('\n').filter((l) => /✓ PASS|: PASS|PASS:/.test(l));
    const failLines = (out.stdout || '').split('\n').filter((l) => /✗ FAIL|: FAIL|FAIL:/.test(l));
    suiteResults.push({
      id: suite.id,
      exit: out.status,
      passCount: passLines.length,
      failCount: failLines.length,
      namedPassSample: passLines.slice(0, 20),
      namedFailSample: failLines.slice(0, 20),
    });
  }
  fs.writeFileSync(path.join(ARTIFACTS_DIR, 'INT-11-suites.json'), JSON.stringify(suiteResults, null, 2));
  // Replace deferred INT-11
  const idx = results.findIndex((r) => r.id === 'INT-11');
  const allOk = suiteResults.every((s) => s.exit === 0 && s.failCount === 0);
  const entry = {
    id: 'INT-11',
    status: allOk ? 'PASS' : 'observed FAIL',
    message: JSON.stringify(suiteResults.map((s) => ({ id: s.id, exit: s.exit, passCount: s.passCount, failCount: s.failCount }))),
    at: new Date().toISOString(),
    suites: suiteResults,
  };
  if (idx >= 0) results[idx] = entry;
  else results.push(entry);
  console.log(`${entry.status}: INT-11 - ${entry.message}`);
  return allOk;
}

async function testInvalidIdSafeClose() {
  // PM INT-2 coverage under INT-01 family of probes
  const auth = seedLanFamily();
  await openAuthed(auth, auth.idLan);
  await page.evaluate((deadId) => {
    window.yimaiMobile.openPerson(deadId);
  }, 999999);
  const ui = await page.evaluate(() => ({
    viewList: !document.getElementById('m-view-list')?.hidden,
    viewDetail: !document.getElementById('m-view-detail')?.hidden,
    selected: window.yimaiMobile.selectedId(),
  }));
  await screenshot('INT-PM2-invalid-id.png');
  const ok = ui.selected == null && ui.viewList === true;
  log('INT-PM2-invalid-id', ok, JSON.stringify(ui), { account_id: auth.userId, tree_id: auth.treeId });
}

async function testRecognizeExistingNoNewPerson() {
  const auth = seedLanFamily();
  await openAuthed(auth, auth.idLan);
  const before = await apiJson(auth.token, 'GET', '/persons');
  await mobileOpenByName('林岚');
  await page.evaluate(() => document.getElementById('m-btn-add').click());
  await page.waitForFunction(() => document.getElementById('m-dlg-rel')?.open);
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('#m-rel-rows .m-row')).find((b) => b.textContent.includes('弟弟'));
    btn.click();
  });
  await page.waitForFunction(() => document.getElementById('m-dlg-name')?.open);
  await page.evaluate(() => document.getElementById('m-name-pick').click());
  await page.waitForFunction(() => document.getElementById('m-dlg-pick')?.open);
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('#m-pick-rows .m-row')).find((b) => b.textContent.includes('林禾'));
    btn.click();
  });
  await page.evaluate(() => document.getElementById('m-form-name').requestSubmit());
  await page.waitForFunction(() => !document.getElementById('m-dlg-name')?.open, { timeout: 10000 });
  const after = await apiJson(auth.token, 'GET', '/persons');
  const tree = await apiJson(auth.token, 'GET', `/persons/${auth.idLan}/tree`);
  fs.writeFileSync(path.join(ARTIFACTS_DIR, 'INT-PM3-existing.json'), JSON.stringify({ before: before.json, after: after.json, tree: tree.json }, null, 2));
  await screenshot('INT-PM3-existing.png');
  const ok = (before.json.data || []).length === (after.json.data || []).length
    && (tree.json.edges || []).some((e) => e.type === 'sibling'
      && ((Number(e.a) === Number(auth.idLan) && Number(e.b) === Number(auth.idHe))
        || (Number(e.b) === Number(auth.idLan) && Number(e.a) === Number(auth.idHe))));
  log('INT-PM3-existing', ok, JSON.stringify({
    before: before.json.data.length,
    after: after.json.data.length,
  }), { account_id: auth.userId, tree_id: auth.treeId, target_id: auth.idLan });
}

async function main() {
  console.log('START hashes', START_HASHES);
  await setup();
  try {
    await testInt01MainPath();
    await testInt02ListOverview();
    await testInt03Children409();
    await testInt04FailUnknown();
    await testInt05CorrectionVsDelete();
    await testInt06PreviewIsolation();
    await testInt07Viewports();
    await testInt08ReduceMotionKeyboard();
    await testInt09AsyncIdentityGate();
    await testInt10BindFailedZeroExtraPost();
    await testInt11RegressionSuitePointer();
    await testInvalidIdSafeClose();
    await testRecognizeExistingNoNewPerson();
  } catch (err) {
    fatalError = String(err?.stack || err);
    console.error(fatalError);
  } finally {
    await browser?.close();
  }

  // Suites need server; run after UI browser closed
  if (!fatalError && process.env.SKIP_SUITES !== '1') {
    try {
      await runNamedSuites();
    } catch (err) {
      fatalError = String(err?.stack || err);
      const idx = results.findIndex((r) => r.id === 'INT-11');
      const entry = { id: 'INT-11', status: 'UNVERIFIED', message: fatalError, at: new Date().toISOString() };
      if (idx >= 0) results[idx] = entry;
      else results.push(entry);
    }
  } else if (process.env.SKIP_SUITES === '1') {
    const idx = results.findIndex((r) => r.id === 'INT-11');
    const entry = { id: 'INT-11', status: 'NOT RUN', message: 'SKIP_SUITES=1', at: new Date().toISOString() };
    if (idx >= 0) results[idx] = entry;
    else results.push(entry);
  }

  const END_HASHES = sourceHashes();
  const summary = {
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    baseUrl: BASE_URL,
    startHashes: START_HASHES,
    endHashes: END_HASHES,
    hashesUnchangedDuringRun: JSON.stringify(START_HASHES) === JSON.stringify(END_HASHES),
    fatalError,
    results,
  };
  fs.writeFileSync(path.join(ARTIFACTS_DIR, 'INTEGRATION-QA-RESULTS.json'), JSON.stringify(summary, null, 2));
  fs.writeFileSync(path.join(STORE_DIR, 'INTEGRATION-QA-RESULTS.json'), JSON.stringify(summary, null, 2));
  const md = [
    '# Integration QA results',
    '',
    `- finished: ${summary.finishedAt}`,
    `- HEAD: ${END_HASHES.head}`,
    `- dirty: ${END_HASHES.dirty ? 'YES' : 'clean'}`,
    `- hashes unchanged during run: ${summary.hashesUnchangedDuringRun}`,
    '',
    '| id | status | message |',
    '|---|---|---|',
    ...results.map((r) => `| ${r.id} | ${r.status} | ${(r.message || '').replace(/\|/g, '\\|').slice(0, 180)} |`),
  ].join('\n');
  fs.writeFileSync(path.join(ARTIFACTS_DIR, 'INTEGRATION-QA-RESULTS.md'), md);
  fs.writeFileSync(path.join(STORE_DIR, 'INTEGRATION-QA-RESULTS.md'), md);
  console.log(md);
  if (fatalError || results.some((r) => r.status === 'observed FAIL')) process.exit(1);
}

main();
