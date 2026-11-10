/**
 * 一脉 frontend: browse the tree from API JSON, and add/recognize kin in plain Chinese.
 * Canvas edges come only from GET /api/v1/persons/{id}/tree — never inferred here.
 */

const API_BASE = `${window.location.origin}/api/v1`;
const TOKEN_KEY = 'yimai_token';
const ROOT_KEY = 'yimai_root_id';

const ERROR_ZH = {
  'Parent assignment would create a cycle.': '这样认下来会绕成一圈，亲疏就乱了，所以没有保存。',
  'A person cannot be their own parent.': '一个人不能认自己为父母。',
  'Parent must belong to the same tree.': '只能认同一本家谱里的人为父母。',
  'A person cannot be their own spouse.': '不能和自己结为夫妻。',
  'Person must belong to the same tree.': '只能和同一本家谱里的人结为夫妻。',
  'An open spouse link already exists for this pair.': '这两位已经记过还在续的夫妻关系了。',
  'death_year must be greater than or equal to birth_year.': '去世的年份不能早于出生的年份。',
  'end_year must be greater than or equal to start_year.': '结束的年份不能早于成亲的年份。',
  'Parent slot already set; refusing silent overwrite.': '这位已经记过这位父母了，不能悄悄改成别人。',
};

const USER_KEY = 'yimai_user_id';
const TREE_KEY = 'yimai_tree_id';
const RECOVERY_KEY = 'yimai_add_recovery';

const state = {
  token: localStorage.getItem(TOKEN_KEY) || '',
  userId: localStorage.getItem(USER_KEY) || '',
  treeId: localStorage.getItem(TREE_KEY) || '',
  rootId: localStorage.getItem(ROOT_KEY) || '',
  tree: null,
  persons: [],
  selectedId: null,
  mode: 'detail',
  saving: false,
  recovery: null,
  addIntent: { relation: '', anchorId: null, kin: '', pendingPersonId: null, parentRole: '' },
};

const PARTIAL_SAVE_MSG = '人已记下，关系未保存';
const DISPLAY_LOAD_FAIL_MSG = '人已记下且关系已保存，但画面没有刷新成功。请再点记下或重新载入，不会重复添加。';
const CREATE_UNCERTAIN_MSG = '刚才的记下结果还不确定（可能已保存但回信丢失）。请先重新载入名单；若已出现请选择「已经在谱里」的那位再继续。确认之前不会再次新建。';

const KIN = {
  father: { relation: 'father', gender: 'male', word: '父亲' },
  mother: { relation: 'mother', gender: 'female', word: '母亲' },
  elder_brother: { relation: 'sibling', gender: 'male', word: '哥哥' },
  elder_sister: { relation: 'sibling', gender: 'female', word: '姐姐' },
  younger_brother: { relation: 'sibling', gender: 'male', word: '弟弟' },
  younger_sister: { relation: 'sibling', gender: 'female', word: '妹妹' },
  son: { relation: 'child', gender: 'male', word: '儿子' },
  daughter: { relation: 'child', gender: 'female', word: '女儿' },
  husband: { relation: 'spouse', gender: 'male', word: '丈夫' },
  wife: { relation: 'spouse', gender: 'female', word: '妻子' },
};

const el = {
  email: document.getElementById('email'),
  password: document.getElementById('password'),
  login: document.getElementById('btn-login'),
  reload: document.getElementById('btn-reload'),
  add: document.getElementById('btn-add'),
  stats: document.getElementById('stats'),
  empty: document.getElementById('empty'),
  canvas: document.getElementById('tree-canvas'),
  sheet: document.getElementById('sheet'),
  sheetTitle: document.getElementById('sheet-title'),
  sheetSummary: document.getElementById('sheet-summary'),
  sheetDetail: document.getElementById('sheet-detail'),
  formAdd: document.getElementById('form-add'),
  closeSheet: document.getElementById('btn-close-sheet'),
  cancelAdd: document.getElementById('btn-cancel-add'),
  setRoot: document.getElementById('btn-set-root'),
  kinGrid: document.getElementById('kin-grid'),
  addHint: document.getElementById('add-hint'),
  addName: document.getElementById('add-name'),
  addBirthYear: document.getElementById('add-birth-year'),
  addDeathYear: document.getElementById('add-death-year'),
  addContext: document.getElementById('add-context'),
  addExisting: document.getElementById('add-existing'),
  addExistingWrap: document.getElementById('add-existing-wrap'),
  addParentRoleWrap: document.getElementById('add-parent-role-wrap'),
  addParentRole: document.getElementById('add-parent-role'),
  addError: document.getElementById('add-error'),
  sheetError: document.getElementById('sheet-error'),
  addSection: document.getElementById('add-section'),
  addAnchorLabel: document.getElementById('add-anchor-label'),
  submitAdd: document.getElementById('btn-submit-add'),
  perspectiveAction: document.querySelector('.perspective-action'),
  perspectiveNote: document.querySelector('.perspective-note'),
};

function authHeaders() {
  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Authorization: `Bearer ${state.token}`,
  };
}

function translateError(text) {
  if (!text) return '没有保存成功，请再试一次。';
  return ERROR_ZH[text] || text;
}

function formatApiError(body, fallback) {
  if (body && body.errors && typeof body.errors === 'object') {
    return Object.values(body.errors).flat().map(translateError).join(' ');
  }
  if (body && body.message) return translateError(body.message);
  return fallback;
}

function showError(node, message) {
  if (!node) return;
  if (!message) {
    node.classList.add('hidden');
    node.textContent = '';
    return;
  }
  node.textContent = message;
  node.classList.remove('hidden');
}

async function api(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: { ...authHeaders(), ...(options.headers || {}) },
  });
  if (!res.ok) {
    let detail = '没有保存成功，请再试一次。';
    try {
      const body = await res.json();
      detail = formatApiError(body, detail);
    } catch (_) { /* ignore */ }
    throw new Error(detail);
  }
  if (res.status === 204) return null;
  return res.json();
}

function countEdges(tree) {
  const edges = tree?.edges || [];
  return {
    nodes: (tree?.nodes || []).length,
    parent: edges.filter((e) => e.type === 'parent').length,
    spouse: edges.filter((e) => e.type === 'spouse').length,
  };
}

window.yimaiCountTree = countEdges;

function updateStats() {
  if (!state.token) {
    el.stats.textContent = '登录后，就可以看见家里的人';
    return;
  }
  const c = countEdges(state.tree);
  if (!c.nodes) {
    el.stats.textContent = '家里还没有记下亲人';
    return;
  }
  el.stats.innerHTML = `<span class="stat"><strong>${c.nodes}</strong>位亲人</span><span class="stat"><strong>${c.parent}</strong>门亲子</span><span class="stat"><strong>${c.spouse}</strong>对夫妻</span>`;
}

function setAuthed(on) {
  el.reload.disabled = !on;
  el.add.disabled = !on;
}

function optionalInt(value) {
  const text = String(value ?? '').trim();
  if (text === '') return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch]));
}

function sameId(a, b) {
  return String(a) === String(b);
}

function findPerson(id) {
  if (id == null || id === '') return null;
  return state.persons.find((p) => sameId(p.id, id))
    || (state.tree?.nodes || []).find((p) => sameId(p.id, id))
    || null;
}

function genderWord(gender) {
  if (gender === 'male') return '男';
  if (gender === 'female') return '女';
  return '';
}

function lifeSentence(person) {
  if (person.birth_year && person.death_year == null) {
    return `${person.birth_year}年出生，还在世`;
  }
  if (person.birth_year && person.death_year) {
    return `${person.birth_year}年出生，${person.death_year}年去世`;
  }
  if (!person.birth_year && person.death_year) {
    return `于${person.death_year}年去世，出生年份还未记下`;
  }
  return '生卒还没有记下';
}

function namesOf(people) {
  return people.map((p) => p.name).join('、');
}

function fillPersonSelect(selectEl, { excludeId, emptyLabel, selectedId }) {
  const options = [`<option value="">${escapeHtml(emptyLabel)}</option>`];
  for (const person of state.persons) {
    if (excludeId != null && sameId(person.id, excludeId)) continue;
    const selected = sameId(person.id, selectedId) ? ' selected' : '';
    const gender = genderWord(person.gender);
    const label = gender ? `${person.name}（${gender}）` : person.name;
    options.push(`<option value="${person.id}"${selected}>${escapeHtml(label)}</option>`);
  }
  selectEl.innerHTML = options.join('');
}


function generationFor(relation, anchor) {
  const current = Number(anchor?.generation) || 1;
  if (relation === 'father' || relation === 'mother') return Math.max(1, current - 1);
  if (relation === 'child') return current + 1;
  if (relation === 'spouse' || relation === 'sibling') return current;
  return 1;
}

function emptyIntent(extra = {}) {
  return {
    relation: '',
    anchorId: null,
    kin: '',
    pendingPersonId: null,
    parentRole: '',
    ...extra,
  };
}

function readRecoveryRaw() {
  try {
    const raw = localStorage.getItem(RECOVERY_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}

function recoveryScopedOk(rec) {
  if (!rec || !state.userId) return false;
  if (!sameId(rec.userId, state.userId)) return false;
  if (rec.treeId && state.treeId && !sameId(rec.treeId, state.treeId)) return false;
  return true;
}

function writeRecovery(rec) {
  if (!rec) {
    localStorage.removeItem(RECOVERY_KEY);
    state.recovery = null;
    return;
  }
  const payload = {
    ...rec,
    userId: String(state.userId || rec.userId || ''),
    treeId: String(state.treeId || rec.treeId || ''),
  };
  localStorage.setItem(RECOVERY_KEY, JSON.stringify(payload));
  state.recovery = payload;
}

function clearRecovery() {
  writeRecovery(null);
  state.addIntent.pendingPersonId = null;
}

function recoveryMessage(rec = state.recovery) {
  if (!rec) return '';
  if (rec.phase === 'display_load_failed') {
    return rec.message || DISPLAY_LOAD_FAIL_MSG;
  }
  return rec.message || PARTIAL_SAVE_MSG;
}

function showRecoveryGuidance() {
  const rec = state.recovery;
  if (!rec || !recoveryScopedOk(rec)) return;
  const msg = recoveryMessage(rec);
  showError(el.sheetError, msg);
  if (el.formAdd && !el.formAdd.classList.contains('hidden')) {
    showError(el.addError, msg);
  }
}

function syncTreeIdFromPersons() {
  const fromPerson = state.persons.find((p) => p.tree_id != null);
  if (fromPerson?.tree_id != null) {
    state.treeId = String(fromPerson.tree_id);
    localStorage.setItem(TREE_KEY, state.treeId);
  }
}

async function loadPersons() {
  if (!state.token) {
    state.persons = [];
    return;
  }
  const list = await api('/persons');
  state.persons = list.data || [];
  syncTreeIdFromPersons();
}

async function fetchPersonById(id) {
  return api(`/persons/${id}`);
}

function newClientOpId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return `op-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function isCreateUnresolvedPhase(phase) {
  return phase === 'create_inflight' || phase === 'create_uncertain';
}

function syncRootWithPersons() {
  if (state.persons.length === 0) {
    state.rootId = '';
    localStorage.removeItem(ROOT_KEY);
    return;
  }
  const rootOk = state.rootId && state.persons.some((p) => sameId(p.id, state.rootId));
  if (!rootOk) {
    state.rootId = String(state.persons[0].id);
    localStorage.setItem(ROOT_KEY, state.rootId);
  }
}

function loadScopedRecovery() {
  const rec = readRecoveryRaw();
  if (rec && recoveryScopedOk(rec)) {
    state.recovery = rec;
    return rec;
  }
  // Drop cross-account leakage.
  if (rec && !recoveryScopedOk(rec)) {
    localStorage.removeItem(RECOVERY_KEY);
  }
  state.recovery = null;
  return null;
}

async function resumeRecoveryUi() {
  const rec = loadScopedRecovery();
  if (!rec) return;
  showRecoveryGuidance();
  if (rec.kin === 'first') {
    const pending = findPerson(rec.pendingPersonId);
    if (pending) {
      // First person already exists — guide reload rather than create again.
      showError(el.sheetError, recoveryMessage(rec));
    }
    return;
  }
  const anchor = findPerson(rec.anchorId);
  if (anchor && KIN[rec.kin]) {
    showAddFormForKin(rec.kin, anchor, { resume: true });
  }
}

async function login() {
  const body = {
    email: el.email.value.trim(),
    password: el.password.value,
  };
  const data = await fetch(`${API_BASE}/auth/login`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then(async (res) => {
    if (!res.ok) throw new Error('账号或密码不对，请再试一次。');
    return res.json();
  });

  state.token = data.token;
  localStorage.setItem(TOKEN_KEY, state.token);
  state.userId = data.user?.id != null ? String(data.user.id) : '';
  if (state.userId) localStorage.setItem(USER_KEY, state.userId);
  setAuthed(true);

  await loadPersons();
  syncRootWithPersons();
  await loadTree();
  await resumeRecoveryUi();
}

async function loadTree() {
  if (!state.token) return;
  await loadPersons();
  syncRootWithPersons();
  if (!state.rootId) {
    state.tree = { root_id: null, nodes: [], edges: [] };
    render();
    return;
  }

  try {
    state.tree = await api(`/persons/${state.rootId}/tree`);
  } catch (err) {
    // Recover only when root is stale/foreign (not in current persons).
    // Transient failures on a known root must surface to callers (e.g. post-save display).
    const rootKnown = state.persons.some((p) => sameId(p.id, state.rootId));
    if (rootKnown) throw err;
    state.rootId = '';
    localStorage.removeItem(ROOT_KEY);
    syncRootWithPersons();
    if (!state.rootId) {
      state.tree = { root_id: null, nodes: [], edges: [] };
      render();
      throw err;
    }
    state.tree = await api(`/persons/${state.rootId}/tree`);
  }
  state.rootId = String(state.tree.root_id);
  localStorage.setItem(ROOT_KEY, state.rootId);
  render();
  if (state.selectedId && state.mode === 'detail') {
    const person = findPerson(state.selectedId);
    if (person) openSheet(person);
  }
}

function childParentRole(anchor) {
  if (anchor?.gender === 'female') return 'mother';
  if (anchor?.gender === 'male') return 'father';
  return state.addIntent.parentRole || el.addParentRole?.value || '';
}

function parentSlotLabel(slot) {
  return slot === 'father_id' ? '父亲' : '母亲';
}

function ensureParentSlot(person, slot, newId) {
  if (!person) return;
  const current = person[slot];
  if (current == null || current === '') return;
  if (newId != null && sameId(current, newId)) return;
  const name = person.name ? `「${person.name}」` : '这位亲人';
  throw new Error(`${name}已经记过${parentSlotLabel(slot)}了，不能改成别人。`);
}

function updateAnchorLabel(anchor) {
  if (!el.addAnchorLabel) return;
  if (!anchor) {
    el.addAnchorLabel.hidden = true;
    el.addAnchorLabel.textContent = '';
    return;
  }
  el.addAnchorLabel.hidden = false;
  el.addAnchorLabel.textContent = `当前人：${anchor.name}`;
}

function updateParentRoleVisibility(relation, anchor) {
  if (!el.addParentRoleWrap) return;
  const need = relation === 'child' && anchor && anchor.gender !== 'male' && anchor.gender !== 'female';
  el.addParentRoleWrap.classList.toggle('hidden', !need);
  if (!need && el.addParentRole) el.addParentRole.value = '';
}

function hasKnownParent(person) {
  return Boolean(person && (person.father_id != null || person.mother_id != null));
}

function missingParentsMessage(anchor) {
  const name = anchor?.name ? `「${anchor.name}」` : '这位亲人';
  return `要先给${name}记下父亲或母亲，才能把兄弟姐妹连在同一房里。`;
}

function addContextText(kinKey, anchor) {
  if (kinKey === 'first' || !anchor) {
    return '家里还没有记下亲人。先写下第一位的名字就好。';
  }
  const kin = KIN[kinKey];
  if (!kin) return `给「${anchor.name}」添一位亲人。`;
  const name = `「${anchor.name}」`;
  if (kin.relation === 'sibling') {
    return `给${name}添一位${kin.word}。会记到和${name}同一位父亲或母亲名下。`;
  }
  return `给${name}添一位${kin.word}。`;
}

function setKinPressed(kinKey) {
  el.kinGrid.querySelectorAll('button[data-kin]').forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.kin === kinKey));
  });
}

function resetAddForm({ preservePending = false } = {}) {
  const pendingId = state.addIntent.pendingPersonId;
  const parentRole = state.addIntent.parentRole;
  el.formAdd.reset();
  el.addName.required = true;
  if (!preservePending) showError(el.addError, '');
  if (el.addExisting) el.addExisting.value = '';
  if (el.addParentRole) el.addParentRole.value = '';
  if (preservePending) {
    state.addIntent.pendingPersonId = pendingId;
    state.addIntent.parentRole = parentRole;
    if (el.addParentRole && parentRole) el.addParentRole.value = parentRole;
  } else {
    state.addIntent.pendingPersonId = null;
    state.addIntent.parentRole = '';
  }
}

function setFirstPersonChrome(on) {
  el.sheetSummary.classList.toggle('hidden', on);
  el.perspectiveAction?.classList.toggle('hidden', on);
  el.perspectiveNote?.classList.toggle('hidden', on);
  el.kinGrid.classList.toggle('hidden', on);
  el.addHint.classList.toggle('hidden', on);
}

function fillExistingSelect(anchor) {
  const others = state.persons.filter((person) => !anchor || !sameId(person.id, anchor.id));
  if (!el.addExistingWrap) return;
  if (!anchor || others.length === 0) {
    el.addExistingWrap.classList.add('hidden');
    if (el.addExisting) el.addExisting.innerHTML = '';
    return;
  }
  el.addExistingWrap.classList.remove('hidden');
  fillPersonSelect(el.addExisting, {
    excludeId: anchor.id,
    emptyLabel: '不是，这是一位新记下的亲人',
    selectedId: '',
  });
}

function showAddFormForKin(kinKey, anchor, { resume = false } = {}) {
  const rec = state.recovery && recoveryScopedOk(state.recovery) ? state.recovery : null;
  const canResume = Boolean(
    rec
    && rec.pendingPersonId
    && (resume
      || (rec.kin === kinKey && sameId(rec.anchorId, anchor.id))),
  );

  state.mode = 'add';
  state.selectedId = anchor.id;
  state.addIntent = emptyIntent({
    kin: kinKey,
    relation: KIN[kinKey].relation,
    anchorId: anchor.id,
    pendingPersonId: canResume ? rec.pendingPersonId : null,
    parentRole: canResume ? (rec.parentRole || '') : '',
  });
  setKinPressed(kinKey);
  setFirstPersonChrome(false);
  updateAnchorLabel(anchor);
  el.formAdd.classList.remove('hidden');
  resetAddForm({ preservePending: canResume });
  state.addIntent.kin = kinKey;
  state.addIntent.relation = KIN[kinKey].relation;
  state.addIntent.anchorId = anchor.id;
  if (canResume) {
    state.addIntent.pendingPersonId = rec.pendingPersonId;
    state.addIntent.parentRole = rec.parentRole || '';
  }
  fillExistingSelect(anchor);
  if (canResume && el.addExisting && rec.pendingPersonId) {
    el.addExisting.value = String(rec.pendingPersonId);
    el.addName.required = false;
    el.addName.value = rec.name || el.addName.value;
  }
  updateParentRoleVisibility(KIN[kinKey].relation, anchor);
  if (canResume && el.addParentRole && rec.parentRole) {
    el.addParentRole.value = rec.parentRole;
  }
  el.addContext.textContent = addContextText(kinKey, anchor);
  if (canResume) {
    showError(el.addError, recoveryMessage(rec));
    showError(el.sheetError, recoveryMessage(rec));
  } else if (rec && recoveryScopedOk(rec)) {
    showError(
      el.sheetError,
      `${recoveryMessage(rec)}（未完成：${rec.name || '已记下的亲人'}。可回到原关系继续，或在下方选择那位已记下的亲人。）`,
    );
  }
  el.addName.focus();
}

function showFirstPersonForm() {
  const rec = state.recovery && recoveryScopedOk(state.recovery) ? state.recovery : null;
  const canResume = Boolean(rec && rec.kin === 'first' && rec.pendingPersonId);
  state.mode = 'add';
  state.selectedId = null;
  state.addIntent = emptyIntent({
    kin: 'first',
    pendingPersonId: canResume ? rec.pendingPersonId : null,
  });
  setKinPressed('');
  updateAnchorLabel(null);
  el.sheet.classList.remove('hidden');
  el.sheetDetail.classList.remove('hidden');
  el.formAdd.classList.remove('hidden');
  el.sheetTitle.textContent = '第一位家人';
  document.getElementById('sheet-kicker').textContent = '续写家谱';
  d3.select(el.canvas).selectAll('.node-card').classed('selected', false).attr('aria-pressed', 'false');
  setFirstPersonChrome(true);
  resetAddForm({ preservePending: canResume });
  state.addIntent.kin = 'first';
  if (canResume) {
    state.addIntent.pendingPersonId = rec.pendingPersonId;
    el.addName.value = rec.name || '';
    showError(el.addError, recoveryMessage(rec));
  }
  el.addExistingWrap.classList.add('hidden');
  updateParentRoleVisibility('', null);
  el.addContext.textContent = addContextText('first');
  showRecoveryGuidance();
  el.sheet.scrollTop = 0;
  el.addName.focus();
}

function startAddForKin(kinKey) {
  const kin = KIN[kinKey];
  const anchor = findPerson(state.selectedId);
  if (!kin || !anchor) {
    const base = '请先在树上点一位当前人，再选择要添加的关系。';
    const rec = state.recovery && recoveryScopedOk(state.recovery) ? state.recovery : null;
    showError(el.sheetError, rec ? `${base} ${recoveryMessage(rec)}` : base);
    return;
  }
  if (kin.relation === 'sibling' && !hasKnownParent(anchor)) {
    // Do not erase durable recovery guidance when explaining the sibling prerequisite.
    const missing = missingParentsMessage(anchor);
    const rec = state.recovery && recoveryScopedOk(state.recovery) ? state.recovery : null;
    showError(
      el.sheetError,
      rec ? `${missing} ${recoveryMessage(rec)}` : missing,
    );
    el.formAdd.classList.add('hidden');
    setKinPressed('');
    return;
  }
  showError(el.sheetError, '');
  showAddFormForKin(kinKey, anchor);
}

function onToolbarAdd() {
  if (!state.token) {
    alert('请先登录，再给家里添人。');
    return;
  }
  if (state.persons.length === 0) {
    showFirstPersonForm();
    return;
  }
  const anchor = findPerson(state.selectedId);
  if (!anchor) {
    alert('请先在树上点一位当前人，再选父、母、哥、姐、弟、妹、儿、女、夫、妻。');
    return;
  }
  el.sheet.classList.remove('hidden');
  el.addSection?.scrollIntoView({ block: 'nearest' });
}

function genderGlyph(gender) {
  if (gender === 'male') return '男';
  if (gender === 'female') return '女';
  return '';
}

function yearsLabel(node) {
  if (node.birth_year && node.death_year == null) return `${node.birth_year}年 · 在世`;
  if (node.birth_year && node.death_year) return `${node.birth_year}–${node.death_year}`;
  if (!node.birth_year && node.death_year) return `卒于${node.death_year}年`;
  return '生卒未记下';
}

function render() {
  updateStats();
  const tree = state.tree;
  const nodes = tree?.nodes || [];
  const edges = tree?.edges || [];

  el.empty.classList.toggle('hidden', nodes.length > 0);
  document.getElementById('empty-hint').textContent = state.token
    ? '家里还没有记下亲人。点右上角「添加」，写下第一位就好。'
    : '用上方预填的演示账号登录，翻开这本家谱。';
  setAuthed(Boolean(state.token));

  const svg = d3.select(el.canvas);
  svg.selectAll('*').remove();

  const wrap = el.canvas.parentElement;
  const width = wrap.clientWidth || 800;
  const height = wrap.clientHeight || 600;
  if (nodes.length === 0) return;

  const byGen = d3.group(nodes, (d) => d.generation);
  const gens = Array.from(byGen.keys()).sort((a, b) => a - b);
  const cardW = 176;
  const cardH = 94;
  const rowGap = 46;
  const sceneWidth = Math.max(width, d3.max(Array.from(byGen.values()), (row) => row.length) * (cardW + 28) + 20);
  const sceneHeight = Math.max(height, gens.length * (cardH + rowGap) + 30);
  const yGap = Math.min(164, (sceneHeight - 60) / Math.max(gens.length, 1));
  const top = Math.max(30, (sceneHeight - ((gens.length - 1) * yGap + cardH)) / 2);
  svg.attr('viewBox', `0 0 ${sceneWidth} ${sceneHeight}`);
  const positions = new Map();

  gens.forEach((g, gi) => {
    const row = byGen.get(g);
    const y = top + gi * yGap;
    const gap = Math.max(28, Math.min(58, (sceneWidth - 48 - row.length * cardW) / Math.max(row.length + 1, 1)));
    const totalW = row.length * cardW + (row.length - 1) * gap;
    let x = (sceneWidth - totalW) / 2;
    row.forEach((n) => {
      positions.set(n.id, { x, y, node: n });
      x += cardW + gap;
    });
  });

  const gRoot = svg.append('g').attr('class', 'scene');

  edges.filter((e) => e.type === 'parent').forEach((e) => {
    const a = positions.get(e.from);
    const b = positions.get(e.to);
    if (!a || !b) return;
    const x1 = a.x + cardW / 2;
    const y1 = a.y + cardH;
    const x2 = b.x + cardW / 2;
    const y2 = b.y;
    const midY = (y1 + y2) / 2;
    gRoot.append('path')
      .attr('class', 'edge-parent')
      .attr('d', `M${x1},${y1} C${x1},${midY} ${x2},${midY} ${x2},${y2}`);
  });

  edges.filter((e) => e.type === 'spouse').forEach((e) => {
    const a = positions.get(e.a);
    const b = positions.get(e.b);
    if (!a || !b) return;
    const x1 = a.x + cardW / 2;
    const y1 = a.y + cardH / 2;
    const x2 = b.x + cardW / 2;
    const y2 = b.y + cardH / 2;
    gRoot.append('path')
      .attr('class', 'edge-spouse')
      .attr('d', `M${x1},${y1} L${x2},${y2}`);
  });

  const cards = gRoot.selectAll('g.node-card')
    .data(nodes, (d) => d.id)
    .join('g')
    .attr('class', (d) => `node-card${sameId(d.id, tree.root_id) ? ' root' : ''}${sameId(d.id, state.selectedId) ? ' selected' : ''}`)
    .attr('tabindex', 0)
    .attr('role', 'button')
    .attr('aria-label', (d) => `${d.name}，${yearsLabel(d)}，查看小传`)
    .attr('aria-pressed', (d) => String(sameId(d.id, state.selectedId)))
    .attr('transform', (d) => {
      const p = positions.get(d.id);
      return `translate(${p.x},${p.y})`;
    })
    .style('cursor', 'pointer')
    .on('click', (event, d) => {
      event.stopPropagation();
      openSheet(findPerson(d.id) || d);
    })
    .on('keydown', (event, d) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openSheet(findPerson(d.id) || d);
      }
    });

  cards.append('title').text((d) => `${d.name} · ${yearsLabel(d)}`);
  cards.append('rect').attr('class', 'node-paper').attr('width', cardW).attr('height', cardH).attr('rx', 3);
  const viewpoint = cards.filter((d) => sameId(d.id, tree.root_id));
  viewpoint.append('rect').attr('class', 'view-mark').attr('x', 15).attr('y', 12).attr('width', 4).attr('height', 4);
  viewpoint.append('text').attr('class', 'view-label').attr('x', 24).attr('y', 18).text('当前视角');
  cards.append('text')
    .attr('class', 'person-name')
    .attr('x', 15)
    .attr('y', 49)
    .attr('font-size', (d) => Array.from(d.name).length > 5 ? 17 : 22)
    .text((d) => {
      const characters = Array.from(d.name);
      return characters.length > 7 ? `${characters.slice(0, 6).join('')}…` : d.name;
    });
  cards.append('text')
    .attr('class', 'gender')
    .attr('x', cardW - 15)
    .attr('y', 18)
    .attr('text-anchor', 'end')
    .text((d) => genderGlyph(d.gender));
  cards.append('text')
    .attr('class', 'meta')
    .attr('x', 15)
    .attr('y', 76)
    .text((d) => yearsLabel(d));
}

function relationsFromEdges(personId) {
  const edges = state.tree?.edges || [];
  const nodesById = new Map((state.tree?.nodes || []).map((n) => [String(n.id), n]));
  const parents = edges
    .filter((e) => e.type === 'parent' && sameId(e.to, personId))
    .map((e) => nodesById.get(String(e.from)))
    .filter(Boolean);
  const children = edges
    .filter((e) => e.type === 'parent' && sameId(e.from, personId))
    .map((e) => nodesById.get(String(e.to)))
    .filter(Boolean);
  const spouses = edges
    .filter((e) => e.type === 'spouse' && (sameId(e.a, personId) || sameId(e.b, personId)))
    .map((e) => nodesById.get(String(sameId(e.a, personId) ? e.b : e.a)))
    .filter(Boolean);
  return { parents, children, spouses };
}

function siblingsOf(personId) {
  const parentIds = relationsFromEdges(personId).parents.map((p) => p.id);
  if (parentIds.length === 0) return [];
  const childIds = [];
  for (const edge of state.tree?.edges || []) {
    if (edge.type !== 'parent') continue;
    if (!parentIds.some((id) => sameId(id, edge.from))) continue;
    if (sameId(edge.to, personId)) continue;
    const key = String(edge.to);
    if (!childIds.includes(key)) childIds.push(key);
  }
  return childIds.map((id) => findPerson(id)).filter(Boolean);
}


function openSheet(node) {
  const personChanged = state.mode !== 'detail' || !sameId(state.selectedId, node.id);
  state.mode = 'detail';
  state.selectedId = node.id;
  // Keep persisted recovery; only reset the ephemeral addIntent for detail view.
  const pendingId = state.recovery?.pendingPersonId ?? null;
  state.addIntent = emptyIntent({
    anchorId: node.id,
    pendingPersonId: pendingId,
    parentRole: state.recovery?.parentRole || '',
  });
  el.sheetDetail.classList.remove('hidden');
  el.sheet.classList.remove('hidden');
  el.formAdd.classList.add('hidden');
  setFirstPersonChrome(false);
  setKinPressed('');
  updateAnchorLabel(node);
  el.sheetTitle.textContent = node.name;
  document.getElementById('sheet-kicker').textContent = '家人小传';
  d3.select(el.canvas).selectAll('.node-card')
    .classed('selected', (d) => sameId(d.id, node.id))
    .attr('aria-pressed', (d) => String(sameId(d.id, node.id)));
  el.setRoot.textContent = `从「${node.name}」看这棵家谱`;
  showError(el.addError, '');
  showError(el.sheetError, '');

  const rel = relationsFromEdges(node.id);
  const gender = genderWord(node.gender);
  const intro = gender
    ? `${escapeHtml(node.name)}，${gender}。${lifeSentence(node)}。`
    : `${escapeHtml(node.name)}。${lifeSentence(node)}。`;
  const siblings = siblingsOf(node.id);
  const parentsLine = rel.parents.length ? `父母是${namesOf(rel.parents)}。` : '父母还没有记下。';
  const siblingLine = siblings.length ? `兄弟姐妹有${namesOf(siblings)}。` : '兄弟姐妹还没有记下。';
  const spouseLine = rel.spouses.length ? `配偶是${namesOf(rel.spouses)}。` : '配偶还没有记下。';
  const childLine = rel.children.length ? `子女有${namesOf(rel.children)}。` : '子女还没有记下。';
  el.sheetSummary.innerHTML = `<p>${intro}</p><p class="biography-kin">${[parentsLine, siblingLine, spouseLine, childLine].map((line) => `<span>${escapeHtml(line)}</span>`).join('')}</p>`;
  el.setRoot.dataset.personId = String(node.id);
  if (personChanged) el.sheet.scrollTop = 0;
  showRecoveryGuidance();
}

function closeSheet() {
  const wasFirst = state.addIntent.kin === 'first' && !state.recovery;
  state.selectedId = null;
  state.mode = 'detail';
  state.addIntent = emptyIntent({
    pendingPersonId: state.recovery?.pendingPersonId ?? null,
    parentRole: state.recovery?.parentRole || '',
  });
  el.formAdd.classList.add('hidden');
  setKinPressed('');
  setFirstPersonChrome(false);
  updateAnchorLabel(null);
  showError(el.addError, '');
  showError(el.sheetError, '');
  if (wasFirst || !findPerson(state.selectedId)) {
    if (!state.recovery) el.sheet.classList.add('hidden');
  }
  d3.select(el.canvas).selectAll('.node-card').classed('selected', false).attr('aria-pressed', 'false');
  showRecoveryGuidance();
}

function cancelAdd() {
  if (state.addIntent.kin === 'first' && state.persons.length === 0 && !state.recovery?.pendingPersonId) {
    closeSheet();
    return;
  }
  const anchor = findPerson(state.selectedId) || findPerson(state.addIntent.anchorId) || findPerson(state.recovery?.anchorId);
  el.formAdd.classList.add('hidden');
  setKinPressed('');
  state.addIntent = emptyIntent({
    anchorId: anchor ? anchor.id : null,
    pendingPersonId: state.recovery?.pendingPersonId ?? null,
    parentRole: state.recovery?.parentRole || '',
  });
  showError(el.addError, '');
  if (anchor) openSheet(anchor);
  else {
    showRecoveryGuidance();
    if (state.persons.length === 0 && !state.recovery) closeSheet();
  }
}

async function setAsRoot() {
  const id = el.setRoot.dataset.personId;
  if (!id) return;
  state.rootId = id;
  localStorage.setItem(ROOT_KEY, id);
  await loadTree();
}

async function bindPerson(target, relation, anchor) {
  if (!relation || !anchor || !target) return;
  // Refresh local person records so slot checks see latest father_id/mother_id.
  const liveAnchor = findPerson(anchor.id) || anchor;
  const liveTarget = findPerson(target.id) || target;

  if (relation === 'father') {
    ensureParentSlot(liveAnchor, 'father_id', liveTarget.id);
    if (sameId(liveAnchor.father_id, liveTarget.id)) return;
    await api(`/persons/${liveAnchor.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ father_id: liveTarget.id }),
    });
    return;
  }
  if (relation === 'mother') {
    ensureParentSlot(liveAnchor, 'mother_id', liveTarget.id);
    if (sameId(liveAnchor.mother_id, liveTarget.id)) return;
    await api(`/persons/${liveAnchor.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ mother_id: liveTarget.id }),
    });
    return;
  }
  if (relation === 'spouse') {
    try {
      await api('/spouse-links', {
        method: 'POST',
        body: JSON.stringify({
          person_a_id: Number(liveAnchor.id),
          person_b_id: Number(liveTarget.id),
        }),
      });
    } catch (err) {
      if (String(err.message || '').includes('已经记过还在续的夫妻关系')) return;
      throw err;
    }
    return;
  }
  if (relation === 'child') {
    const role = childParentRole(liveAnchor);
    if (role !== 'father' && role !== 'mother') {
      throw new Error(`还不确定「${liveAnchor.name}」是父亲还是母亲，请先选择后再添孩子。`);
    }
    const slot = role === 'mother' ? 'mother_id' : 'father_id';
    ensureParentSlot(liveTarget, slot, liveAnchor.id);
    if (sameId(liveTarget[slot], liveAnchor.id)) return;
    const payload = role === 'mother'
      ? { mother_id: Number(liveAnchor.id) }
      : { father_id: Number(liveAnchor.id) };
    await api(`/persons/${liveTarget.id}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    });
    return;
  }
  if (relation === 'sibling') {
    if (!hasKnownParent(liveAnchor)) {
      throw new Error(missingParentsMessage(liveAnchor));
    }
    const payload = {};
    if (liveAnchor.father_id != null) {
      ensureParentSlot(liveTarget, 'father_id', liveAnchor.father_id);
      if (!sameId(liveTarget.father_id, liveAnchor.father_id)) {
        payload.father_id = Number(liveAnchor.father_id);
      }
    }
    if (liveAnchor.mother_id != null) {
      ensureParentSlot(liveTarget, 'mother_id', liveAnchor.mother_id);
      if (!sameId(liveTarget.mother_id, liveAnchor.mother_id)) {
        payload.mother_id = Number(liveAnchor.mother_id);
      }
    }
    if (Object.keys(payload).length === 0) return;
    await api(`/persons/${liveTarget.id}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    });
  }
}

function setSaving(on) {
  state.saving = on;
  if (el.submitAdd) el.submitAdd.disabled = on;
}

function ensureRootForPerson(personId) {
  if (!state.rootId || !state.persons.some((p) => sameId(p.id, state.rootId))) {
    state.rootId = String(personId);
    localStorage.setItem(ROOT_KEY, state.rootId);
  }
}

function buildRecoveryDraft({
  target,
  kinKey,
  relation,
  anchor,
  parentRole,
  name,
  phase,
  message,
  clientOpId,
  allowCreate,
}) {
  return {
    userId: state.userId,
    treeId: state.treeId || target?.tree_id || '',
    pendingPersonId: target?.id ?? null,
    kin: kinKey,
    relation: relation || '',
    anchorId: anchor?.id ?? null,
    parentRole: parentRole || '',
    name: name || target?.name || '',
    phase,
    message,
    clientOpId: clientOpId || state.recovery?.clientOpId || null,
    allowCreate: Boolean(allowCreate),
  };
}

/**
 * Display/bind may still be unfinished. Durable recovery must survive the await
 * window (refresh/navigation bypass catch). Clear only after completion.
 */
async function finishAddSuccess(target) {
  await loadTree();
  clearRecovery();
  openSheet(findPerson(target.id) || target);
}

async function submitAdd(event) {
  event.preventDefault();
  if (state.saving) return;
  setSaving(true);
  showError(el.addError, '');
  try {
    const kinKey = state.addIntent.kin || state.recovery?.kin || '';
    const isFirst = kinKey === 'first';
    const kin = isFirst ? null : KIN[kinKey];
    const relation = isFirst ? '' : (kin?.relation || state.addIntent.relation || state.recovery?.relation || '');
    const anchor = isFirst
      ? null
      : findPerson(state.addIntent.anchorId || state.selectedId || state.recovery?.anchorId);
    if (!isFirst && (!kin || !anchor)) {
      showError(el.addError, '请先在树上点一位当前人，再选择要添加的关系。');
      return;
    }
    if (relation === 'sibling' && !hasKnownParent(anchor)) {
      showError(el.addError, missingParentsMessage(anchor));
      return;
    }
    let parentRole = '';
    if (relation === 'child') {
      parentRole = childParentRole(anchor) || state.recovery?.parentRole || '';
      if (parentRole !== 'father' && parentRole !== 'mother') {
        showError(el.addError, `还不确定「${anchor.name}」是父亲还是母亲，请先选择后再添孩子。`);
        return;
      }
      state.addIntent.parentRole = parentRole;
    }

    const existingId = el.addExisting && !el.addExistingWrap.classList.contains('hidden')
      ? el.addExisting.value
      : '';

    if (existingId) {
      let existing = findPerson(existingId);
      if (!existing) existing = await fetchPersonById(existingId);
      if (!existing) {
        showError(el.addError, '请重新选择已经在谱里的那位亲人。');
        return;
      }
      if (relation === 'father') ensureParentSlot(anchor, 'father_id', existing.id);
      if (relation === 'mother') ensureParentSlot(anchor, 'mother_id', existing.id);
      await bindPerson(existing, relation, anchor);
      try {
        await finishAddSuccess(existing);
      } catch (loadErr) {
        writeRecovery(buildRecoveryDraft({
          target: existing,
          kinKey,
          relation,
          anchor,
          parentRole,
          name: existing.name,
          phase: 'display_load_failed',
          message: DISPLAY_LOAD_FAIL_MSG,
        }));
        state.addIntent.pendingPersonId = existing.id;
        state.mode = 'add';
        el.formAdd.classList.remove('hidden');
        showError(el.addError, DISPLAY_LOAD_FAIL_MSG);
        showError(el.sheetError, DISPLAY_LOAD_FAIL_MSG);
      }
      return;
    }

    // Refuse conflicting parent slots BEFORE creating another person.
    if (relation === 'father') ensureParentSlot(anchor, 'father_id', null);
    if (relation === 'mother') ensureParentSlot(anchor, 'mother_id', null);

    let pendingId = state.addIntent.pendingPersonId || state.recovery?.pendingPersonId || null;
    let phase = state.recovery?.phase || '';
    const clientOpId = state.recovery?.clientOpId || newClientOpId();

    let target = null;
    if (pendingId) {
      // Single GET-by-id failure does NOT clear recovery. Fall back to list;
      // if loadPersons throws, error bubbles and durable recovery remains.
      // Clear only when the list returns successfully and still lacks the id.
      try {
        target = await fetchPersonById(pendingId);
      } catch (_) {
        target = null;
      }
      if (!target) {
        await loadPersons();
        target = findPerson(pendingId);
      }
      if (!target) {
        showError(el.addError, '刚才记下的亲人找不到了，请重新添加。');
        clearRecovery();
        return;
      }
      state.addIntent.pendingPersonId = target.id;
    } else if (isCreateUnresolvedPhase(phase) && !state.recovery?.allowCreate) {
      // Lost/uncertain create response: never auto POST again until reconciled.
      try {
        await loadPersons();
      } catch (_) { /* still block create */ }
      const named = (state.recovery?.name || el.addName.value.trim() || '').trim();
      const found = named ? state.persons.filter((p) => p.name === named) : [];
      if (found.length === 1) {
        // Safe adopt of the single same-name row in this scoped tree — not a new create.
        target = found[0];
        state.addIntent.pendingPersonId = target.id;
        writeRecovery(buildRecoveryDraft({
          target,
          kinKey,
          relation,
          anchor,
          parentRole,
          name: named,
          phase: 'created_unbound',
          message: PARTIAL_SAVE_MSG,
          clientOpId,
        }));
        phase = 'created_unbound';
        pendingId = target.id;
      } else if (found.length === 0) {
        writeRecovery(buildRecoveryDraft({
          target: null,
          kinKey,
          relation,
          anchor,
          parentRole,
          name: named,
          phase: 'create_uncertain',
          message: `${CREATE_UNCERTAIN_MSG} 当前名单里还没有「${named || '这位'}」；若确认没有，请再点一次记下才会新建。`,
          clientOpId,
          allowCreate: true,
        }));
        showError(el.addError, state.recovery.message);
        showError(el.sheetError, state.recovery.message);
        state.mode = 'add';
        el.formAdd.classList.remove('hidden');
        return;
      } else {
        if (!isFirst && anchor) fillExistingSelect(anchor);
        writeRecovery(buildRecoveryDraft({
          target: null,
          kinKey,
          relation,
          anchor,
          parentRole,
          name: named,
          phase: 'create_uncertain',
          message: `${CREATE_UNCERTAIN_MSG} 名单里有多位同名，请选择「已经在谱里」的那位。`,
          clientOpId,
        }));
        showError(el.addError, state.recovery.message);
        showError(el.sheetError, state.recovery.message);
        state.mode = 'add';
        el.formAdd.classList.remove('hidden');
        return;
      }
    } else {
      const payload = {
        name: el.addName.value.trim(),
        gender: isFirst ? 'unknown' : kin.gender,
        generation: isFirst ? 1 : generationFor(relation, anchor),
        birth_year: optionalInt(el.addBirthYear.value),
        death_year: optionalInt(el.addDeathYear.value),
      };
      if (!payload.name) {
        showError(el.addError, '请先写下这位亲人的名字。');
        return;
      }
      // Durable inflight marker before POST so refresh mid-create cannot orphan identity intent.
      writeRecovery(buildRecoveryDraft({
        target: null,
        kinKey,
        relation,
        anchor,
        parentRole,
        name: payload.name,
        phase: 'create_inflight',
        message: CREATE_UNCERTAIN_MSG,
        clientOpId,
      }));
      try {
        target = await api('/persons', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
      } catch (createErr) {
        // Response may have been lost after commit — do not clear; block automatic re-POST.
        writeRecovery(buildRecoveryDraft({
          target: null,
          kinKey,
          relation,
          anchor,
          parentRole,
          name: payload.name,
          phase: 'create_uncertain',
          message: CREATE_UNCERTAIN_MSG,
          clientOpId,
        }));
        try {
          await loadPersons();
          if (!isFirst && anchor) fillExistingSelect(anchor);
        } catch (_) { /* keep uncertain recovery */ }
        state.mode = 'add';
        el.formAdd.classList.remove('hidden');
        showError(el.addError, CREATE_UNCERTAIN_MSG);
        showError(el.sheetError, CREATE_UNCERTAIN_MSG);
        return;
      }
      state.addIntent.pendingPersonId = target.id;
      writeRecovery(buildRecoveryDraft({
        target,
        kinKey,
        relation,
        anchor,
        parentRole,
        name: payload.name,
        phase: 'created_unbound',
        message: PARTIAL_SAVE_MSG,
        clientOpId,
      }));
      phase = 'created_unbound';
      pendingId = target.id;
      try {
        await loadPersons();
      } catch (_) {
        /* person exists; continue with returned payload */
      }
    }

    // Saved person exists; display-load-only recovery skips bind (pending or failed).
    if (phase === 'display_load_failed' || phase === 'display_load_pending') {
      if (isFirst) {
        state.rootId = String(target.id);
        localStorage.setItem(ROOT_KEY, state.rootId);
      } else {
        ensureRootForPerson(target.id);
      }
      try {
        await finishAddSuccess(target);
      } catch (loadErr) {
        writeRecovery(buildRecoveryDraft({
          target,
          kinKey,
          relation,
          anchor,
          parentRole,
          name: target.name,
          phase: 'display_load_failed',
          message: DISPLAY_LOAD_FAIL_MSG,
        }));
        state.addIntent.pendingPersonId = target.id;
        state.mode = 'add';
        el.formAdd.classList.remove('hidden');
        showError(el.addError, DISPLAY_LOAD_FAIL_MSG);
        showError(el.sheetError, DISPLAY_LOAD_FAIL_MSG);
      }
      return;
    }

    try {
      if (!isFirst) await bindPerson(target, relation, anchor);
    } catch (bindErr) {
      const detail = bindErr.message ? `：${bindErr.message}` : '';
      const msg = `${PARTIAL_SAVE_MSG}${detail}`;
      writeRecovery(buildRecoveryDraft({
        target,
        kinKey,
        relation,
        anchor,
        parentRole,
        name: target.name,
        phase: 'bind_failed',
        message: msg,
      }));
      showError(el.addError, msg);
      showError(el.sheetError, msg);
      if (isFirst || !state.rootId) ensureRootForPerson(target.id);
      else ensureRootForPerson(state.rootId);
      state.mode = 'add';
      state.addIntent.pendingPersonId = target.id;
      try {
        await loadPersons();
        syncRootWithPersons();
        if (state.rootId) {
          state.tree = await api(`/persons/${state.rootId}/tree`);
          render();
        }
      } catch (_) { /* keep form + recovery */ }
      el.formAdd.classList.remove('hidden');
      return;
    }

    // Bind (or first-person create) succeeded — do not clear recovery until display load works.
    writeRecovery(buildRecoveryDraft({
      target,
      kinKey,
      relation,
      anchor,
      parentRole,
      name: target.name,
      phase: 'display_load_pending',
      message: DISPLAY_LOAD_FAIL_MSG,
    }));
    state.addIntent.pendingPersonId = target.id;
    if (isFirst) {
      state.rootId = String(target.id);
      localStorage.setItem(ROOT_KEY, state.rootId);
    } else {
      ensureRootForPerson(target.id);
    }
    try {
      await loadPersons();
      await finishAddSuccess(target);
    } catch (loadErr) {
      writeRecovery(buildRecoveryDraft({
        target,
        kinKey,
        relation,
        anchor,
        parentRole,
        name: target.name,
        phase: 'display_load_failed',
        message: DISPLAY_LOAD_FAIL_MSG,
      }));
      state.addIntent.pendingPersonId = target.id;
      state.mode = 'add';
      el.formAdd.classList.remove('hidden');
      showError(el.addError, DISPLAY_LOAD_FAIL_MSG);
      showError(el.sheetError, DISPLAY_LOAD_FAIL_MSG);
    }
  } catch (err) {
    showError(el.addError, err.message);
  } finally {
    setSaving(false);
  }
}

el.login.addEventListener('click', () => login().catch((e) => alert(e.message)));
el.reload.addEventListener('click', () => loadTree().catch((e) => alert(e.message)));
el.add.addEventListener('click', onToolbarAdd);
el.cancelAdd.addEventListener('click', cancelAdd);
el.closeSheet.addEventListener('click', closeSheet);
el.setRoot.addEventListener('click', () => setAsRoot().catch((e) => alert(e.message)));
el.kinGrid.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-kin]');
  if (!button) return;
  startAddForKin(button.dataset.kin);
});
el.addExisting?.addEventListener('change', () => {
  const usingExisting = Boolean(el.addExisting.value);
  el.addName.required = !usingExisting;
  if (usingExisting) el.addName.value = el.addExisting.selectedOptions[0]?.textContent.split('（')[0] || el.addName.value;
});
el.addParentRole?.addEventListener('change', () => {
  state.addIntent.parentRole = el.addParentRole.value || '';
});
el.formAdd.addEventListener('submit', (event) => submitAdd(event));
// The paper also changes size when the biography opens or closes.
new ResizeObserver(() => render()).observe(el.canvas.parentElement);

render();

if (state.token) {
  setAuthed(true);
  loadTree()
    .then(() => resumeRecoveryUi())
    .catch(() => {
      /* token may be stale */
    });
}
