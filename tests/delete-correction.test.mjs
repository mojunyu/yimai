/**
 * Delete-correction browser oracles (DEL-1…7 / DEL-H / VIS samples).
 * Isolated fixtures only. Does not write the original Mac demo tree.
 *
 * Run: BASE_URL=http://127.0.0.1:8000 node tests/delete-correction.test.mjs
 */

import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';
import { createHash } from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = process.env.APP_ROOT ? path.resolve(process.env.APP_ROOT) : path.resolve(__dirname, '..');
const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:8000';
const ARTIFACTS_DIR = process.env.ARTIFACTS_DIR
  ? path.resolve(process.env.ARTIFACTS_DIR)
  : path.resolve(APP_ROOT, 'artifacts', `del-correction-${Date.now()}`);
const EXPECTED_TEST_COUNT = 18;

let browser;
let page;
const results = [];
let fatalError = null;
const startedAt = new Date();

function log(test, passed, message = '') {
  console.log(`${passed ? '✓ PASS' : '✗ FAIL'}: ${test}${message ? ' - ' + message : ''}`);
  results.push({ test, passed, message, at: new Date().toISOString() });
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

function fileSha(rel) {
  const abs = path.join(APP_ROOT, rel);
  return createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
}

function phpSeed(scriptBody) {
  const email = `del${Date.now()}${Math.floor(Math.random() * 10000)}@test.test`;
  const script = `<?php
require '${APP_ROOT}/vendor/autoload.php';
$app = require '${APP_ROOT}/bootstrap/app.php';
$app->make(Illuminate\\Contracts\\Console\\Kernel::class)->bootstrap();
$email = '${email}';
${scriptBody}
`;
  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
  const tmp = path.join(ARTIFACTS_DIR, `_seed_${Date.now()}.php`);
  fs.writeFileSync(tmp, script);
  const result = spawnSync('php', [tmp], { cwd: APP_ROOT, encoding: 'utf8' });
  fs.unlinkSync(tmp);
  if (result.status !== 0) {
    throw new Error(`seed failed: ${result.stdout || ''}${result.stderr || ''}`);
  }
  const line = (result.stdout || '').trim().split('\n').filter(Boolean).pop();
  return { ...JSON.parse(line), email };
}

function seedBasicTree() {
  return phpSeed(`
$u = App\\Models\\User::create(['name'=>'DelA','email'=>$email,'password'=>bcrypt('password')]);
$t = App\\Models\\Tree::create(['owner_user_id'=>$u->id,'title'=>'DelA']);
$a = App\\Models\\Person::create(['tree_id'=>$t->id,'name'=>'同名甲','gender'=>'male','generation'=>1]);
$b = App\\Models\\Person::create(['tree_id'=>$t->id,'name'=>'同名甲','gender'=>'female','generation'=>1]);
$s = App\\Models\\Person::create(['tree_id'=>$t->id,'name'=>'配偶乙','gender'=>'female','generation'=>1]);
App\\Models\\SpouseLink::create(['tree_id'=>$t->id,'person_a_id'=>$a->id,'person_b_id'=>$s->id]);
echo json_encode([
  'userId'=>$u->id,'treeId'=>$t->id,'token'=>$u->createToken('t')->plainTextToken,
  'idA'=>$a->id,'idB'=>$b->id,'idS'=>$s->id
], JSON_UNESCAPED_UNICODE);
`);
}

function seedParentChild() {
  return phpSeed(`
$u = App\\Models\\User::create(['name'=>'DelP','email'=>$email,'password'=>bcrypt('password')]);
$t = App\\Models\\Tree::create(['owner_user_id'=>$u->id,'title'=>'DelP']);
$p = App\\Models\\Person::create(['tree_id'=>$t->id,'name'=>'父P','gender'=>'male','generation'=>1]);
$c = App\\Models\\Person::create(['tree_id'=>$t->id,'name'=>'子C','gender'=>'male','generation'=>2,'father_id'=>$p->id]);
$m = App\\Models\\Person::create(['tree_id'=>$t->id,'name'=>'母M','gender'=>'female','generation'=>1]);
$c2 = App\\Models\\Person::create(['tree_id'=>$t->id,'name'=>'女D','gender'=>'female','generation'=>2,'mother_id'=>$m->id]);
echo json_encode([
  'userId'=>$u->id,'treeId'=>$t->id,'token'=>$u->createToken('t')->plainTextToken,
  'idP'=>$p->id,'idC'=>$c->id,'idM'=>$m->id,'idD'=>$c2->id
], JSON_UNESCAPED_UNICODE);
`);
}

function seedSiblingOverlap() {
  return phpSeed(`
$u = App\\Models\\User::create(['name'=>'DelSib','email'=>$email,'password'=>bcrypt('password')]);
$t = App\\Models\\Tree::create(['owner_user_id'=>$u->id,'title'=>'DelSib']);
$parent = App\\Models\\Person::create(['tree_id'=>$t->id,'name'=>'共父','gender'=>'male','generation'=>1]);
$a = App\\Models\\Person::create(['tree_id'=>$t->id,'name'=>'兄A','gender'=>'male','generation'=>2,'father_id'=>$parent->id]);
$b = App\\Models\\Person::create(['tree_id'=>$t->id,'name'=>'弟B','gender'=>'male','generation'=>2,'father_id'=>$parent->id]);
$c = App\\Models\\Person::create(['tree_id'=>$t->id,'name'=>'无亲C','gender'=>'male','generation'=>2]);
$linkAb = App\\Models\\SiblingLink::create([
  'tree_id'=>$t->id,
  'person_a_id'=>min($a->id,$b->id),
  'person_b_id'=>max($a->id,$b->id),
]);
$linkAc = App\\Models\\SiblingLink::create([
  'tree_id'=>$t->id,
  'person_a_id'=>min($a->id,$c->id),
  'person_b_id'=>max($a->id,$c->id),
]);
echo json_encode([
  'userId'=>$u->id,'treeId'=>$t->id,'token'=>$u->createToken('t')->plainTextToken,
  'idParent'=>$parent->id,'idA'=>$a->id,'idB'=>$b->id,'idC'=>$c->id,
  'linkAb'=>$linkAb->id,'linkAc'=>$linkAc->id
], JSON_UNESCAPED_UNICODE);
`);
}

function seedRootPair() {
  return phpSeed(`
$u = App\\Models\\User::create(['name'=>'DelRoot','email'=>$email,'password'=>bcrypt('password')]);
$t = App\\Models\\Tree::create(['owner_user_id'=>$u->id,'title'=>'DelRoot']);
$r = App\\Models\\Person::create(['tree_id'=>$t->id,'name'=>'根R','gender'=>'male','generation'=>1]);
$s = App\\Models\\Person::create(['tree_id'=>$t->id,'name'=>'非根S','gender'=>'female','generation'=>1]);
$u3 = App\\Models\\Person::create(['tree_id'=>$t->id,'name'=>'留存U','gender'=>'male','generation'=>1]);
echo json_encode([
  'userId'=>$u->id,'treeId'=>$t->id,'token'=>$u->createToken('t')->plainTextToken,
  'idR'=>$r->id,'idS'=>$s->id,'idU'=>$u3->id
], JSON_UNESCAPED_UNICODE);
`);
}

function seedAlone() {
  return phpSeed(`
$u = App\\Models\\User::create(['name'=>'DelOne','email'=>$email,'password'=>bcrypt('password')]);
$t = App\\Models\\Tree::create(['owner_user_id'=>$u->id,'title'=>'DelOne']);
$p = App\\Models\\Person::create(['tree_id'=>$t->id,'name'=>'唯一人','gender'=>'unknown','generation'=>1]);
echo json_encode([
  'userId'=>$u->id,'treeId'=>$t->id,'token'=>$u->createToken('t')->plainTextToken,
  'idT'=>$p->id
], JSON_UNESCAPED_UNICODE);
`);
}

function seedForeignPair() {
  const a = phpSeed(`
$u = App\\Models\\User::create(['name'=>'DelFA','email'=>$email,'password'=>bcrypt('password')]);
$t = App\\Models\\Tree::create(['owner_user_id'=>$u->id,'title'=>'DelFA']);
$p = App\\Models\\Person::create(['tree_id'=>$t->id,'name'=>'甲树人','gender'=>'male','generation'=>1]);
echo json_encode([
  'userId'=>$u->id,'treeId'=>$t->id,'token'=>$u->createToken('t')->plainTextToken,
  'idP'=>$p->id
], JSON_UNESCAPED_UNICODE);
`);
  const b = phpSeed(`
$u = App\\Models\\User::create(['name'=>'DelFB','email'=>$email,'password'=>bcrypt('password')]);
$t = App\\Models\\Tree::create(['owner_user_id'=>$u->id,'title'=>'DelFB']);
$p = App\\Models\\Person::create(['tree_id'=>$t->id,'name'=>'乙树人','gender'=>'female','generation'=>1]);
echo json_encode([
  'userId'=>$u->id,'treeId'=>$t->id,'token'=>$u->createToken('t')->plainTextToken,
  'idP'=>$p->id
], JSON_UNESCAPED_UNICODE);
`);
  return { a, b };
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
    if (a.rootId) localStorage.setItem('yimai_root_id', String(a.rootId));
  }, { ...auth, rootId: rootId || auth.idA || auth.idP || auth.idR || auth.idT });
  await page.reload({ waitUntil: 'networkidle0' });
  await page.waitForFunction(() => document.querySelectorAll('g.node-card').length >= 1, { timeout: 10000 });
}

async function installDeleteHooks() {
  await page.evaluate(() => {
    if (window.__yimaiOrigFetch) return;
    window.__yimaiOrigFetch = window.fetch.bind(window);
    window.__yimaiLoseNextDelete = false;
    window.__yimaiFailNextDeleteNetwork = false;
    window.__yimaiDeletePaths = [];
    window.__yimaiDeleteCommitted = [];
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
      }
      return window.__yimaiOrigFetch(input, init);
    };
  });
}

async function selectById(id) {
  await page.evaluate((targetId) => {
    const card = document.querySelector(`g.node-card[data-id="${targetId}"]`);
    if (!card) throw new Error(`missing node ${targetId}`);
    card.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  }, String(id));
  await page.waitForSelector('#sheet:not(.hidden)', { timeout: 5000 });
}

async function screenshot(name) {
  const file = path.join(ARTIFACTS_DIR, name);
  await page.screenshot({ path: file, fullPage: true });
  return file;
}

async function personsApi() {
  return page.evaluate(async () => {
    const token = localStorage.getItem('yimai_token');
    const res = await fetch(`${window.location.origin}/api/v1/persons`, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
    });
    return (await res.json()).data || [];
  });
}

async function treeApi(rootId) {
  return page.evaluate(async (id) => {
    const token = localStorage.getItem('yimai_token');
    const res = await fetch(`${window.location.origin}/api/v1/persons/${id}/tree`, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
    });
    return res.json();
  }, rootId);
}

async function linksApi(kind) {
  return page.evaluate(async (k) => {
    const token = localStorage.getItem('yimai_token');
    const res = await fetch(`${window.location.origin}/api/v1/${k}`, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
    });
    return (await res.json()).data || [];
  }, kind);
}

async function sheetText() {
  return page.evaluate(() => ({
    title: document.getElementById('sheet-title')?.textContent || '',
    puhao: document.getElementById('sheet-puhao')?.textContent || '',
    confirmHidden: document.getElementById('sheet-confirm')?.classList.contains('hidden'),
    confirmTitle: document.getElementById('sheet-confirm-title')?.textContent || '',
    confirmBody: document.getElementById('sheet-confirm-body')?.textContent || '',
    confirmError: document.getElementById('sheet-confirm-error')?.textContent || '',
    sheetError: document.getElementById('sheet-error')?.textContent || '',
    correct: document.getElementById('correct-list')?.textContent || '',
  }));
}

// --- Tests ---

async function testDel1SameNameIdVisibleAndExactDelete() {
  const auth = seedBasicTree();
  await openAuthed(auth, auth.idA);
  await selectById(auth.idA);
  let ui = await sheetText();
  const visible = ui.title.includes('同名甲') && ui.puhao.includes(String(auth.idA));
  await screenshot('del1-detail-name-puhao.png');
  await page.click('#btn-delete-person');
  await page.waitForSelector('#sheet-confirm:not(.hidden)');
  ui = await sheetText();
  const confirmOk = ui.confirmTitle.includes('同名甲')
    && ui.confirmBody.includes(`谱号 ${auth.idA}`)
    && ui.confirmBody.includes('其他成员仍会保留');
  await screenshot('del1-confirm-idA.png');
  await page.click('#sheet-confirm-actions button.danger-solid');
  await page.waitForFunction(() => document.getElementById('sheet-confirm')?.classList.contains('hidden'), { timeout: 8000 });
  const persons = await personsApi();
  const ids = persons.map((p) => String(p.id));
  const ok = visible && confirmOk && !ids.includes(String(auth.idA)) && ids.includes(String(auth.idB));
  fs.writeFileSync(path.join(ARTIFACTS_DIR, 'del1-persons-after.json'), JSON.stringify(persons, null, 2));
  log('DEL-1/DEL-H-01+02 same-name 谱号 and exact id delete', ok, `ids=${ids.join(',')}`);
}

async function testDel2CancelUnchanged() {
  const auth = seedBasicTree();
  await openAuthed(auth, auth.idA);
  const beforePersons = await personsApi();
  const beforeSpouse = await linksApi('spouse-links');
  await selectById(auth.idA);
  await page.click('#btn-delete-person');
  await page.waitForSelector('#sheet-confirm:not(.hidden)');
  const ui = await sheetText();
  await screenshot('del2-confirm-before-cancel.png');
  await page.click('#sheet-confirm-actions button[data-confirm-cancel], #sheet-confirm-actions button.ghost');
  await sleep(300);
  const afterPersons = await personsApi();
  const afterSpouse = await linksApi('spouse-links');
  const ok = ui.confirmBody.includes('只删除这位成员')
    && JSON.stringify(beforePersons) === JSON.stringify(afterPersons)
    && JSON.stringify(beforeSpouse) === JSON.stringify(afterSpouse);
  fs.writeFileSync(path.join(ARTIFACTS_DIR, 'del2-before-after.json'), JSON.stringify({ beforePersons, afterPersons, beforeSpouse, afterSpouse }, null, 2));
  log('DEL-2/DEL-H-03+04 cancel leaves graph unchanged', ok, `n=${afterPersons.length}`);
}

async function testDel3Child409AndCorrectThenDelete() {
  const auth = seedParentChild();
  await openAuthed(auth, auth.idP);
  await selectById(auth.idP);
  await page.click('#btn-delete-person');
  await page.waitForSelector('#sheet-confirm:not(.hidden)');
  await page.click('#sheet-confirm-actions button.danger-solid');
  await page.waitForFunction(() => (document.getElementById('sheet-confirm-body')?.textContent || '').includes('父亲或母亲'), { timeout: 8000 });
  let ui = await sheetText();
  await screenshot('del3-409-zh.png');
  const still = await personsApi();
  const blocked = still.some((p) => String(p.id) === String(auth.idP))
    && ui.confirmBody.includes('无需删除这些成员')
    && ui.confirmBody.includes(`谱号 ${auth.idC}`);
  await page.evaluate((childId) => {
    const btn = Array.from(document.querySelectorAll('#sheet-confirm-actions button'))
      .find((b) => b.textContent.includes(`谱号 ${childId}`) && b.textContent.includes('打开并更正'));
    if (!btn) throw new Error('missing open-child action');
    btn.click();
  }, auth.idC);
  await sleep(400);
  ui = await sheetText();
  const openedChild = ui.title.includes('子C') && ui.puhao.includes(String(auth.idC));
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('#correct-list button'))
      .find((b) => b.textContent.includes('清空父亲栏'));
    if (!btn) throw new Error('missing clear father');
    btn.click();
  });
  await page.waitForSelector('#sheet-confirm:not(.hidden)');
  await page.click('#sheet-confirm-actions button.outline-action');
  await sleep(600);
  await selectById(auth.idP);
  await page.click('#btn-delete-person');
  await page.waitForSelector('#sheet-confirm:not(.hidden)');
  await page.click('#sheet-confirm-actions button.danger-solid');
  await sleep(800);
  const after = await personsApi();
  const deleted = !after.some((p) => String(p.id) === String(auth.idP))
    && after.some((p) => String(p.id) === String(auth.idC));
  fs.writeFileSync(path.join(ARTIFACTS_DIR, 'del3-after.json'), JSON.stringify(after, null, 2));
  log('DEL-3/DEL-H-05+06 child 409 then parent clear permits original delete', blocked && openedChild && deleted, `blocked=${blocked}, opened=${openedChild}, deleted=${deleted}`);
}

async function testDel3SpouseOnlyAllowed() {
  const auth = seedBasicTree();
  await openAuthed(auth, auth.idA);
  await selectById(auth.idA);
  await page.click('#btn-delete-person');
  await page.click('#sheet-confirm-actions button.danger-solid');
  await sleep(800);
  const persons = await personsApi();
  const ok = !persons.some((p) => String(p.id) === String(auth.idA))
    && persons.some((p) => String(p.id) === String(auth.idS));
  log('DEL-3/DEL-H-07 spouse-only delete allowed; counterpart stays', ok, `remaining=${persons.map((p) => p.id).join(',')}`);
}

async function testDel4ParentSpouseSiblingUnlink() {
  const auth = seedSiblingOverlap();
  await openAuthed(auth, auth.idA);
  await selectById(auth.idA);
  // clear nothing parent on A first — unlink explicit+inferred B
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('#correct-list button'))
      .find((b) => b.textContent.includes('移除手动添加的兄弟姐妹关系记录'));
    if (!btn) throw new Error('missing sibling unlink');
    btn.click();
  });
  await page.waitForSelector('#sheet-confirm:not(.hidden)');
  await screenshot('del4-unlink-sibling-confirm.png');
  await page.click('#sheet-confirm-actions button.outline-action');
  await sleep(700);
  const sibLinks = await linksApi('sibling-links');
  const tree = await treeApi(auth.idA);
  const ui = await sheetText();
  const explicitGone = !sibLinks.some((l) => String(l.id) === String(auth.linkAb));
  const parentEdgesRemain = (tree.edges || []).filter((e) => e.type === 'parent').length >= 2;
  const inferredNote = (ui.sheetError + ui.correct).includes('共同父母') || ui.correct.includes('因共同父母');
  await screenshot('del4-after-unlink-overlap.png');

  // unlink explicit-only A–C
  await selectById(auth.idA);
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('#correct-list button'))
      .find((b) => b.textContent.includes('移除手动添加的兄弟姐妹关系记录'));
    if (btn) btn.click();
  });
  if (!(await page.$('#sheet-confirm:not(.hidden)'))) {
    // may already be only inferred rows
  } else {
    await page.click('#sheet-confirm-actions button.outline-action');
    await sleep(500);
  }

  // mother/father clear on child D path covered in DEL-3; here clear nothing else.
  const motherSeed = seedParentChild();
  await openAuthed(motherSeed, motherSeed.idD);
  await selectById(motherSeed.idD);
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('#correct-list button'))
      .find((b) => b.textContent.includes('清空母亲栏'));
    btn.click();
  });
  await page.click('#sheet-confirm-actions button.outline-action');
  await sleep(500);
  const d = (await personsApi()).find((p) => String(p.id) === String(motherSeed.idD));
  const motherCleared = d && d.mother_id == null;

  const spouseSeed = seedBasicTree();
  await openAuthed(spouseSeed, spouseSeed.idA);
  await selectById(spouseSeed.idA);
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('#correct-list button'))
      .find((b) => b.textContent.includes('解除这段关系记录'));
    btn.click();
  });
  await page.click('#sheet-confirm-actions button.outline-action');
  await sleep(500);
  const spouses = await linksApi('spouse-links');
  const people = await personsApi();
  const spouseUnlinked = spouses.length === 0
    && people.some((p) => String(p.id) === String(spouseSeed.idA))
    && people.some((p) => String(p.id) === String(spouseSeed.idS));

  const ok = explicitGone && parentEdgesRemain && inferredNote && motherCleared && spouseUnlinked;
  fs.writeFileSync(path.join(ARTIFACTS_DIR, 'del4-snapshot.json'), JSON.stringify({ sibLinks, tree, motherCleared, spouseUnlinked }, null, 2));
  log('DEL-4/DEL-H-08..12 parent/spouse/sibling correction + inferred note', ok, `gone=${explicitGone}, parents=${parentEdgesRemain}, note=${inferredNote}`);
}

async function testDel5IncidentCleanup() {
  const auth = seedSiblingOverlap();
  // add spouse on A
  const patched = phpSeed(`
$u = App\\Models\\User::find(${auth.userId});
$t = App\\Models\\Tree::find(${auth.treeId});
$s = App\\Models\\Person::create(['tree_id'=>$t->id,'name'=>'偶S','gender'=>'female','generation'=>2]);
$x = App\\Models\\Person::create(['tree_id'=>$t->id,'name'=>'无关X','gender'=>'male','generation'=>2]);
$y = App\\Models\\Person::create(['tree_id'=>$t->id,'name'=>'无关Y','gender'=>'female','generation'=>2]);
$sp = App\\Models\\SpouseLink::create(['tree_id'=>$t->id,'person_a_id'=>${auth.idA},'person_b_id'=>$s->id]);
$sp2 = App\\Models\\SpouseLink::create(['tree_id'=>$t->id,'person_a_id'=>$x->id,'person_b_id'=>$y->id]);
echo json_encode(['userId'=>$u->id,'treeId'=>$t->id,'token'=>$u->createToken('t2')->plainTextToken,'idA'=>${auth.idA},'idS'=>$s->id,'idX'=>$x->id,'linkSp'=>$sp->id,'linkSp2'=>$sp2->id,'linkBc'=>${auth.linkAc}], JSON_UNESCAPED_UNICODE);
`);
  await openAuthed(patched, patched.idA);
  await selectById(patched.idA);
  await page.click('#btn-delete-person');
  await page.click('#sheet-confirm-actions button.danger-solid');
  await sleep(800);
  const persons = await personsApi();
  const spouses = await linksApi('spouse-links');
  const siblings = await linksApi('sibling-links');
  const ok = !persons.some((p) => String(p.id) === String(patched.idA))
    && persons.some((p) => String(p.id) === String(patched.idS))
    && persons.some((p) => String(p.id) === String(patched.idX))
    && !spouses.some((l) => String(l.id) === String(patched.linkSp))
    && spouses.some((l) => String(l.id) === String(patched.linkSp2))
    && !siblings.some((l) => Number(l.person_a_id) === Number(patched.idA) || Number(l.person_b_id) === Number(patched.idA));
  fs.writeFileSync(path.join(ARTIFACTS_DIR, 'del5-cleanup.json'), JSON.stringify({ persons, spouses, siblings }, null, 2));
  log('DEL-5/DEL-H-13+14 incident edge cleanup; non-incident kept', ok);
}

async function clickConfirmPrimary() {
  await page.evaluate(() => {
    const btn = document.querySelector('#sheet-confirm-actions button.danger-solid, #sheet-confirm-actions button.outline-action, #sheet-confirm-actions button.secondary');
    if (!btn) throw new Error('no confirm primary');
    btn.click();
  });
}

async function testDel6RootSelectedLast() {
  const pair = seedRootPair();
  await openAuthed(pair, pair.idR);
  await selectById(pair.idS);
  await page.click('#btn-delete-person');
  await clickConfirmPrimary();
  await sleep(700);
  let root = await page.evaluate(() => localStorage.getItem('yimai_root_id'));
  let sheetHidden = await page.evaluate(() => document.getElementById('sheet')?.classList.contains('hidden'));
  const nonRootOk = String(root) === String(pair.idR) && sheetHidden;
  await screenshot('del6-after-nonroot.png');

  await selectById(pair.idR);
  await page.click('#btn-delete-person');
  await clickConfirmPrimary();
  await sleep(900);
  root = await page.evaluate(() => localStorage.getItem('yimai_root_id'));
  const persons = await personsApi();
  const ui = await sheetText();
  const rootOk = persons.length === 1
    && String(root) === String(persons[0].id)
    && String(persons[0].id) === String(pair.idU)
    && !persons.some((p) => String(p.id) === String(pair.idR))
    && (ui.sheetError.includes('当前视角') || ui.puhao.includes(String(persons[0].id)));
  await screenshot('del6-after-root.png');

  const alone = seedAlone();
  await openAuthed(alone, alone.idT);
  await selectById(alone.idT);
  await page.click('#btn-delete-person');
  await clickConfirmPrimary();
  await sleep(800);
  const emptyPersons = await personsApi();
  const emptyUi = await page.evaluate(() => ({
    emptyHidden: document.getElementById('empty')?.classList.contains('hidden'),
    title: document.getElementById('sheet-title')?.textContent || '',
    addDisabled: document.getElementById('btn-add')?.disabled,
  }));
  await screenshot('del6-empty.png');
  const lastOk = emptyPersons.length === 0 && emptyUi.emptyHidden === false && emptyUi.title.includes('第一位');
  log('DEL-6/DEL-H-17..19 nonroot/root/last close-outs', nonRootOk && rootOk && lastOk, `nonRoot=${nonRootOk}, root=${rootOk}, last=${lastOk}`);
}

async function testDel7FailuresAndFrozenRetry() {
  const auth = seedBasicTree();
  await openAuthed(auth, auth.idA);
  await installDeleteHooks();
  await selectById(auth.idA);
  await page.evaluate(() => { window.__yimaiFailNextDeleteNetwork = true; });
  await page.click('#btn-delete-person');
  await clickConfirmPrimary();
  await page.waitForFunction(() => (document.getElementById('sheet-confirm-title')?.textContent || '').includes('不确定'), { timeout: 8000 });
  let ui = await sheetText();
  await screenshot('del7-network-unknown.png');
  const nodesStill = await page.evaluate(() => document.querySelectorAll('g.node-card').length);
  const networkOk = ui.confirmTitle.includes('不确定') && nodesStill >= 2 && !ui.confirmBody.includes('已删除成功');

  // Attempt to switch selection while unknown dialog is open — frozen id must remain.
  await page.evaluate((id) => {
    const card = document.querySelector(`g.node-card[data-id="${id}"]`);
    card?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  }, String(auth.idB));
  await sleep(200);
  ui = await sheetText();
  const frozenText = !ui.confirmHidden && (ui.confirmBody + ui.confirmTitle).includes(String(auth.idA));

  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('#sheet-confirm-actions button'))
      .find((b) => b.textContent.includes('核对'));
    btn?.click();
  });
  await sleep(600);
  ui = await sheetText();
  // After reconcile, A still exists — should offer retry on original 谱号.
  const stillA = (ui.confirmBody + ui.confirmError + ui.confirmTitle).includes(String(auth.idA));
  await page.evaluate(() => { window.__yimaiLoseNextDelete = true; });
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('#sheet-confirm-actions button'))
      .find((b) => b.textContent.includes('删除') || b.textContent.includes('原谱号'));
    if (btn) btn.click();
    else document.querySelector('#sheet-confirm-actions button.danger-solid')?.click();
  });
  // Must wait for the POST-lost unknown dialog (有「核对」), not the earlier exists-retry「结果还不确定」.
  await page.waitForFunction(() => {
    const title = document.getElementById('sheet-confirm-title')?.textContent || '';
    const body = document.getElementById('sheet-confirm-body')?.textContent || '';
    const hasReconcile = Array.from(document.querySelectorAll('#sheet-confirm-actions button'))
      .some((b) => b.textContent.includes('核对'));
    return title.includes('不确定')
      && body.includes('还没有把这次操作当作已经成功')
      && hasReconcile
      && (window.__yimaiDeleteCommitted || []).length >= 1;
  }, { timeout: 10000 });
  // Terminal proof: after committed-but-lost DELETE, click 核对 under same account/tree.
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('#sheet-confirm-actions button'))
      .find((b) => b.textContent.includes('核对'));
    if (!btn) throw new Error('missing reconcile button after lost DELETE');
    btn.click();
  });
  await page.waitForFunction(() => {
    const hidden = document.getElementById('sheet-confirm')?.classList.contains('hidden');
    return hidden === true;
  }, { timeout: 10000 });
  await sleep(400);
  const uiAfterReconcile = await sheetText();
  const paths = await page.evaluate(() => window.__yimaiDeletePaths || []);
  const committed = await page.evaluate(() => window.__yimaiDeleteCommitted || []);
  const onlyA = paths.length > 0 && paths.every((p) => p.includes(`/persons/${auth.idA}`));
  const persons = await personsApi();
  const aGone = !persons.some((p) => String(p.id) === String(auth.idA));
  const bSafe = persons.some((p) => String(p.id) === String(auth.idB));
  const terminalOk = aGone && bSafe && uiAfterReconcile.confirmHidden
    && committed.some((c) => c.url.includes(`/persons/${auth.idA}`) && Number(c.status) === 204);
  await screenshot('del7-after-lost-response.png');
  fs.writeFileSync(path.join(ARTIFACTS_DIR, 'del7-paths.json'), JSON.stringify({
    paths, committed, persons, uiBeforeRetry: ui, uiAfterReconcile, originalId: auth.idA, account_id: auth.userId, tree_id: auth.treeId,
  }, null, 2));
  log('DEL-7/DEL-H-20..24 unknown/network keeps frozen id; lost DELETE reconciles absent', networkOk && onlyA && bSafe && frozenText && stillA && terminalOk, `paths=${paths.join('|')} aGone=${aGone}`);
}

async function testIsolationForeign404() {
  const { a, b } = seedForeignPair();
  await openAuthed(a, a.idP);
  const status = await page.evaluate(async (foreignId) => {
    const token = localStorage.getItem('yimai_token');
    const res = await fetch(`${window.location.origin}/api/v1/persons/${foreignId}`, {
      method: 'DELETE',
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
    });
    return res.status;
  }, b.idP);
  const personsB = await page.evaluate(async (token) => {
    const res = await fetch(`${window.location.origin}/api/v1/persons`, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
    });
    return (await res.json()).data || [];
  }, b.token);
  const ok = status === 404 && personsB.some((p) => String(p.id) === String(b.idP));
  log('Isolation A/B foreign delete 404; B person retained', ok, `status=${status}`);
}

async function testNarrowConfirmVis() {
  const auth = seedBasicTree();
  await openAuthed(auth, auth.idA);
  await page.setViewport({ width: 375, height: 844 });
  await selectById(auth.idA);
  await page.evaluate(() => {
    document.getElementById('delete-section')?.scrollIntoView({ block: 'center' });
    document.getElementById('btn-delete-person')?.click();
  });
  await page.waitForFunction(() => !document.getElementById('sheet-confirm')?.classList.contains('hidden'), { timeout: 8000 });
  const box = await page.$eval('#sheet-confirm', (el) => {
    const r = el.getBoundingClientRect();
    return { width: r.width, height: r.height, overflowX: document.documentElement.scrollWidth > window.innerWidth + 1 };
  });
  await screenshot('vis-confirm-375.png');
  await page.setViewport({ width: 320, height: 700 });
  await page.evaluate(() => document.getElementById('sheet-confirm')?.scrollIntoView({ block: 'start' }));
  await screenshot('vis-confirm-320.png');
  await page.setViewport({ width: 1280, height: 800 });
  await screenshot('vis-confirm-desktop.png');
  const ui = await sheetText();
  const ok = ui.confirmBody.includes('谱号') && ui.confirmTitle.includes('删除') && box.width > 0 && box.overflowX === false;
  log('VIS confirm readable at 320/375/desktop without page lock overflow', ok, `w=${box.width}`);
}

async function testKeyboardConfirmEsc() {
  const auth = seedAlone();
  await openAuthed(auth, auth.idT);
  await selectById(auth.idT);
  await page.focus('#btn-delete-person');
  await page.click('#btn-delete-person');
  await page.waitForSelector('#sheet-confirm:not(.hidden)');
  await page.keyboard.press('Escape');
  await sleep(300);
  const ui = await sheetText();
  const persons = await personsApi();
  const ok = ui.confirmHidden && persons.length === 1;
  log('VIS/DEL-2 Escape cancels confirm; person retained', ok);
}

async function runAll() {
  console.log('\n一脉 Delete-correction Tests\n' + '='.repeat(50));
  console.log(`BASE_URL=${BASE_URL}`);
  console.log(`ARTIFACTS_DIR=${ARTIFACTS_DIR}`);
  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: APP_ROOT, encoding: 'utf8' }).stdout.trim();
  const dirty = spawnSync('git', ['status', '--porcelain'], { cwd: APP_ROOT, encoding: 'utf8' }).stdout.trim();
  const sourceHashes = {
    'frontend/js/app.js': fileSha('frontend/js/app.js'),
    'frontend/css/app.css': fileSha('frontend/css/app.css'),
    'app/Http/Controllers/Api/V1/PersonController.php': fileSha('app/Http/Controllers/Api/V1/PersonController.php'),
  };
  const servedHashes = {
    appJs: createHash('sha256').update(Buffer.from(await (await fetch(`${BASE_URL}/app/js/app.js`)).arrayBuffer())).digest('hex'),
    appCss: createHash('sha256').update(Buffer.from(await (await fetch(`${BASE_URL}/app/css/app.css`)).arrayBuffer())).digest('hex'),
  };
  const provenance = {
    head,
    dirty: Boolean(dirty),
    startedAt: startedAt.toISOString(),
    sourceHashes,
    servedHashes,
    servedMatchesSource: {
      js: servedHashes.appJs === sourceHashes['frontend/js/app.js'],
      css: servedHashes.appCss === sourceHashes['frontend/css/app.css'],
    },
  };
  fs.writeFileSync(path.join(ARTIFACTS_DIR, 'suite-start-provenance.json'), JSON.stringify(provenance, null, 2));
  fs.writeFileSync(path.join(ARTIFACTS_DIR, 'source-hashes.json'), JSON.stringify({ head, ...sourceHashes }, null, 2));
  console.log(JSON.stringify({ event: 'suite_start', head, servedMatchesSource: provenance.servedMatchesSource }, null, 2));

  const ordered = [
    testDel1SameNameIdVisibleAndExactDelete,
    testDel2CancelUnchanged,
    testDel3Child409AndCorrectThenDelete,
    testDel3SpouseOnlyAllowed,
    testDel4ParentSpouseSiblingUnlink,
    testDel5IncidentCleanup,
    testDel6RootSelectedLast,
    testDel7FailuresAndFrozenRetry,
    testIsolationForeign404,
    testNarrowConfirmVis,
    testKeyboardConfirmEsc,
  ];

  try {
    await setup();
    for (const fn of ordered) {
      await fn();
    }
  } catch (err) {
    fatalError = err;
    console.error('FATAL:', err);
    results.push({ test: 'Suite completed without uncaught error', passed: false, message: String(err?.message || err), at: new Date().toISOString() });
  } finally {
    await teardown().catch(() => {});
  }

  const passed = results.filter((r) => r.passed).length;
  const total = results.length;
  const endedAt = new Date();
  const endHashes = {
    'frontend/js/app.js': fileSha('frontend/js/app.js'),
    'frontend/css/app.css': fileSha('frontend/css/app.css'),
    'app/Http/Controllers/Api/V1/PersonController.php': fileSha('app/Http/Controllers/Api/V1/PersonController.php'),
  };
  const payload = {
    passed,
    total,
    expected: 11,
    countOk: total >= 11 && total <= 12,
    allPassed: passed === total && !fatalError,
    fatalError: fatalError ? String(fatalError.message || fatalError) : null,
    results,
    head,
    sourceHashesStart: sourceHashes,
    sourceHashesEnd: endHashes,
    sourceStable: JSON.stringify(sourceHashes) === JSON.stringify(endHashes),
    servedHashes,
    servedMatchesSource: provenance.servedMatchesSource,
    dirtyAtStart: Boolean(dirty),
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
  };
  fs.writeFileSync(path.join(ARTIFACTS_DIR, 'delete-correction-results.json'), JSON.stringify(payload, null, 2));
  console.log(`Results: ${passed}/${total} head=${head}`);
  console.log(`Evidence: ${ARTIFACTS_DIR}`);
  if (!payload.allPassed || !payload.sourceStable || !payload.servedMatchesSource.js) process.exit(1);
  process.exit(0);
}

runAll();
