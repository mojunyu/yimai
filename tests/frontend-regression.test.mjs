/**
 * Frontend regression tests for 一脉 (Yimai) family tree app.
 * Tests the fix for commit 71db97f which removed login/loadTree/loadPersons functions.
 * 
 * Run: node tests/frontend-regression.test.mjs
 */
import puppeteer from 'puppeteer';

const BASE_URL = 'http://localhost:8000';
const DEMO_EMAIL = 'demo@yimai.test';
const DEMO_PASSWORD = 'password';

let browser;
let page;
const results = [];

function log(test, passed, message = '') {
  const status = passed ? '✓ PASS' : '✗ FAIL';
  console.log(`${status}: ${test}${message ? ' - ' + message : ''}`);
  results.push({ test, passed, message });
}

async function setup() {
  browser = await puppeteer.launch({
    headless: true,
    executablePath: '/usr/bin/google-chrome-stable',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--disable-dev-shm-usage']
  });
  page = await browser.newPage();
  page.on('console', msg => {
    if (msg.type() === 'error') {
      console.log('  Browser error:', msg.text());
    }
  });
  page.on('pageerror', err => console.log('  Page error:', err.message));
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

async function testPageLoads() {
  await freshPage();
  const title = await page.title();
  const hasCanvas = await page.$('#tree-canvas') !== null;
  const hasLoginBtn = await page.$('#btn-login') !== null;
  log('Page loads with canvas and login button', title && hasCanvas && hasLoginBtn);
}

async function testLoginButtonClickWorks() {
  await freshPage();
  const preLoginReloadDisabled = await page.$eval('#btn-reload', el => el.disabled);
  
  // The form already has prefilled demo credentials from HTML
  // Just verify they're there
  const emailValue = await page.$eval('#email', el => el.value);
  const passwordValue = await page.$eval('#password', el => el.value);
  if (emailValue !== DEMO_EMAIL || passwordValue !== DEMO_PASSWORD) {
    await page.$eval('#email', el => el.value = '');
    await page.$eval('#password', el => el.value = '');
    await page.type('#email', DEMO_EMAIL);
    await page.type('#password', DEMO_PASSWORD);
  }
  
  let jsError = null;
  const errorHandler = err => { jsError = err.message; };
  page.once('pageerror', errorHandler);
  
  try {
    await Promise.all([
      page.click('#btn-login'),
      page.waitForFunction(() => {
        const stats = document.getElementById('stats');
        return stats && stats.textContent.includes('位亲人');
      }, { timeout: 10000 })
    ]);
  } catch (err) {
    if (jsError && jsError.includes('login is not defined')) {
      log('Login click works', false, 'login function not defined - REGRESSION');
      return;
    }
    if (jsError && jsError.includes('loadTree is not defined')) {
      log('Login click works', false, 'loadTree function not defined - REGRESSION');
      return;
    }
    throw err;
  }
  
  const statsText = await page.$eval('#stats', el => el.textContent);
  const postLoginReloadDisabled = await page.$eval('#btn-reload', el => el.disabled);
  
  log('Login click works', 
    statsText.includes('位亲人') && !postLoginReloadDisabled,
    `Stats: ${statsText}`
  );
}

async function testTreeRendersAfterLogin() {
  const nodes = await page.$$('g.node-card');
  log('Tree renders with nodes', nodes.length > 0, `Found ${nodes.length} nodes`);
}

async function testPersonSelection() {
  const firstNode = await page.$('g.node-card');
  if (!firstNode) {
    log('Person selection', false, 'No nodes to select');
    return;
  }
  
  await firstNode.click();
  await page.waitForSelector('#sheet:not(.hidden)', { timeout: 5000 });
  
  const sheetVisible = await page.$eval('#sheet', el => !el.classList.contains('hidden'));
  const summaryVisible = await page.$eval('#sheet-summary', el => !el.classList.contains('hidden'));
  
  log('Person selection opens sheet', sheetVisible && summaryVisible);
}

async function testKinButtonsVisible() {
  const kinGrid = await page.$('#kin-grid');
  const kinButtons = await page.$$('#kin-grid button[data-kin]');
  
  log('Kin buttons visible (父母哥姐弟妹儿女夫妻)', 
    kinButtons.length === 10,
    `Found ${kinButtons.length} kin buttons`
  );
}

async function testKinButtonClickWorks() {
  await page.click('button[data-kin="son"]');
  
  await page.waitForSelector('#form-add:not(.hidden)', { timeout: 5000 });
  const formVisible = await page.$eval('#form-add', el => !el.classList.contains('hidden'));
  const contextText = await page.$eval('#add-context', el => el.textContent);
  
  log('Kin button click opens add form', 
    formVisible && contextText.includes('儿子'),
    `Context: ${contextText}`
  );
}

async function testReloadButtonWorks() {
  await page.click('#btn-cancel-add');
  await new Promise(r => setTimeout(r, 200));
  
  const errors = [];
  page.once('pageerror', err => errors.push(err.message));
  
  await Promise.all([
    page.click('#btn-reload'),
    page.waitForFunction(() => {
      return document.querySelectorAll('g.node-card').length > 0;
    }, { timeout: 10000 })
  ]);
  
  if (errors.some(e => e.includes('loadTree is not defined'))) {
    log('Reload button works', false, 'loadTree function not defined');
    return;
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
  
  log('Persisted token reload renders tree', 
    tokenBefore === tokenAfter && nodes.length > 0,
    `Token persisted: ${tokenBefore === tokenAfter}, Nodes: ${nodes.length}`
  );
}

async function testFirstPersonForEmptyTree() {
  // Create test user via PHP CLI and get token
  const { execSync } = await import('child_process');
  const email = `testuser${Date.now()}@test.test`;
  const result = execSync(
    `cd /workspace && php artisan tinker --execute="` +
    `\\$u = \\App\\Models\\User::create(['name'=>'Test','email'=>'${email}','password'=>bcrypt('password')]);` +
    `\\App\\Models\\Tree::create(['owner_user_id'=>\\$u->id,'title'=>'Test Tree']);` +
    `echo \\$u->createToken('test')->plainTextToken;"`,
    { encoding: 'utf8' }
  ).trim();
  
  const token = result.split('\n').pop();
  
  await page.evaluate((token) => {
    localStorage.setItem('yimai_token', token);
    localStorage.removeItem('yimai_root_id');
  }, token);
  
  await page.reload({ waitUntil: 'networkidle0' });
  await new Promise(r => setTimeout(r, 500));
  
  await page.click('#btn-add');
  await page.waitForSelector('#form-add:not(.hidden)', { timeout: 5000 });
  
  const contextText = await page.$eval('#add-context', el => el.textContent);
  const sheetTitle = await page.$eval('#sheet-title', el => el.textContent);
  
  log('First person form for empty tree', 
    contextText.includes('还没有记下亲人') && sheetTitle === '第一位家人',
    `Title: ${sheetTitle}, Context: ${contextText.substring(0, 30)}`
  );
}

async function testAddFirstPerson() {
  await page.type('#add-name', '测试祖先');
  await page.click('#form-add button[type="submit"]');
  
  await page.waitForFunction(() => {
    return document.querySelectorAll('g.node-card').length > 0;
  }, { timeout: 10000 });
  
  const nodes = await page.$$('g.node-card');
  log('Add first person creates node', nodes.length > 0, `Created ${nodes.length} node(s)`);
}

async function testAddChild() {
  const node = await page.$('g.node-card');
  await node.click();
  await page.waitForSelector('#sheet:not(.hidden)', { timeout: 5000 });
  
  await page.click('button[data-kin="son"]');
  await page.waitForSelector('#form-add:not(.hidden)', { timeout: 5000 });
  
  await page.type('#add-name', '测试儿子');
  await page.click('#form-add button[type="submit"]');
  
  await page.waitForFunction(() => {
    return document.querySelectorAll('g.node-card').length >= 2;
  }, { timeout: 10000 });
  
  const nodes = await page.$$('g.node-card');
  log('Add child works', nodes.length >= 2, `Now have ${nodes.length} nodes`);
}

async function testMissingSiblingParentError() {
  await freshPage();
  
  // Create test user and orphan person via PHP CLI
  const { execSync } = await import('child_process');
  const email = `sibling${Date.now()}@test.test`;
  const result = execSync(
    `cd /workspace && php artisan tinker --execute="` +
    `\\$u = \\App\\Models\\User::create(['name'=>'Sibling Test','email'=>'${email}','password'=>bcrypt('password')]);` +
    `\\$t = \\App\\Models\\Tree::create(['owner_user_id'=>\\$u->id,'title'=>'Test Tree']);` +
    `\\$p = \\App\\Models\\Person::create(['tree_id'=>\\$t->id,'name'=>'无父母者','generation'=>1]);` +
    `echo \\$u->createToken('test')->plainTextToken.':'.\\$p->id;"`,
    { encoding: 'utf8' }
  ).trim();
  
  const parts = result.split('\n').pop().split(':');
  const token = parts[0];
  const personId = parts[1];
  
  await page.evaluate((token, personId) => {
    localStorage.setItem('yimai_token', token);
    localStorage.setItem('yimai_root_id', personId);
  }, token, personId);
  
  await page.reload({ waitUntil: 'networkidle0' });
  await page.waitForFunction(() => document.querySelectorAll('g.node-card').length > 0, { timeout: 10000 });
  
  const node = await page.$('g.node-card');
  await node.click();
  await page.waitForSelector('#sheet:not(.hidden)', { timeout: 5000 });
  
  await page.click('button[data-kin="elder_brother"]');
  
  await page.waitForSelector('#sheet-error:not(.hidden)', { timeout: 5000 });
  const errorText = await page.$eval('#sheet-error', el => el.textContent);
  
  log('Missing sibling parent shows error', 
    errorText.includes('父亲或母亲'),
    `Error: ${errorText.substring(0, 40)}`
  );
}

async function runAllTests() {
  console.log('\n一脉 Frontend Regression Tests\n' + '='.repeat(40));
  
  try {
    await setup();
    
    await testPageLoads();
    await testLoginButtonClickWorks();
    await testTreeRendersAfterLogin();
    await testPersonSelection();
    await testKinButtonsVisible();
    await testKinButtonClickWorks();
    await testReloadButtonWorks();
    await testPersistedTokenReload();
    await testFirstPersonForEmptyTree();
    await testAddFirstPerson();
    await testAddChild();
    await testMissingSiblingParentError();
    
  } catch (err) {
    console.error('Test error:', err);
  } finally {
    await teardown();
  }
  
  console.log('\n' + '='.repeat(40));
  const passed = results.filter(r => r.passed).length;
  const total = results.length;
  console.log(`Results: ${passed}/${total} tests passed`);
  
  if (passed < total) {
    console.log('\nFailed tests:');
    results.filter(r => !r.passed).forEach(r => {
      console.log(`  - ${r.test}: ${r.message}`);
    });
    process.exit(1);
  }
  
  process.exit(0);
}

runAllTests();
