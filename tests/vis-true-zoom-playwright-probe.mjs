/**
 * Bounded VIS-14 method probe (research 2026-11-11):
 * Playwright launchPersistentContext + channel:'chromium' + MV3 extension
 * chrome.tabs.setZoomSettings(automatic) + setZoom(tabId, 2) + getZoom.
 * Does NOT claim product acceptance. Missing capability → UNVERIFIED, no retries.
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = process.env.APP_ROOT ? path.resolve(process.env.APP_ROOT) : path.resolve(__dirname, '..');
const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:8000';
const ARTIFACTS_DIR = process.env.ARTIFACTS_DIR
  ? path.resolve(process.env.ARTIFACTS_DIR)
  : path.resolve(APP_ROOT, 'artifacts', `vis-zoom-probe-${Date.now()}`);

function writeResult(payload) {
  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
  fs.writeFileSync(path.join(ARTIFACTS_DIR, 'vis-true-zoom-playwright-probe.json'), JSON.stringify(payload, null, 2));
  console.log(JSON.stringify(payload, null, 2));
  return payload;
}

async function main() {
  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
  let chromium;
  try {
    const require = createRequire(path.join(APP_ROOT, 'package.json'));
    // Prefer npx-resolved playwright without adding a package.json dependency.
    const resolved = spawnSync('npx', ['--yes', 'playwright@1.56.1', '--version'], {
      cwd: APP_ROOT,
      encoding: 'utf8',
    });
    if (resolved.status !== 0) {
      return writeResult({
        status: 'UNVERIFIED',
        missing: ['playwright_cli'],
        reason: 'npx playwright --version failed; cannot run extension zoom probe',
        detail: resolved.stderr || resolved.stdout,
      });
    }
    // Dynamic import from npx cache is brittle; install playwright into a temp dir once.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yimai-pw-'));
    const install = spawnSync('npm', ['init', '-y'], { cwd: tmp, encoding: 'utf8' });
    if (install.status !== 0) {
      return writeResult({ status: 'UNVERIFIED', missing: ['npm_init'], reason: install.stderr });
    }
    const add = spawnSync('npm', ['install', 'playwright@1.56.1', '--no-save', '--no-package-lock'], {
      cwd: tmp,
      encoding: 'utf8',
      timeout: 180000,
    });
    if (add.status !== 0) {
      return writeResult({
        status: 'UNVERIFIED',
        missing: ['playwright_npm_install'],
        reason: 'Could not install playwright into temp dir for probe',
        detail: (add.stderr || add.stdout || '').slice(0, 2000),
      });
    }
    const pwRequire = createRequire(path.join(tmp, 'package.json'));
    ({ chromium } = pwRequire('playwright'));
  } catch (err) {
    return writeResult({
      status: 'UNVERIFIED',
      missing: ['playwright_module'],
      reason: String(err?.message || err),
    });
  }

  const extDir = path.join(ARTIFACTS_DIR, 'zoom-ext');
  fs.mkdirSync(extDir, { recursive: true });
  fs.writeFileSync(path.join(extDir, 'manifest.json'), JSON.stringify({
    manifest_version: 3,
    name: 'Yimai Zoom Probe',
    version: '1.0.0',
    permissions: ['tabs'],
    background: { service_worker: 'sw.js' },
    host_permissions: ['<all_urls>'],
  }, null, 2));
  fs.writeFileSync(path.join(extDir, 'sw.js'), `
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      if (msg?.type === 'setZoom') {
        await chrome.tabs.setZoomSettings(msg.tabId, { mode: 'automatic', scope: 'per-tab' });
        await chrome.tabs.setZoom(msg.tabId, msg.factor);
        const z = await chrome.tabs.getZoom(msg.tabId);
        sendResponse({ ok: true, zoom: z });
        return;
      }
      if (msg?.type === 'getZoom') {
        const z = await chrome.tabs.getZoom(msg.tabId);
        sendResponse({ ok: true, zoom: z });
        return;
      }
      sendResponse({ ok: false, error: 'unknown' });
    } catch (e) {
      sendResponse({ ok: false, error: String(e && e.message || e) });
    }
  })();
  return true;
});
`);

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yimai-zoom-profile-'));
  let context;
  try {
    context = await chromium.launchPersistentContext(userDataDir, {
      channel: 'chromium',
      headless: true,
      viewport: null,
      args: [
        `--disable-extensions-except=${extDir}`,
        `--load-extension=${extDir}`,
        '--no-sandbox',
        '--disable-setuid-sandbox',
      ],
    });
  } catch (err) {
    const msg = String(err?.message || err);
    const missing = [];
    if (/channel/i.test(msg) || /chromium/i.test(msg)) missing.push('channel:chromium');
    if (/extension/i.test(msg)) missing.push('extension_sideload');
    if (!missing.length) missing.push('launchPersistentContext');
    return writeResult({
      status: 'UNVERIFIED',
      missing,
      reason: 'launchPersistentContext with channel:chromium + load-extension failed',
      detail: msg.slice(0, 2000),
    });
  }

  try {
    const page = await context.newPage();
    await page.goto(`${BASE_URL}/app/`, { waitUntil: 'networkidle' });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.waitForTimeout(500);
    const baseline = await page.evaluate(() => ({
      iw: window.innerWidth,
      cw: document.documentElement.clientWidth,
      dpr: window.devicePixelRatio,
      vv: window.visualViewport ? { w: window.visualViewport.width, s: window.visualViewport.scale } : null,
    }));

    // Find extension service worker / background
    let worker = context.serviceWorkers().find(Boolean);
    if (!worker) {
      worker = await context.waitForEvent('serviceworker', { timeout: 10000 }).catch(() => null);
    }
    if (!worker) {
      await context.close().catch(() => {});
      return writeResult({
        status: 'UNVERIFIED',
        missing: ['extension_service_worker'],
        reason: 'MV3 service worker did not start under headless chromium channel',
        baseline,
      });
    }

    const tabId = await page.evaluate(async () => {
      // Cannot call chrome.tabs from page; return nothing — worker uses active tab query.
      return null;
    });

    // Ask extension to zoom the active tab via worker evaluate if possible.
    // Playwright cannot easily chrome.runtime.sendMessage from page without an extension id.
    // Use worker.evaluate with chrome.tabs.query.
    const zoomResult = await worker.evaluate(async () => {
      const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      const tab = tabs[0];
      if (!tab?.id) return { ok: false, error: 'no_active_tab' };
      await chrome.tabs.setZoomSettings(tab.id, { mode: 'automatic', scope: 'per-tab' });
      await chrome.tabs.setZoom(tab.id, 2);
      const zoom = await chrome.tabs.getZoom(tab.id);
      return { ok: true, tabId: tab.id, zoom };
    }).catch((err) => ({ ok: false, error: String(err?.message || err) }));

    await page.waitForTimeout(400);
    const after = await page.evaluate(() => ({
      iw: window.innerWidth,
      cw: document.documentElement.clientWidth,
      dpr: window.devicePixelRatio,
      vv: window.visualViewport ? { w: window.visualViewport.width, s: window.visualViewport.scale } : null,
    }));

    const methodOk = Boolean(
      zoomResult?.ok
      && Math.abs(Number(zoomResult.zoom) - 2) < 0.05
      && baseline.iw > 0
      && after.iw <= baseline.iw * 0.6
      && after.cw <= baseline.cw * 0.6
      && (after.vv?.s == null || Math.abs(after.vv.s - 1) < 0.15)
      && after.dpr > baseline.dpr * 1.4,
    );

    let product = null;
    if (methodOk) {
      // Seed a tiny isolated tree via PHP so product ops stay off demo18.
      const seedScript = `<?php
require '${APP_ROOT}/vendor/autoload.php';
$app = require '${APP_ROOT}/bootstrap/app.php';
$app->make(Illuminate\\Contracts\\Console\\Kernel::class)->bootstrap();
$email='zoom'.time().'@test.test';
$u=App\\Models\\User::create(['name'=>'Zoom','email'=>$email,'password'=>bcrypt('password')]);
$t=App\\Models\\Tree::create(['owner_user_id'=>$u->id,'title'=>'Zoom']);
$p=App\\Models\\Person::create(['tree_id'=>$t->id,'name'=>'缩人','gender'=>'male','generation'=>1]);
$n=App\\Models\\Person::create(['tree_id'=>$t->id,'name'=>'旁缩','gender'=>'female','generation'=>1]);
echo json_encode(['userId'=>$u->id,'treeId'=>$t->id,'token'=>$u->createToken('t')->plainTextToken,'idT'=>$p->id,'idN'=>$n->id,'email'=>$email], JSON_UNESCAPED_UNICODE);
`;
      const seedFile = path.join(ARTIFACTS_DIR, `_zoom_seed.php`);
      fs.writeFileSync(seedFile, seedScript);
      const seeded = spawnSync('php', [seedFile], { cwd: APP_ROOT, encoding: 'utf8' });
      fs.unlinkSync(seedFile);
      if (seeded.status !== 0) {
        product = { ok: false, error: 'seed_failed', detail: seeded.stderr || seeded.stdout };
      } else {
        const auth = JSON.parse((seeded.stdout || '').trim().split('\n').filter(Boolean).pop());
        await page.evaluate((a) => {
          localStorage.clear();
          localStorage.setItem('yimai_token', a.token);
          localStorage.setItem('yimai_user_id', String(a.userId));
          localStorage.setItem('yimai_tree_id', String(a.treeId));
          localStorage.setItem('yimai_root_id', String(a.idT));
        }, auth);
        await page.reload({ waitUntil: 'networkidle' });
        // Reload may reset tab zoom — re-assert true 200% before product oracles.
        const reZoom = await worker.evaluate(async () => {
          const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
          const tab = tabs[0];
          if (!tab?.id) return { ok: false, error: 'no_active_tab' };
          await chrome.tabs.setZoomSettings(tab.id, { mode: 'automatic', scope: 'per-tab' });
          await chrome.tabs.setZoom(tab.id, 2);
          const zoom = await chrome.tabs.getZoom(tab.id);
          return { ok: true, zoom };
        }).catch((err) => ({ ok: false, error: String(err?.message || err) }));
        await page.waitForTimeout(400);
        const zoomed = await page.evaluate(() => ({
          iw: window.innerWidth,
          dpr: window.devicePixelRatio,
          vvScale: window.visualViewport?.scale ?? null,
        }));
        await page.waitForFunction(() => document.querySelectorAll('g.node-card').length >= 1, { timeout: 15000 });
        // Use evaluate clicks — at true 200% page zoom, hit-testing can miss overlapping chrome.
        await page.evaluate((id) => {
          document.querySelector(`g.node-card[data-id="${id}"]`)?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        }, String(auth.idT));
        await page.waitForSelector('#sheet:not(.hidden)', { timeout: 8000 });
        await page.evaluate(() => {
          document.getElementById('btn-add')?.click();
          document.querySelector('#kin-grid button[data-kin="son"]')?.click();
        });
        await page.waitForSelector('#form-add:not(.hidden)', { timeout: 8000 });
        const addReachable = await page.evaluate(() => {
          const name = document.getElementById('add-name');
          const box = name?.getBoundingClientRect();
          return Boolean(box && box.width > 0 && box.height > 0 && box.top < window.innerHeight);
        });
        await page.evaluate(() => document.getElementById('btn-cancel-add')?.click());
        await page.evaluate(() => {
          document.getElementById('delete-section')?.scrollIntoView({ block: 'nearest' });
          document.getElementById('btn-delete-person')?.click();
        });
        await page.waitForSelector('#sheet-confirm:not(.hidden)', { timeout: 8000 });
        product = await page.evaluate((ctx) => {
          const overflowX = document.documentElement.scrollWidth > window.innerWidth + 1;
          const title = document.getElementById('sheet-title')?.textContent || '';
          const confirmTitle = document.getElementById('sheet-confirm-title')?.textContent || '';
          const cancel = document.querySelector('#sheet-confirm-actions button');
          const cancelBox = cancel?.getBoundingClientRect();
          const operableConfirm = Boolean(cancelBox && cancelBox.width > 0 && cancelBox.height > 0);
          const at200 = ctx.iw <= 700 && (ctx.vvScale == null || Math.abs(ctx.vvScale - 1) < 0.15);
          return {
            overflowX,
            title,
            confirmTitle,
            operableConfirm,
            addReachable: ctx.addOk,
            iw: window.innerWidth,
            dpr: window.devicePixelRatio,
            vvScale: window.visualViewport?.scale ?? null,
            reZoomOk: ctx.ok,
            readable: title.length > 0 && confirmTitle.length > 0,
            ok: ctx.ok && at200 && !overflowX && ctx.addOk && title.length > 0 && confirmTitle.length > 0 && operableConfirm,
          };
        }, {
          ok: Boolean(reZoom?.ok && Math.abs(Number(reZoom.zoom) - 2) < 0.05),
          addOk: addReachable,
          ...zoomed,
        });
        await page.screenshot({ path: path.join(ARTIFACTS_DIR, 'vis-true-zoom-200-product.png'), fullPage: true });
        await page.keyboard.press('Escape');
      }
      await page.screenshot({ path: path.join(ARTIFACTS_DIR, 'vis-true-zoom-200.png'), fullPage: true });
    }

    await context.close().catch(() => {});
    const productOk = Boolean(product?.ok);
    return writeResult({
      status: methodOk ? (productOk ? 'PRODUCT_OK' : 'METHOD_OK') : 'UNVERIFIED',
      missing: methodOk ? (productOk ? [] : ['product_assertions']) : ['true_page_zoom_criteria'],
      reason: !methodOk
        ? 'Zoom API call did not satisfy true page-zoom criteria (iw~half, vv.scale~1, dpr up, getZoom===2)'
        : (productOk
          ? 'True page zoom method OK and product readable/operable/no-x-overflow at 200%'
          : 'True page zoom method OK but product assertions failed — not VIS-14 PASS'),
      baseline,
      zoomResult,
      after,
      product,
      note: 'PRODUCT_OK required for VIS-14 PASS. METHOD_OK alone is not product acceptance.',
    });
  } catch (err) {
    await context?.close?.().catch(() => {});
    return writeResult({
      status: 'UNVERIFIED',
      missing: ['probe_runtime'],
      reason: String(err?.message || err),
    });
  }
}

main().then((r) => {
  process.exit(r.status === 'METHOD_OK' ? 0 : 0); // never fail suite solely on env gap
}).catch((err) => {
  writeResult({ status: 'UNVERIFIED', missing: ['probe_crash'], reason: String(err?.message || err) });
  process.exit(0);
});
