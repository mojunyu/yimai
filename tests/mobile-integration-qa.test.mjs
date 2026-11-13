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

function gitHeadShort() {
  return spawnSync('git', ['rev-parse', '--short=12', 'HEAD'], { cwd: APP_ROOT, encoding: 'utf8' }).stdout.trim();
}

const STORE_DIR = process.env.EVIDENCE_STORE
  ? path.resolve(process.env.EVIDENCE_STORE)
  : path.join('/cursor/stores/self', `yimai-mobile-integration-${gitHeadShort()}`);

fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
fs.mkdirSync(path.join(ARTIFACTS_DIR, 'screenshots'), { recursive: true });
fs.mkdirSync(path.join(ARTIFACTS_DIR, 'api-json'), { recursive: true });
fs.mkdirSync(path.join(ARTIFACTS_DIR, 'network'), { recursive: true });
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
  const status = passed ? 'PASS' : 'observed FAIL';
  console.log(`${status}: ${id}${message ? ' - ' + message : ''}`);
  results.push({
    id,
    status,
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

function sanitizeNet(entry) {
  // Never archive Authorization / passwords / tokens.
  const headers = { ...(entry.headers || {}) };
  for (const key of Object.keys(headers)) {
    if (/authorization|cookie|token|password|x-xsrf/i.test(key)) {
      headers[key] = '[REDACTED]';
    }
  }
  return {
    method: entry.method,
    url: String(entry.url || '').replace(/([?&](?:token|password|access_token)=)[^&]*/gi, '$1[REDACTED]'),
    resourceType: entry.resourceType || null,
    headers,
  };
}

async function screenshot(name) {
  const file = path.join(ARTIFACTS_DIR, 'screenshots', name);
  await page.screenshot({ path: file, fullPage: false });
  return file;
}

async function screenshotFull(name) {
  const file = path.join(ARTIFACTS_DIR, 'screenshots', name);
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

async function productLogin(email, password) {
  await page.goto(`${BASE_URL}/app/`, { waitUntil: 'networkidle0' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'networkidle0' });
  await page.click('#email', { clickCount: 3 });
  await page.type('#email', email);
  await page.click('#password', { clickCount: 3 });
  await page.type('#password', password);
  await page.click('#btn-login');
  await page.waitForFunction(() => document.body.classList.contains('is-authed'), { timeout: 15000 });
  // Scrub password field so later screenshots never show credentials.
  await page.evaluate(() => {
    const pw = document.getElementById('password');
    if (pw) pw.value = '';
  });
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
$spouse=App\\Models\\SpouseLink::create(['tree_id'=>$t->id,'person_a_id'=>$lan->id,'person_b_id'=>$shi->id]);
$sib=App\\Models\\SiblingLink::create(['tree_id'=>$t->id,'person_a_id'=>min($lan->id,$zhou->id),'person_b_id'=>max($lan->id,$zhou->id)]);
echo json_encode([
  'userId'=>$u->id,'treeId'=>$t->id,'token'=>$u->createToken('t')->plainTextToken,
  'idGu'=>$gu->id,'idYu'=>$yu->id,'idZhou'=>$zhou->id,'idLan'=>$lan->id,'idHe'=>$he->id,'idShi'=>$shi->id,
  'spouseLinkId'=>$spouse->id,'siblingLinkId'=>$sib->id,
  'rootId'=>$lan->id,'account_email'=>$email,'password'=>'password'
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

async function probeAddVisibility() {
  return page.evaluate(() => {
    const add = document.getElementById('m-btn-add');
    const shell = document.getElementById('mobile-shell');
    if (!add || !shell || shell.hidden) {
      return { ok: false, reason: 'missing' };
    }
    const r = add.getBoundingClientRect();
    const vh = window.innerHeight;
    const vw = window.innerWidth;
    const inViewport = r.width > 0 && r.height > 0
      && r.top >= 0 && r.left >= 0
      && r.bottom <= vh + 0.5 && r.right <= vw + 0.5;
    const cx = Math.min(vw - 1, Math.max(0, r.left + r.width / 2));
    const cy = Math.min(vh - 1, Math.max(0, r.top + r.height / 2));
    const topEl = document.elementFromPoint(cx, cy);
    const clickable = Boolean(topEl && (topEl === add || add.contains(topEl)));
    const nameEl = document.getElementById('m-detail-name');
    const cs = nameEl ? getComputedStyle(nameEl) : null;
    const shellCs = getComputedStyle(shell);
    const rootCs = getComputedStyle(document.documentElement);
    const desktopCover = (() => {
      const sheet = document.getElementById('sheet');
      if (!sheet || sheet.classList.contains('hidden')) return false;
      const sr = sheet.getBoundingClientRect();
      // Desktop sheet/canvas must not dominate the narrow viewport over the mobile shell.
      return sr.width > vw * 0.5 && sr.height > vh * 0.4 && sr.top < vh * 0.3
        && shellCs.position !== 'fixed';
    })();
    return {
      ok: inViewport && clickable && !desktopCover,
      inViewport,
      clickable,
      desktopCover,
      rect: { top: r.top, left: r.left, width: r.width, height: r.height, bottom: r.bottom },
      viewport: { w: vw, h: vh },
      name: nameEl?.textContent || '',
      nameFontSize: cs?.fontSize || null,
      nameFontFamily: cs?.fontFamily || null,
      mFontVar: rootCs.getPropertyValue('--m-font').trim(),
      shellWidth: shell.getBoundingClientRect().width,
      shellPosition: shellCs.position,
      layoutWidth: document.documentElement.clientWidth,
    };
  });
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
  fs.writeFileSync(path.join(ARTIFACTS_DIR, 'api-json', 'INT-01-api.json'), JSON.stringify({
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
  await mobileOpenByName('林岚');
  await mobileAddRelative('儿子', '全谱儿');
  await page.evaluate(() => {
    window.yimaiMobile.showView('list');
    window.yimaiMobile.sync();
  });
  await page.waitForSelector('#m-view-list:not([hidden])');
  const listSnap = await page.evaluate(() => ({
    ids: Array.from(document.querySelectorAll('#m-list-rows .m-row'))
      .map((b) => b.dataset.openId)
      .filter(Boolean),
    text: document.getElementById('m-list-rows')?.innerText || '',
  }));
  await screenshot('INT-02-list.png');
  await page.evaluate(() => document.getElementById('m-btn-overview')?.click());
  await page.waitForSelector('#m-view-overview:not([hidden])');
  const overviewSnap = await page.evaluate(() => ({
    text: document.getElementById('m-overview-body')?.innerText || '',
    ids: Array.from(document.querySelectorAll('#m-overview-body [data-open-id]'))
      .map((b) => b.dataset.openId),
  }));
  await screenshot('INT-02-overview.png');
  const persons = await apiJson(auth.token, 'GET', '/persons');
  const tree = await apiJson(auth.token, 'GET', `/persons/${auth.idLan}/tree`);
  const apiIds = (persons.json.data || []).map((p) => String(p.id)).sort();
  const treeIds = (tree.json.nodes || []).map((n) => String(n.id)).sort();
  const listIds = [...listSnap.ids].map(String).sort();
  const overviewIds = [...new Set(overviewSnap.ids.map(String))].sort();
  fs.writeFileSync(path.join(ARTIFACTS_DIR, 'api-json', 'INT-02-api.json'), JSON.stringify({
    persons: persons.json,
    tree: tree.json,
    listIds,
    overviewIds,
    apiIds,
    treeIds,
  }, null, 2));
  const sameIds = JSON.stringify(apiIds) === JSON.stringify(treeIds)
    && apiIds.every((id) => listIds.includes(id))
    && apiIds.every((id) => overviewIds.includes(id));
  const ok = sameIds
    && listSnap.text.includes('全谱儿')
    && overviewSnap.text.includes('全谱儿')
    && overviewSnap.text.includes('林岚');
  log('INT-02', ok, JSON.stringify({
    listCount: listIds.length,
    overviewCount: overviewIds.length,
    apiCount: apiIds.length,
    sameIds,
  }), { account_id: auth.userId, tree_id: auth.treeId });
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
    authEmail: document.getElementById('email')?.value || '',
    authPasswordFilled: Boolean(document.getElementById('password')?.value),
    shellHidden: document.getElementById('mobile-shell')?.hidden
      || getComputedStyle(document.getElementById('mobile-shell')).display === 'none',
  }));
  const del = await apiJson(auth.token, 'DELETE', `/persons/${auth.idGu}`);
  const still = await apiJson(auth.token, 'GET', `/persons/${auth.idGu}`);
  await screenshot('INT-03-409.png');
  fs.writeFileSync(path.join(ARTIFACTS_DIR, 'api-json', 'INT-03-api.json'), JSON.stringify({ delete: del, still: still.json }, null, 2));
  const ok = del.status === 409
    && Array.isArray(del.json?.children)
    && del.json.children.length > 0
    && still.status === 200
    && (ui.body || '').includes('更正')
    && ui.actions.some((a) => a.includes('打开并更正'))
    && !ui.authPasswordFilled;
  log('INT-03', ok, JSON.stringify({ status: del.status, actions: ui.actions, shellHidden: ui.shellHidden }), {
    account_id: auth.userId,
    tree_id: auth.treeId,
    target_id: auth.idGu,
  });
}

async function testInt04FailUnknown() {
  const auth = seedLanFamily();
  await openAuthed(auth, auth.idShi);
  await mobileOpenByName('周石');
  const targetId = auth.idShi;

  // Branch A: definite 4xx (422) — visible reject feedback, confirm stays, original ID retained.
  await page.evaluate((id) => {
    window.__yimaiDeleteMode = '422';
    const originalFetch = window.__yimaiOriginalFetch || window.fetch.bind(window);
    window.__yimaiOriginalFetch = originalFetch;
    window.fetch = async (url, opts = {}) => {
      const u = String(url);
      const m = (opts.method || 'GET').toUpperCase();
      if (window.__yimaiDeleteMode === '422' && m === 'DELETE' && u.includes(`/persons/${id}`)) {
        window.__yimaiDeleteMode = null;
        return new Response(JSON.stringify({ message: 'forced client rejection 422' }), {
          status: 422,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (window.__yimaiDeleteMode === 'network' && m === 'DELETE' && u.includes(`/persons/${id}`)) {
        window.__yimaiDeleteMode = null;
        throw new TypeError('Failed to fetch (injected)');
      }
      if (window.__yimaiDeleteMode === 'lost' && m === 'DELETE' && u.includes(`/persons/${id}`)) {
        window.__yimaiDeleteMode = null;
        // Simulate submitted-but-unreadable response (uncertain parse path).
        return new Response('<<<not-json>>>', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return originalFetch(url, opts);
    };
  }, targetId);

  async function openDeleteConfirm() {
    await page.evaluate(() => {
      document.getElementById('m-btn-more')?.click();
      const del = Array.from(document.querySelectorAll('#m-more-rows .m-row'))
        .find((b) => (b.textContent || '').includes('删除此人'));
      del?.click();
    });
    await page.waitForSelector('#sheet-confirm:not(.hidden)');
    await page.evaluate(() => document.querySelector('#sheet-confirm-actions button[data-confirm-primary="1"]')?.click());
  }

  await openDeleteConfirm();
  await page.waitForFunction(() => {
    const err = document.getElementById('sheet-confirm-error')?.textContent || '';
    return err.length > 0;
  }, { timeout: 8000 });
  const ui422 = await page.evaluate((id) => ({
    confirmHidden: document.getElementById('sheet-confirm')?.classList.contains('hidden'),
    err: document.getElementById('sheet-confirm-error')?.textContent || '',
    body: document.getElementById('sheet-confirm-body')?.textContent || '',
    title: document.getElementById('sheet-confirm-title')?.textContent || '',
    mentionsId: (document.getElementById('sheet-confirm-body')?.textContent || '').includes(String(id))
      || (document.getElementById('sheet-confirm-title')?.textContent || '').includes('周石'),
  }), targetId);
  await screenshot('INT-04-4xx.png');
  await page.evaluate(() => {
    const btn = document.querySelector('#sheet-confirm-actions button[data-confirm-cancel="1"]')
      || Array.from(document.querySelectorAll('#sheet-confirm-actions button'))
        .find((b) => /取消|关闭/.test(b.textContent || ''));
    btn?.click();
  });
  await sleep(300);

  // Branch B: network failure → unknown result with 原谱号.
  await page.evaluate(() => { window.__yimaiDeleteMode = 'network'; });
  await mobileOpenByName('周石');
  await openDeleteConfirm();
  await page.waitForFunction(() => (document.getElementById('sheet-confirm-title')?.textContent || '').includes('不确定'), { timeout: 8000 });
  const uiUnknown = await page.evaluate((id) => ({
    confirmHidden: document.getElementById('sheet-confirm')?.classList.contains('hidden'),
    title: document.getElementById('sheet-confirm-title')?.textContent || '',
    body: document.getElementById('sheet-confirm-body')?.textContent || '',
    err: document.getElementById('sheet-confirm-error')?.textContent || '',
    hasYuan: (document.getElementById('sheet-confirm-body')?.textContent || '').includes(`原谱号 ${id}`)
      || (document.getElementById('sheet-confirm-body')?.textContent || '').includes(String(id)),
  }), targetId);
  await screenshot('INT-04-unknown.png');
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('#sheet-confirm-actions button'))
      .find((b) => (b.textContent || '').includes('关闭'));
    btn?.click();
  });
  await sleep(300);

  // Branch C: lost/unreadable submitted response → unknown with 原谱号.
  await page.evaluate(() => { window.__yimaiDeleteMode = 'lost'; });
  await mobileOpenByName('周石');
  await openDeleteConfirm();
  await page.waitForFunction(() => (document.getElementById('sheet-confirm-title')?.textContent || '').includes('不确定'), { timeout: 8000 });
  const uiLost = await page.evaluate((id) => ({
    confirmHidden: document.getElementById('sheet-confirm')?.classList.contains('hidden'),
    title: document.getElementById('sheet-confirm-title')?.textContent || '',
    body: document.getElementById('sheet-confirm-body')?.textContent || '',
    hasYuan: (document.getElementById('sheet-confirm-body')?.textContent || '').includes(String(id)),
  }), targetId);
  await screenshot('INT-04-lost.png');

  const still = await apiJson(auth.token, 'GET', `/persons/${targetId}`);
  const lan = await apiJson(auth.token, 'GET', `/persons/${auth.idLan}`);
  fs.writeFileSync(path.join(ARTIFACTS_DIR, 'api-json', 'INT-04-api.json'), JSON.stringify({
    still: still.json, lan: lan.json, ui422, uiUnknown, uiLost, targetId,
  }, null, 2));

  const ok = still.status === 200
    && lan.status === 200
    && ui422.confirmHidden === false
    && (ui422.err || '').length > 0
    && ui422.mentionsId
    && uiUnknown.confirmHidden === false
    && (uiUnknown.title || '').includes('不确定')
    && uiUnknown.hasYuan
    && uiLost.confirmHidden === false
    && (uiLost.title || '').includes('不确定')
    && uiLost.hasYuan;
  log('INT-04', ok, JSON.stringify({ still: still.status, ui422, uiUnknown, uiLost }), {
    account_id: auth.userId,
    tree_id: auth.treeId,
    target_id: targetId,
  });
}

async function testInt05CorrectionVsDelete() {
  const auth = seedLanFamily();
  await openAuthed(auth, auth.idLan);
  await mobileOpenByName('林岚');

  // Parent mis-record correction via product UI (clear mother), not delete.
  await page.evaluate(() => {
    document.getElementById('m-btn-more')?.click();
    const btn = Array.from(document.querySelectorAll('#m-more-rows .m-row'))
      .find((b) => (b.textContent || '').includes('更正母亲'));
    if (!btn) throw new Error('missing 更正母亲');
    btn.click();
  });
  await page.waitForSelector('#sheet-confirm:not(.hidden)');
  await page.evaluate(() => document.querySelector('#sheet-confirm-actions button[data-confirm-primary="1"]')?.click());
  await page.waitForFunction(() => document.getElementById('sheet-confirm')?.classList.contains('hidden'), { timeout: 8000 });
  const afterMother = await apiJson(auth.token, 'GET', `/persons/${auth.idLan}`);

  // Spouse unlink via real DELETE /spouse-links/{id} product path — must not delete 周石.
  await mobileOpenByName('林岚');
  await page.evaluate(() => {
    document.getElementById('m-btn-more')?.click();
    const btn = Array.from(document.querySelectorAll('#m-more-rows .m-row'))
      .find((b) => (b.textContent || '').includes('解除夫妻'));
    if (!btn) throw new Error('missing 解除夫妻');
    btn.click();
  });
  await page.waitForSelector('#sheet-confirm:not(.hidden)');
  const spouseNet = [];
  page.removeAllListeners('request');
  page.on('request', (req) => {
    if (/\/spouse-links\//.test(req.url()) && req.method() === 'DELETE') {
      spouseNet.push(sanitizeNet({ method: req.method(), url: req.url(), headers: req.headers() }));
    }
  });
  await page.evaluate(() => document.querySelector('#sheet-confirm-actions button[data-confirm-primary="1"]')?.click());
  await page.waitForFunction(() => document.getElementById('sheet-confirm')?.classList.contains('hidden'), { timeout: 8000 });
  const shiStill = await apiJson(auth.token, 'GET', `/persons/${auth.idShi}`);
  const spouseList = await apiJson(auth.token, 'GET', '/spouse-links');
  const spouseGone = !(spouseList.json?.data || []).some((l) => Number(l.id) === Number(auth.spouseLinkId));

  // Explicit sibling unlink; inferred co-parent sibling prompt must remain.
  await mobileOpenByName('林岚');
  await page.evaluate(() => {
    document.getElementById('m-btn-more')?.click();
    const btn = Array.from(document.querySelectorAll('#m-more-rows .m-row'))
      .find((b) => (b.textContent || '').includes('移除显式兄妹'));
    if (!btn) throw new Error('missing 移除显式兄妹');
    btn.click();
  });
  await page.waitForSelector('#sheet-confirm:not(.hidden)');
  await page.evaluate(() => document.querySelector('#sheet-confirm-actions button[data-confirm-primary="1"]')?.click());
  await page.waitForFunction(() => document.getElementById('sheet-confirm')?.classList.contains('hidden'), { timeout: 8000 });
  await sleep(400);
  await mobileOpenByName('林岚');
  const kin = await page.$eval('#m-detail-kin', (el) => el.innerText);
  const sheetErr = await page.evaluate(() => document.getElementById('sheet-error')?.textContent || '');
  const sheetSummary = await page.evaluate(() => document.getElementById('sheet-summary')?.innerText || '');
  const zhouStill = await apiJson(auth.token, 'GET', `/persons/${auth.idZhou}`);
  const heStill = await apiJson(auth.token, 'GET', `/persons/${auth.idHe}`);
  await screenshot('INT-05-detail.png');
  fs.writeFileSync(path.join(ARTIFACTS_DIR, 'api-json', 'INT-05-api.json'), JSON.stringify({
    afterMother: afterMother.json,
    shiStill: { status: shiStill.status, id: shiStill.json?.id },
    spouseGone,
    spouseNet,
    spouseLinkId: auth.spouseLinkId,
    siblingLinkId: auth.siblingLinkId,
    zhouStill: zhouStill.status,
    heStill: heStill.status,
    kin,
    sheetErr,
    sheetSummary,
  }, null, 2));
  fs.writeFileSync(path.join(ARTIFACTS_DIR, 'network', 'INT-05-spouse-unlink.json'), JSON.stringify(spouseNet, null, 2));

  const inferredPrompt = (kin || '').includes('因共同父母')
    || (sheetErr || '').includes('因共同父母')
    || (sheetSummary || '').includes('因共同父母');
  const ok = afterMother.status === 200
    && afterMother.json.mother_id == null
    && afterMother.json.father_id != null
    && Number(afterMother.json.father_id) === Number(auth.idGu)
    && shiStill.status === 200
    && spouseGone
    && spouseNet.some((n) => n.url.includes(`/spouse-links/${auth.spouseLinkId}`))
    && zhouStill.status === 200
    && heStill.status === 200
    && kin.includes('林禾')
    && inferredPrompt;
  log('INT-05', ok, JSON.stringify({
    mother: afterMother.json.mother_id,
    spouseGone,
    spouseLinkHit: spouseNet.map((n) => n.url),
    inferredPrompt,
  }), { account_id: auth.userId, tree_id: auth.treeId, target_id: auth.idLan });
}

async function testInt06PreviewIsolation() {
  const apiHits = [];
  page.removeAllListeners('request');
  page.on('request', (req) => {
    if (req.url().includes('/api/v1/')) {
      apiHits.push(sanitizeNet({ method: req.method(), url: req.url(), headers: req.headers(), resourceType: req.resourceType() }));
    }
  });

  // Seed a fake production pointer first, then enter preview — preview must not overwrite it.
  await page.goto(`${BASE_URL}/app/`, { waitUntil: 'networkidle0' });
  await page.evaluate(() => {
    localStorage.clear();
    localStorage.setItem('yimai_root_id', 'prod-root-sentinel');
    localStorage.setItem('yimai_tree_id', 'prod-tree-sentinel');
    localStorage.setItem('yimai_add_recovery', JSON.stringify({ phase: 'prod', userId: 'prod-user' }));
  });
  const beforePreview = await page.evaluate(() => ({
    root: localStorage.getItem('yimai_root_id'),
    tree: localStorage.getItem('yimai_tree_id'),
    recovery: localStorage.getItem('yimai_add_recovery'),
    token: localStorage.getItem('yimai_token'),
  }));

  await openPreview();
  await mobileOpenByName('林岚');
  await mobileAddRelative('儿子', '预览儿');
  await page.evaluate(() => {
    document.getElementById('m-btn-back-detail')?.click();
  });
  await page.waitForSelector('#m-view-list:not([hidden])');
  await page.evaluate(() => document.getElementById('m-btn-overview')?.click());
  await page.waitForSelector('#m-view-overview:not([hidden])');
  const duringPreview = await page.evaluate(() => ({
    root: localStorage.getItem('yimai_root_id'),
    tree: localStorage.getItem('yimai_tree_id'),
    recovery: localStorage.getItem('yimai_add_recovery'),
    token: localStorage.getItem('yimai_token'),
    isPreview: window.yimaiMobile?.isPreview?.(),
  }));
  await screenshot('INT-06-preview.png');

  // Leave preview to formal /app/ in same browser — production pointers must survive.
  await page.goto(`${BASE_URL}/app/`, { waitUntil: 'networkidle0' });
  const afterPreview = await page.evaluate(() => ({
    root: localStorage.getItem('yimai_root_id'),
    tree: localStorage.getItem('yimai_tree_id'),
    recovery: localStorage.getItem('yimai_add_recovery'),
    token: localStorage.getItem('yimai_token'),
  }));
  await screenshot('INT-06-prod-auth.png');

  const prod = await page.evaluate(async () => {
    const res = await fetch(`${location.origin}/api/v1/persons`, { headers: { Accept: 'application/json' } });
    return res.status;
  });

  fs.writeFileSync(path.join(ARTIFACTS_DIR, 'network', 'INT-06-net.json'), JSON.stringify({
    beforePreview, duringPreview, afterPreview, apiHits,
  }, null, 2));
  fs.writeFileSync(path.join(ARTIFACTS_DIR, 'api-json', 'INT-06-localstorage.json'), JSON.stringify({
    beforePreview, duringPreview, afterPreview,
  }, null, 2));

  const writes = apiHits.filter((h) => !['GET', 'HEAD', 'OPTIONS'].includes(h.method));
  const pointersIntact = afterPreview.root === 'prod-root-sentinel'
    && afterPreview.tree === 'prod-tree-sentinel'
    && (afterPreview.recovery || '').includes('prod-user')
    && duringPreview.root === 'prod-root-sentinel'
    && duringPreview.tree === 'prod-tree-sentinel';
  const ok = writes.length === 0 && prod === 401 && pointersIntact && duringPreview.isPreview === true;
  log('INT-06', ok, JSON.stringify({
    apiHits: apiHits.length, writes, prod, pointersIntact, duringPreview, afterPreview,
  }), { fixture: 'preview-memory-林岚' });
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
    // Scroll CTA into view if needed, then require real visibility + clickability.
    await page.evaluate(() => document.getElementById('m-btn-add')?.scrollIntoView({ block: 'nearest' }));
    await sleep(100);
    let probe = await probeAddVisibility();
    if (!probe.inViewport) {
      await page.evaluate(() => document.getElementById('m-btn-add')?.scrollIntoView({ block: 'center' }));
      await sleep(100);
      probe = await probeAddVisibility();
    }
    // Real click path — not only bbox.
    let clicked = false;
    if (probe.clickable && probe.inViewport) {
      await page.click('#m-btn-add');
      clicked = await page.evaluate(() => Boolean(document.getElementById('m-dlg-rel')?.open));
      if (clicked) {
        await page.evaluate(() => document.getElementById('m-rel-cancel')?.click());
        await page.waitForFunction(() => !document.getElementById('m-dlg-rel')?.open);
      }
    }
    await screenshot(`INT-07-${vp.name}.png`);
    // Also scroll-reach proof: list → detail CTA reachable.
    await page.evaluate(() => {
      window.yimaiMobile.showView('list');
      window.yimaiMobile.sync();
    });
    await page.waitForSelector('#m-view-list:not([hidden])');
    await mobileOpenByName('林岚');
    await page.evaluate(() => {
      const shell = document.getElementById('mobile-shell');
      if (shell) shell.scrollTop = shell.scrollHeight;
    });
    await sleep(80);
    const afterScroll = await probeAddVisibility();
    reports.push({
      ...vp,
      ...probe,
      clicked,
      afterScrollInViewport: afterScroll.inViewport,
      afterScrollClickable: afterScroll.clickable,
    });
  }
  await page.setViewport({ width: 390, height: 844 });
  fs.writeFileSync(path.join(ARTIFACTS_DIR, 'api-json', 'INT-07-layout.json'), JSON.stringify(reports, null, 2));
  const ok = reports.every((r) => (
    r.ok && r.clicked && r.name === '林岚'
    && Number.parseFloat(r.nameFontSize) >= 28
    // System sans stack via --m-font; must not inherit desktop Noto Serif SC.
    && /apple-system|BlinkMacSystemFont|Segoe UI|PingFang|Noto Sans|sans-serif/i.test(r.mFontVar || '')
    && !/Noto Serif/i.test(r.nameFontFamily || '')
    && !/Noto Serif/i.test(r.mFontVar || '')
    && r.shellPosition === 'fixed'
    && Math.abs(r.shellWidth - r.layoutWidth) < 2
    && !r.desktopCover
  ));
  log('INT-07', ok, JSON.stringify(reports), { account_id: auth.userId, tree_id: auth.treeId });
}

async function testInt08ReduceMotionKeyboard() {
  const auth = seedLanFamily();
  await openAuthed(auth, auth.idLan);
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await page.evaluate(() => document.documentElement.classList.add('reduce-motion'));
  await mobileOpenByName('林岚');
  await page.evaluate(() => document.getElementById('m-btn-add').click());
  await page.waitForFunction(() => document.getElementById('m-dlg-rel')?.open);

  const focusTrail = [];
  // Keyboard-only: Tab until cancel is focused, then activate with Enter (not mouse).
  let landed = false;
  for (let i = 0; i < 24; i += 1) {
    const snap = await page.evaluate(() => ({
      id: document.activeElement?.id || '',
      text: (document.activeElement?.textContent || '').trim().slice(0, 40),
      tag: document.activeElement?.tagName || '',
    }));
    focusTrail.push(snap);
    if (snap.id === 'm-rel-cancel') {
      landed = true;
      break;
    }
    await page.keyboard.press('Tab');
  }
  await screenshot('INT-08-focus.png');
  if (landed) {
    await page.keyboard.press('Enter');
  }
  await page.waitForFunction(() => !document.getElementById('m-dlg-rel')?.open, { timeout: 5000 }).catch(() => {});
  const closed = await page.evaluate(() => !document.getElementById('m-dlg-rel')?.open);
  const reduceOn = await page.evaluate(() => (
    document.documentElement.classList.contains('reduce-motion')
    || matchMedia('(prefers-reduced-motion: reduce)').matches
  ));
  await screenshot('INT-08-reduce.png');
  fs.writeFileSync(path.join(ARTIFACTS_DIR, 'api-json', 'INT-08-focus.json'), JSON.stringify({
    focusTrail, landed, closed, reduceOn,
  }, null, 2));
  const ok = landed && closed && reduceOn
    && focusTrail.some((f) => f.id === 'm-rel-cancel');
  log('INT-08', ok, JSON.stringify({ landed, closed, reduceOn, focusTrail }), {
    note: 'desktop keyboard + prefers-reduced-motion; not device soft keyboard',
  });
}

async function testInt09AsyncIdentityGate() {
  const a = seedLanFamily();
  const b = phpSeed(`
$u=App\\Models\\User::create(['name'=>'IsoB','email'=>$email,'password'=>bcrypt('password')]);
$t=App\\Models\\Tree::create(['owner_user_id'=>$u->id,'title'=>'IsoB']);
$p=App\\Models\\Person::create(['tree_id'=>$t->id,'name'=>'乙独','gender'=>'male','generation'=>1]);
echo json_encode(['userId'=>$u->id,'treeId'=>$t->id,'token'=>$u->createToken('t')->plainTextToken,'idT'=>$p->id,'rootId'=>$p->id,'account_email'=>$email,'password'=>'password'], JSON_UNESCAPED_UNICODE);
`);

  const netTrace = [];
  page.removeAllListeners('request');
  page.on('request', (req) => {
    if (req.url().includes('/api/v1/')) {
      netTrace.push({
        ...sanitizeNet({ method: req.method(), url: req.url(), headers: req.headers() }),
        at: new Date().toISOString(),
        accountHint: req.headers().authorization ? '[bearer-present]' : '[no-auth]',
      });
    }
  });

  await productLogin(a.account_email, a.password);
  await page.waitForFunction(() => (document.getElementById('m-list-rows')?.innerText || '').includes('林岚'), { timeout: 10000 });
  // Live session token from product login() — not the seed token from php createToken.
  const tokenALive = await page.evaluate(() => localStorage.getItem('yimai_token') || '');
  if (!tokenALive) throw new Error('INT-09 missing live A token after product login');

  // Arm delay on product loadTree's tree GET for account A (Authorization match), then kick loadTree.
  await page.evaluate((tokenA) => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    window.__yimaiReleaseDelayedTree = () => release();
    window.__yimaiDelayedTreeReleased = false;
    window.__yimaiDelayedTreeHit = false;
    const originalFetch = window.fetch.bind(window);
    let armed = true;
    const tokenNeedle = String(tokenA).slice(0, 16);
    window.fetch = async (url, opts = {}) => {
      const u = String(url);
      const hdrs = opts.headers || {};
      let auth = '';
      if (typeof hdrs.get === 'function') auth = hdrs.get('Authorization') || hdrs.get('authorization') || '';
      else auth = hdrs.Authorization || hdrs.authorization || '';
      if (armed && /\/persons\/\d+\/tree/.test(u) && String(auth).includes(tokenNeedle)) {
        armed = false;
        window.__yimaiDelayedTreeHit = true;
        await gate;
        window.__yimaiDelayedTreeReleased = true;
      }
      return originalFetch(url, opts);
    };
  }, tokenALive);

  // Kick product loadTree (in-flight A) without destroying the page.
  const loadPromiseHandle = page.evaluate(() => window.yimaiMobile.loadTree());
  await page.waitForFunction(() => window.__yimaiDelayedTreeHit === true, { timeout: 8000 });

  // Page-local switch to B via product login() — no reload, A request stays alive.
  await page.evaluate(() => {
    const pw = document.getElementById('password');
    const em = document.getElementById('email');
    if (pw) pw.value = '';
    if (em) em.value = '';
  });
  await page.click('#email', { clickCount: 3 });
  await page.type('#email', b.account_email);
  await page.click('#password', { clickCount: 3 });
  await page.type('#password', b.password);
  await page.click('#btn-login');
  await page.waitForFunction(() => (document.getElementById('m-list-rows')?.innerText || '').includes('乙独'), { timeout: 15000 });
  await page.evaluate(() => {
    const pw = document.getElementById('password');
    if (pw) pw.value = '';
  });

  const mid = await page.evaluate(() => window.yimaiMobile.stateSnap());
  await screenshot('INT-09-gate-mid.png');

  // Release A's delayed tree response; product gate must drop it.
  await page.evaluate(() => window.__yimaiReleaseDelayedTree?.());
  await loadPromiseHandle.catch(() => {});
  await sleep(600);
  const after = await page.evaluate(() => ({
    ...window.yimaiMobile.stateSnap(),
    delayedReleased: window.__yimaiDelayedTreeReleased === true,
    delayedHit: window.__yimaiDelayedTreeHit === true,
  }));
  await screenshot('INT-09-gate.png');

  fs.writeFileSync(path.join(ARTIFACTS_DIR, 'api-json', 'INT-09-api.json'), JSON.stringify({
    mid,
    after,
    a: { userId: a.userId, treeId: a.treeId },
    b: { userId: b.userId, treeId: b.treeId },
  }, null, 2));
  fs.writeFileSync(path.join(ARTIFACTS_DIR, 'network', 'INT-09-net.json'), JSON.stringify(netTrace, null, 2));

  const polluted = (after.personNames || []).includes('林岚')
    || (after.listText || '').includes('林岚')
    || (after.detailName || '').includes('林岚')
    || String(after.userId) === String(a.userId)
    || String(after.treeId) === String(a.treeId);
  const ok = mid.personNames.includes('乙独')
    && after.personNames.includes('乙独')
    && after.personNames.length === 1
    && String(after.userId) === String(b.userId)
    && String(after.treeId) === String(b.treeId)
    && after.delayedHit
    && after.delayedReleased
    && !polluted;
  log('INT-09', ok, JSON.stringify({ mid, after, polluted }), {
    account_id: b.userId,
    tree_id: b.treeId,
    note: 'product login + delayed product loadTree; no reload; A callback completed without polluting B',
  });
}

async function testInt10BindFailedZeroExtraPost() {
  const auth = seedLanFamily();
  await openAuthed(auth, auth.idLan);
  await mobileOpenByName('林岚');
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
        posts.push({ status: res.status, id: body?.id != null ? String(body.id) : null });
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
        const idMatch = u.match(/\/persons\/(\d+)/);
        patches.push({ status: res.status, url: u, id: idMatch ? idMatch[1] : null });
        return res;
      }
      return originalFetch(url, opts);
    };
    const lan = window.yimaiMobile.persons().find((p) => p.name === '林岚');
    window.yimaiMobile.openPerson(lan.id);
    document.querySelector('#kin-grid button[data-kin="son"]')?.click();
    document.getElementById('add-name').value = '绑定败儿';
    document.getElementById('form-add').requestSubmit();
    await new Promise((r) => setTimeout(r, 900));
    const recovery = JSON.parse(localStorage.getItem('yimai_add_recovery') || 'null');
    const createId = posts[0]?.id != null ? String(posts[0].id) : null;
    const pending = recovery?.pendingPersonId != null ? String(recovery.pendingPersonId) : null;
    // Retry — must PATCH same pending id, zero extra persons POST.
    document.getElementById('form-add').requestSubmit();
    await new Promise((r) => setTimeout(r, 1200));
    const recoveryAfter = JSON.parse(localStorage.getItem('yimai_add_recovery') || 'null');
    const successPatch = patches.find((p) => p.status >= 200 && p.status < 300);
    const retryId = successPatch?.id != null ? String(successPatch.id) : null;
    return {
      posts,
      patches,
      recovery,
      recoveryAfter,
      createId,
      pending,
      retryId,
      postsAfterCreate: posts.length,
      successfulPatchCount: patches.filter((p) => p.status >= 200 && p.status < 300).length,
    };
  });
  await screenshot('INT-10-bindfail.png');
  fs.writeFileSync(path.join(ARTIFACTS_DIR, 'api-json', 'INT-10-trace.json'), JSON.stringify(trace, null, 2));
  const ok = Boolean(trace.createId)
    && trace.createId === trace.pending
    && trace.createId === trace.retryId
    && trace.postsAfterCreate === 1
    && trace.successfulPatchCount === 1
    && Number(trace.posts[0]?.status) === 201;
  log('INT-10', ok, JSON.stringify(trace), {
    account_id: auth.userId,
    tree_id: auth.treeId,
    target_id: auth.idLan,
  });
}

async function testInt11RegressionSuitePointer() {
  mark('INT-11', 'NOT RUN', 'executed in suite phase after UI cases', { deferred: true });
}

async function runNamedSuites() {
  const suiteResults = [];
  for (const suite of [
    { id: 'REG-frontend', script: 'test:frontend', expectPass: 41 },
    { id: 'DEL-delete', script: 'test:delete', expectPass: 11 },
    { id: 'DEL-hardening', script: 'test:delete-hardening', expectPass: 34 },
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
      expectPass: suite.expectPass,
      // Full named lines — not a 20-row sample.
      namedPass: passLines,
      namedFail: failLines,
    });
  }
  fs.writeFileSync(path.join(ARTIFACTS_DIR, 'INT-11-suites.json'), JSON.stringify(suiteResults, null, 2));
  const idx = results.findIndex((r) => r.id === 'INT-11');
  const allOk = suiteResults.every((s) => (
    s.exit === 0 && s.failCount === 0 && s.passCount === s.expectPass
  ));
  const entry = {
    id: 'INT-11',
    status: allOk ? 'PASS' : 'observed FAIL',
    message: JSON.stringify(suiteResults.map((s) => ({
      id: s.id, exit: s.exit, passCount: s.passCount, failCount: s.failCount, expectPass: s.expectPass,
    }))),
    at: new Date().toISOString(),
    suites: suiteResults.map((s) => ({
      id: s.id,
      exit: s.exit,
      passCount: s.passCount,
      failCount: s.failCount,
      expectPass: s.expectPass,
      namedPass: s.namedPass,
      namedFail: s.namedFail,
    })),
  };
  if (idx >= 0) results[idx] = entry;
  else results.push(entry);
  console.log(`${entry.status}: INT-11 - ${entry.message}`);
  return allOk;
}

async function testInvalidIdSafeClose() {
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
  const posts = [];
  page.removeAllListeners('request');
  page.on('request', (req) => {
    if (req.method() === 'POST' && /\/api\/v1\/persons\/?$/.test(req.url().replace(/\?.*$/, ''))) {
      posts.push(sanitizeNet({ method: req.method(), url: req.url(), headers: req.headers() }));
    }
  });
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
  await sleep(400);
  const after = await apiJson(auth.token, 'GET', '/persons');
  const tree = await apiJson(auth.token, 'GET', `/persons/${auth.idLan}/tree`);
  fs.writeFileSync(path.join(ARTIFACTS_DIR, 'api-json', 'INT-PM3-existing.json'), JSON.stringify({
    before: before.json, after: after.json, tree: tree.json, posts,
  }, null, 2));
  fs.writeFileSync(path.join(ARTIFACTS_DIR, 'network', 'INT-PM3-posts.json'), JSON.stringify(posts, null, 2));
  await screenshot('INT-PM3-existing.png');
  const ok = (before.json.data || []).length === (after.json.data || []).length
    && posts.length === 0
    && (tree.json.edges || []).some((e) => e.type === 'sibling'
      && ((Number(e.a) === Number(auth.idLan) && Number(e.b) === Number(auth.idHe))
        || (Number(e.b) === Number(auth.idLan) && Number(e.a) === Number(auth.idHe))));
  log('INT-PM3-existing', ok, JSON.stringify({
    before: before.json.data.length,
    after: after.json.data.length,
    posts: posts.length,
  }), { account_id: auth.userId, tree_id: auth.treeId, target_id: auth.idLan });
}

async function captureServedHashes() {
  const assets = [
    { url: `${BASE_URL}/app/`, name: 'served-index.html' },
    { url: `${BASE_URL}/app/js/app.js`, name: 'served-app.js' },
    { url: `${BASE_URL}/app/css/app.css`, name: 'served-app.css' },
    { url: `${BASE_URL}/app/css/mobile.css`, name: 'served-mobile.css' },
    { url: `${BASE_URL}/app/js/preview-fixture.js`, name: 'served-preview-fixture.js' },
  ];
  for (const asset of assets) {
    const res = await fetch(asset.url);
    const buf = Buffer.from(await res.arrayBuffer());
    const hash = createHash('sha256').update(buf).digest('hex');
    fs.writeFileSync(path.join(ARTIFACTS_DIR, `${asset.name}`), buf);
    fs.writeFileSync(path.join(ARTIFACTS_DIR, `${asset.name}.sha256`), `${hash}\n`);
  }
  // Prove PHP controller is NOT publicly served.
  const phpProbe = await fetch(`${BASE_URL}/app/../app/Http/Controllers/Api/V1/PersonController.php`).catch(() => null);
  const phpStatus = phpProbe ? phpProbe.status : null;
  const phpBody = phpProbe ? (await phpProbe.text()).slice(0, 200) : '';
  fs.writeFileSync(path.join(ARTIFACTS_DIR, 'served-php-probe.json'), JSON.stringify({
    url: `${BASE_URL}/app/Http/Controllers/Api/V1/PersonController.php`,
    alt: `${BASE_URL}/app/../app/Http/Controllers/Api/V1/PersonController.php`,
    status: phpStatus,
    bodyStartsWithPhp: phpBody.trimStart().startsWith('<?php'),
    note: 'PHP source must not be publicly HTTP-served',
  }, null, 2));
}

function mirrorEvidenceToStore() {
  const copyRecursive = (src, dest) => {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      const from = path.join(src, entry.name);
      const to = path.join(dest, entry.name);
      if (entry.isDirectory()) copyRecursive(from, to);
      else fs.copyFileSync(from, to);
    }
  };
  copyRecursive(ARTIFACTS_DIR, STORE_DIR);
}

async function main() {
  console.log('START hashes', START_HASHES);
  console.log('EVIDENCE_STORE', STORE_DIR);
  fs.writeFileSync(path.join(ARTIFACTS_DIR, 'PROVENANCE-START.md'), [
    '# PROVENANCE START',
    '',
    `- at: ${startedAt.toISOString()}`,
    `- HEAD: ${START_HASHES.head}`,
    `- dirty: ${START_HASHES.dirty ? START_HASHES.dirty : '(clean)'}`,
    `- baseUrl: ${BASE_URL}`,
    '',
    '## source sha256',
    ...Object.entries(START_HASHES).filter(([k]) => k.includes('/')).map(([k, v]) => `- ${k}: ${v}`),
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(ARTIFACTS_DIR, 'SOURCE-HASHES-FIXED.txt'), [
    `head=${START_HASHES.head}`,
    `dirty=${START_HASHES.dirty}`,
    ...Object.entries(START_HASHES).filter(([k]) => k.includes('/')).map(([k, v]) => `${k}=${v}`),
    '',
  ].join('\n'));

  await captureServedHashes();
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
    evidenceStore: STORE_DIR,
    startHashes: START_HASHES,
    endHashes: END_HASHES,
    hashesUnchangedDuringRun: JSON.stringify(START_HASHES) === JSON.stringify(END_HASHES),
    fatalError,
    results,
  };
  fs.writeFileSync(path.join(ARTIFACTS_DIR, 'INTEGRATION-QA-RESULTS.json'), JSON.stringify(summary, null, 2));
  fs.writeFileSync(path.join(ARTIFACTS_DIR, 'PROVENANCE-END.md'), [
    '# PROVENANCE END',
    '',
    `- at: ${summary.finishedAt}`,
    `- HEAD: ${END_HASHES.head}`,
    `- dirty: ${END_HASHES.dirty ? END_HASHES.dirty : '(clean)'}`,
    `- hashesUnchangedDuringRun: ${summary.hashesUnchangedDuringRun}`,
    '',
  ].join('\n'));
  const md = [
    '# Integration QA results',
    '',
    `- finished: ${summary.finishedAt}`,
    `- HEAD: ${END_HASHES.head}`,
    `- dirty: ${END_HASHES.dirty ? 'YES' : 'clean'}`,
    `- hashes unchanged during run: ${summary.hashesUnchangedDuringRun}`,
    `- evidence store: ${STORE_DIR}`,
    '',
    '| id | status | message |',
    '|---|---|---|',
    ...results.map((r) => `| ${r.id} | ${r.status} | ${(r.message || '').replace(/\|/g, '\\|').slice(0, 180)} |`),
  ].join('\n');
  fs.writeFileSync(path.join(ARTIFACTS_DIR, 'INTEGRATION-QA-RESULTS.md'), md);
  mirrorEvidenceToStore();
  console.log(md);
  if (fatalError || results.some((r) => r.status === 'observed FAIL')) process.exit(1);
}

main();
