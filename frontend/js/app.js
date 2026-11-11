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
  'A person cannot be their own sibling.': '一个人不能认自己为兄弟姐妹。',
  'Person must belong to the same tree.': '只能认同一本家谱里的人。',
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
  /** Frozen mutation target for delete/correction confirm (DEL-7). */
  sheetOp: null,
  confirmTrigger: null,
};

const PARTIAL_SAVE_MSG = '人已记下，关系未保存';
const DISPLAY_LOAD_FAIL_MSG = '人已记下且关系已保存，但画面没有刷新成功。请再点记下或重新载入，不会重复添加。';
const CREATE_UNCERTAIN_MSG = '刚才的记下结果还不确定（可能已保存但回信丢失）。同名不会自动合并。请在下拉框明确选择一位已有亲人，或选「确认新建」；确认之前不会自动绑关系或再次新建。';
const CONFIRM_NEW_VALUE = '__confirm_new__';

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
  sheetPuhao: document.getElementById('sheet-puhao'),
  sheetSummary: document.getElementById('sheet-summary'),
  sheetDetail: document.getElementById('sheet-detail'),
  sheetConfirm: document.getElementById('sheet-confirm'),
  sheetConfirmTitle: document.getElementById('sheet-confirm-title'),
  sheetConfirmBody: document.getElementById('sheet-confirm-body'),
  sheetConfirmError: document.getElementById('sheet-confirm-error'),
  sheetConfirmActions: document.getElementById('sheet-confirm-actions'),
  correctSection: document.getElementById('correct-section'),
  correctList: document.getElementById('correct-list'),
  deleteSection: document.getElementById('delete-section'),
  deletePerson: document.getElementById('btn-delete-person'),
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

function personLabel(person) {
  if (!person) return '';
  return `${person.name}（谱号 ${person.id}）`;
}

function emptySheetOp() {
  return null;
}

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

function makeApiError(message, { status = 0, body = null, uncertain = false } = {}) {
  const err = new Error(message);
  err.name = 'ApiError';
  err.status = status;
  err.body = body;
  err.uncertain = Boolean(uncertain);
  return err;
}

function isDefiniteClientRejection(err) {
  const status = Number(err?.status || 0);
  return status === 422 || status === 401 || status === 403 || status === 404 || status === 409;
}

async function api(path, options = {}) {
  let res;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers: { ...authHeaders(), ...(options.headers || {}) },
    });
  } catch (networkErr) {
    throw makeApiError(networkErr?.message || '网络异常，结果不确定。', {
      status: 0,
      uncertain: true,
    });
  }
  if (!res.ok) {
    let detail = '没有保存成功，请再试一次。';
    let body = null;
    try {
      body = await res.json();
      detail = formatApiError(body, detail);
    } catch (_) { /* keep fallback detail */ }
    throw makeApiError(detail, {
      status: res.status,
      body,
      uncertain: false,
    });
  }
  if (res.status === 204) return null;
  try {
    return await res.json();
  } catch (_) {
    throw makeApiError('服务器回信无法解析，结果不确定。', {
      status: res.status,
      uncertain: true,
    });
  }
}

function countEdges(tree) {
  const edges = tree?.edges || [];
  return {
    nodes: (tree?.nodes || []).length,
    parent: edges.filter((e) => e.type === 'parent').length,
    spouse: edges.filter((e) => e.type === 'spouse').length,
    sibling: edges.filter((e) => e.type === 'sibling').length,
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
  const siblingStat = c.sibling
    ? `<span class="stat"><strong>${c.sibling}</strong>门兄弟姐妹</span>`
    : '';
  el.stats.innerHTML = `<span class="stat"><strong>${c.nodes}</strong>位亲人</span><span class="stat"><strong>${c.parent}</strong>门亲子</span><span class="stat"><strong>${c.spouse}</strong>对夫妻</span>${siblingStat}`;
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
    const base = gender ? `${person.name}（${gender}）` : person.name;
    const label = `${base} · 谱号 ${person.id}`;
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
  if (!rec || !state.userId || !state.treeId) return false;
  if (!rec.userId || !sameId(rec.userId, state.userId)) return false;
  // Missing tree id must not authorize applying recovery across trees.
  if (!rec.treeId || !sameId(rec.treeId, state.treeId)) return false;
  return true;
}

/**
 * MVP: one tree per user. Empty accounts never learn treeId from an empty
 * person list — fetch /trees/current so recovery/create always own a scope.
 * force=true on login so a prior session's treeId cannot stick to a new account.
 */
async function ensureCurrentTreeId({ force = false } = {}) {
  if (!state.token) return '';
  if (state.treeId && !force) return state.treeId;
  const tree = await api('/trees/current');
  if (tree?.id != null) {
    state.treeId = String(tree.id);
    localStorage.setItem(TREE_KEY, state.treeId);
  }
  return state.treeId;
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

async function loadScopedRecovery() {
  let rec = readRecoveryRaw();
  if (!rec) {
    state.recovery = null;
    return null;
  }
  // Cross-account: drop immediately. Never adopt foreign recovery.
  if (!state.userId || !rec.userId || !sameId(rec.userId, state.userId)) {
    localStorage.removeItem(RECOVERY_KEY);
    state.recovery = null;
    return null;
  }
  // Same account but empty treeId (empty-list login gap): stamp current tree
  // after ensureCurrentTreeId. MVP is one tree per user — does not weaken
  // cross-account isolation or allow cross-tree when rec.treeId is set.
  if (!rec.treeId) {
    try {
      await ensureCurrentTreeId();
    } catch (_) { /* keep trying scope check below */ }
    if (state.treeId) {
      rec = { ...rec, treeId: String(state.treeId) };
      localStorage.setItem(RECOVERY_KEY, JSON.stringify(rec));
    }
  }
  if (recoveryScopedOk(rec)) {
    state.recovery = rec;
    return rec;
  }
  localStorage.removeItem(RECOVERY_KEY);
  state.recovery = null;
  return null;
}

async function resumeRecoveryUi() {
  const rec = await loadScopedRecovery();
  if (!rec) return;
  showRecoveryGuidance();
  if (rec.kin === 'first') {
    const pending = findPerson(rec.pendingPersonId);
    if (pending) {
      // First person already exists — guide reload rather than create again.
      showError(el.sheetError, recoveryMessage(rec));
    } else if (isCreateUnresolvedPhase(rec.phase)) {
      showFirstPersonForm();
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

  // Acquire tree scope before any create/recovery — empty person list cannot supply it.
  // Force refresh so a previous account's treeId cannot remain on this session.
  await ensureCurrentTreeId({ force: true });
  await loadPersons();
  syncRootWithPersons();
  await loadTree();
  await resumeRecoveryUi();
}

async function loadTree() {
  if (!state.token) return;
  try {
    await ensureCurrentTreeId();
  } catch (_) { /* persons path may still sync later */ }
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
  if (state.selectedId && !findPerson(state.selectedId)) {
    state.selectedId = null;
  }
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

function addContextText(kinKey, anchor) {
  if (kinKey === 'first' || !anchor) {
    return '家里还没有记下亲人。先写下第一位的名字就好。';
  }
  const kin = KIN[kinKey];
  if (!kin) return `给「${anchor.name}」添一位亲人。`;
  const name = `「${anchor.name}」`;
  if (kin.relation === 'sibling') {
    return `给${name}添一位${kin.word}。会记下你们之间的兄弟姐妹关系（不改动父母）。`;
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

/**
 * Uncertain-create exit: explicit ID selection or explicit confirm-new only.
 * Never preselect / auto-adopt by name. Options are current account/tree persons only.
 */
function prepareUncertainPersonSelect(anchor) {
  if (!el.addExistingWrap || !el.addExisting) return;
  const options = [
    `<option value="">请明确选择（同名不会自动合并）</option>`,
    `<option value="${CONFIRM_NEW_VALUE}">确认新建：名单里没有我要的那位</option>`,
  ];
  for (const person of state.persons) {
    if (anchor && sameId(person.id, anchor.id)) continue;
    const gender = genderWord(person.gender);
    const base = gender ? `${person.name}（${gender}）` : person.name;
    const label = `${base} · 谱号 ${person.id}`;
    options.push(`<option value="${person.id}">${escapeHtml(label)}</option>`);
  }
  el.addExistingWrap.classList.remove('hidden');
  el.addExisting.innerHTML = options.join('');
  el.addExisting.value = '';
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
  const uncertainFirst = Boolean(rec && rec.kin === 'first' && isCreateUnresolvedPhase(rec.phase) && !rec.pendingPersonId);
  state.mode = 'add';
  state.selectedId = null;
  state.addIntent = emptyIntent({
    kin: 'first',
    pendingPersonId: canResume ? rec.pendingPersonId : null,
  });
  setKinPressed('');
  updateAnchorLabel(null);
  hideConfirmLayer();
  el.sheet.classList.remove('hidden');
  el.sheetDetail.classList.remove('hidden');
  el.formAdd.classList.remove('hidden');
  el.sheetTitle.textContent = '第一位家人';
  setPuhao(null);
  if (el.correctSection) el.correctSection.classList.add('hidden');
  if (el.deleteSection) el.deleteSection.classList.add('hidden');
  document.getElementById('sheet-kicker').textContent = '续写家谱';
  d3.select(el.canvas).selectAll('.node-card').classed('selected', false).attr('aria-pressed', 'false');
  setFirstPersonChrome(true);
  resetAddForm({ preservePending: canResume });
  state.addIntent.kin = 'first';
  if (canResume) {
    state.addIntent.pendingPersonId = rec.pendingPersonId;
    el.addName.value = rec.name || '';
    el.addExistingWrap.classList.add('hidden');
    showError(el.addError, recoveryMessage(rec));
  } else if (uncertainFirst) {
    el.addName.value = rec.name || '';
    prepareUncertainPersonSelect(null);
    showError(el.addError, recoveryMessage(rec) || CREATE_UNCERTAIN_MSG);
  } else {
    el.addExistingWrap.classList.add('hidden');
  }
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

  edges.filter((e) => e.type === 'sibling').forEach((e) => {
    const a = positions.get(e.a);
    const b = positions.get(e.b);
    if (!a || !b) return;
    const x1 = a.x + cardW / 2;
    const y1 = a.y + 18;
    const x2 = b.x + cardW / 2;
    const y2 = b.y + 18;
    const midY = Math.min(y1, y2) - 16;
    gRoot.append('path')
      .attr('class', 'edge-sibling')
      .attr('d', `M${x1},${y1} Q${(x1 + x2) / 2},${midY} ${x2},${y2}`);
  });

  const cards = gRoot.selectAll('g.node-card')
    .data(nodes, (d) => d.id)
    .join('g')
    .attr('class', (d) => `node-card${sameId(d.id, tree.root_id) ? ' root' : ''}${sameId(d.id, state.selectedId) ? ' selected' : ''}`)
    .attr('data-id', (d) => String(d.id))
    .attr('tabindex', 0)
    .attr('role', 'button')
    .attr('aria-label', (d) => `${d.name}，谱号 ${d.id}，${yearsLabel(d)}，查看小传`)
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
  const parentSlots = { father: null, mother: null };
  const live = findPerson(personId);
  if (live?.father_id != null) {
    parentSlots.father = findPerson(live.father_id) || nodesById.get(String(live.father_id)) || null;
  }
  if (live?.mother_id != null) {
    parentSlots.mother = findPerson(live.mother_id) || nodesById.get(String(live.mother_id)) || null;
  }
  // Fallback from edges when person list lacks slots (tree-only nodes).
  if (!parentSlots.father || !parentSlots.mother) {
    for (const edge of edges) {
      if (edge.type !== 'parent' || !sameId(edge.to, personId)) continue;
      const parent = nodesById.get(String(edge.from));
      if (!parent) continue;
      if (!parentSlots.father && parent.gender === 'male') parentSlots.father = parent;
      else if (!parentSlots.mother && parent.gender === 'female') parentSlots.mother = parent;
      else if (!parentSlots.father) parentSlots.father = parent;
      else if (!parentSlots.mother) parentSlots.mother = parent;
    }
  }
  const parents = [parentSlots.father, parentSlots.mother].filter(Boolean);
  const children = edges
    .filter((e) => e.type === 'parent' && sameId(e.from, personId))
    .map((e) => nodesById.get(String(e.to)))
    .filter(Boolean);
  const spouses = edges
    .filter((e) => e.type === 'spouse' && (sameId(e.a, personId) || sameId(e.b, personId)))
    .map((e) => {
      const otherId = sameId(e.a, personId) ? e.b : e.a;
      const person = nodesById.get(String(otherId)) || findPerson(otherId);
      if (!person) return null;
      return { ...person, link_id: e.link_id };
    })
    .filter(Boolean);
  return { parents, parentSlots, children, spouses };
}

function siblingsOf(personId) {
  const byId = new Map();
  const parentIds = relationsFromEdges(personId).parents.map((p) => p.id);
  if (parentIds.length > 0) {
    for (const edge of state.tree?.edges || []) {
      if (edge.type !== 'parent') continue;
      if (!parentIds.some((id) => sameId(id, edge.from))) continue;
      if (sameId(edge.to, personId)) continue;
      const person = findPerson(edge.to) || (state.tree?.nodes || []).find((n) => sameId(n.id, edge.to));
      if (!person) continue;
      const prev = byId.get(String(person.id));
      byId.set(String(person.id), {
        ...person,
        source: prev?.source === 'explicit' || prev?.source === 'both' ? 'both' : 'inferred',
        link_id: prev?.link_id ?? null,
      });
    }
  }
  for (const edge of state.tree?.edges || []) {
    if (edge.type !== 'sibling') continue;
    if (!sameId(edge.a, personId) && !sameId(edge.b, personId)) continue;
    const otherId = sameId(edge.a, personId) ? edge.b : edge.a;
    const person = findPerson(otherId) || (state.tree?.nodes || []).find((n) => sameId(n.id, otherId));
    if (!person) continue;
    const prev = byId.get(String(person.id));
    const inferred = prev?.source === 'inferred' || prev?.source === 'both';
    byId.set(String(person.id), {
      ...person,
      source: inferred ? 'both' : 'explicit',
      link_id: edge.link_id,
    });
  }
  return Array.from(byId.values());
}

function setPuhao(person) {
  if (!el.sheetPuhao) return;
  if (!person?.id) {
    el.sheetPuhao.textContent = '';
    el.sheetPuhao.classList.add('hidden');
    return;
  }
  el.sheetPuhao.textContent = `谱号 ${person.id}`;
  el.sheetPuhao.classList.remove('hidden');
}

function hideConfirmLayer() {
  if (!el.sheetConfirm) return;
  el.sheetConfirm.classList.add('hidden');
  el.sheetConfirm.hidden = true;
  el.sheetConfirm.removeAttribute('aria-busy');
  showError(el.sheetConfirmError, '');
  if (el.sheetDetail) el.sheetDetail.classList.remove('hidden');
  state.sheetOp = emptySheetOp();
}

function focusAfterConfirmClose() {
  const trigger = state.confirmTrigger;
  state.confirmTrigger = null;
  if (trigger && document.body.contains(trigger) && !trigger.disabled) {
    trigger.focus();
    return;
  }
  const selected = findPerson(state.selectedId);
  if (selected) {
    const card = el.canvas?.querySelector(`.node-card[data-id="${selected.id}"]`);
    if (card) {
      card.focus();
      return;
    }
  }
  const root = findPerson(state.rootId);
  if (root) {
    const card = el.canvas?.querySelector(`.node-card[data-id="${root.id}"]`);
    if (card) {
      card.focus();
      return;
    }
  }
  el.add?.focus();
}

function renderConfirmActions(buttons) {
  el.sheetConfirmActions.innerHTML = '';
  for (const spec of buttons) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = spec.label;
    if (spec.className) btn.className = spec.className;
    if (spec.primary) btn.dataset.confirmPrimary = '1';
    if (spec.cancel) btn.dataset.confirmCancel = '1';
    btn.disabled = Boolean(spec.disabled);
    btn.addEventListener('click', () => {
      if (typeof spec.onClick === 'function') spec.onClick();
    });
    el.sheetConfirmActions.appendChild(btn);
  }
}

function openConfirmLayer({ title, bodyHtml, actions }) {
  if (!el.sheetConfirm) return;
  el.sheetConfirmTitle.textContent = title;
  el.sheetConfirmBody.innerHTML = bodyHtml;
  showError(el.sheetConfirmError, '');
  renderConfirmActions(actions);
  el.sheetDetail.classList.add('hidden');
  el.sheetConfirm.classList.remove('hidden');
  el.sheetConfirm.hidden = false;
  el.sheet.classList.remove('hidden');
  const focusable = el.sheetConfirm.querySelector('button:not([disabled]), [href], input, select, textarea');
  (focusable || el.sheetConfirm).focus?.();
}

function setConfirmBusy(on) {
  if (!el.sheetConfirm) return;
  el.sheetConfirm.setAttribute('aria-busy', on ? 'true' : 'false');
  el.sheetConfirm.querySelectorAll('button').forEach((btn) => {
    btn.disabled = on;
    btn.classList.toggle('is-busy', on && btn.dataset.confirmPrimary === '1');
  });
}

function siblingSourceNote(sib) {
  if (sib.source === 'explicit') return '手动添加的兄弟姐妹关系记录';
  if (sib.source === 'inferred') return '因共同父母显示为兄弟姐妹';
  if (sib.source === 'both') return '手动记录；也因共同父母显示为兄弟姐妹';
  return '';
}

function renderCorrectionList(node) {
  if (!el.correctList) return;
  const rel = relationsFromEdges(node.id);
  const siblings = siblingsOf(node.id);
  const rows = [];

  const pushRow = ({ role, person, note, actionLabel, action }) => {
    rows.push({ role, person, note, actionLabel, action });
  };

  if (rel.parentSlots.father) {
    pushRow({
      role: '父亲',
      person: rel.parentSlots.father,
      actionLabel: '清空父亲栏',
      action: () => beginClearParent(node, 'father_id', rel.parentSlots.father),
    });
  }
  if (rel.parentSlots.mother) {
    pushRow({
      role: '母亲',
      person: rel.parentSlots.mother,
      actionLabel: '清空母亲栏',
      action: () => beginClearParent(node, 'mother_id', rel.parentSlots.mother),
    });
  }
  for (const spouse of rel.spouses) {
    pushRow({
      role: '配偶',
      person: spouse,
      note: '家谱中的夫妻关系记录',
      actionLabel: '解除这段关系记录',
      action: () => beginUnlinkSpouse(node, spouse),
    });
  }
  for (const sib of siblings) {
    const canUnlink = sib.link_id != null && (sib.source === 'explicit' || sib.source === 'both');
    pushRow({
      role: '兄弟姐妹',
      person: sib,
      note: siblingSourceNote(sib),
      actionLabel: canUnlink ? '移除手动添加的兄弟姐妹关系记录' : null,
      action: canUnlink ? () => beginUnlinkSibling(node, sib) : null,
    });
  }
  for (const child of rel.children) {
    pushRow({
      role: '子女',
      person: child,
      note: '若父母记错，请打开子女详情更正；不要删除真实子女。',
      actionLabel: '打开并更正记录',
      action: () => openSheet(child),
    });
  }

  if (rows.length === 0) {
    el.correctList.innerHTML = '<p class="section-hint">这位还没有可更正的父母、配偶或兄弟姐妹记录。</p>';
    return;
  }

  el.correctList.innerHTML = '';
  for (const row of rows) {
    const wrap = document.createElement('div');
    wrap.className = 'correct-row';
    const meta = document.createElement('div');
    meta.className = 'correct-meta';
    meta.innerHTML = `<strong>${escapeHtml(row.role)}</strong> · ${escapeHtml(row.person.name)}`
      + `<span class="puhao">谱号 ${escapeHtml(String(row.person.id))}</span>`
      + (row.note ? `<span class="correct-note">${escapeHtml(row.note)}</span>` : '');
    wrap.appendChild(meta);
    if (row.actionLabel && row.action) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ghost';
      btn.textContent = row.actionLabel;
      btn.addEventListener('click', (event) => {
        state.confirmTrigger = event.currentTarget;
        row.action();
      });
      wrap.appendChild(btn);
    }
    el.correctList.appendChild(wrap);
  }
}

function beginClearParent(subject, slot, counterpart) {
  const isFather = slot === 'father_id';
  const title = isFather ? '更正父亲记录' : '更正母亲记录';
  const slotWord = isFather ? '父亲栏' : '母亲栏';
  const confirmLabel = isFather ? '从父亲栏去掉' : '从母亲栏去掉';
  state.sheetOp = {
    op: isFather ? 'clear_father' : 'clear_mother',
    personId: subject.id,
    name: subject.name,
    slot,
    counterpartId: counterpart.id,
    counterpartName: counterpart.name,
    phase: 'confirm',
  };
  openConfirmLayer({
    title,
    bodyHtml: `<p class="confirm-identity">${escapeHtml(personLabel(subject))}</p>`
      + `<p>从「${escapeHtml(subject.name)}」（谱号 ${escapeHtml(String(subject.id))}）的${slotWord}去掉「${escapeHtml(counterpart.name)}」（谱号 ${escapeHtml(String(counterpart.id))}）。两位的资料都会保留。</p>`,
    actions: [
      { label: '取消', className: 'ghost', cancel: true, onClick: () => cancelConfirm() },
      {
        label: confirmLabel,
        className: 'outline-action',
        primary: true,
        onClick: () => submitSheetOp(),
      },
    ],
  });
}

function beginUnlinkSpouse(subject, spouse) {
  state.sheetOp = {
    op: 'unlink_spouse',
    personId: subject.id,
    name: subject.name,
    counterpartId: spouse.id,
    counterpartName: spouse.name,
    linkId: spouse.link_id,
    phase: 'confirm',
  };
  openConfirmLayer({
    title: '解除家谱中的夫妻关系记录',
    bodyHtml: `<p class="confirm-identity">${escapeHtml(personLabel(subject))} 与 ${escapeHtml(personLabel(spouse))}</p>`
      + '<p>只解除这两位在家谱中的这段关系记录。两位的资料都会保留。</p>',
    actions: [
      { label: '取消', className: 'ghost', cancel: true, onClick: () => cancelConfirm() },
      {
        label: '解除这段关系记录',
        className: 'outline-action',
        primary: true,
        onClick: () => submitSheetOp(),
      },
    ],
  });
}

function beginUnlinkSibling(subject, sibling) {
  state.sheetOp = {
    op: 'unlink_sibling',
    personId: subject.id,
    name: subject.name,
    counterpartId: sibling.id,
    counterpartName: sibling.name,
    linkId: sibling.link_id,
    phase: 'confirm',
  };
  openConfirmLayer({
    title: '移除手动添加的兄弟姐妹关系记录',
    bodyHtml: `<p class="confirm-identity">${escapeHtml(personLabel(subject))} 与 ${escapeHtml(personLabel(sibling))}</p>`
      + '<p>只移除这笔手动添加的兄弟姐妹关系记录。两位的资料和父母记录都不变。若双方仍有共同父母，家谱上仍会继续显示为兄弟姐妹。</p>',
    actions: [
      { label: '取消', className: 'ghost', cancel: true, onClick: () => cancelConfirm() },
      {
        label: '移除这条记录',
        className: 'outline-action',
        primary: true,
        onClick: () => submitSheetOp(),
      },
    ],
  });
}

function beginDeletePerson(subject, trigger) {
  state.confirmTrigger = trigger || el.deletePerson;
  state.sheetOp = {
    op: 'delete_person',
    personId: subject.id,
    name: subject.name,
    phase: 'confirm',
  };
  openConfirmLayer({
    title: `删除『${subject.name}』？`,
    bodyHtml: `<p class="confirm-identity">${escapeHtml(personLabel(subject))}</p>`
      + '<p>只删除这位成员及其与他人的关系记录，其他成员仍会保留。不会删除整支，也不是登记去世。</p>',
    actions: [
      { label: '取消', className: 'ghost', cancel: true, onClick: () => cancelConfirm() },
      {
        label: '确认删除此人',
        className: 'danger-solid',
        primary: true,
        onClick: () => submitSheetOp(),
      },
    ],
  });
}

function cancelConfirm() {
  const subjectId = state.sheetOp?.personId;
  hideConfirmLayer();
  const subject = findPerson(subjectId) || findPerson(state.selectedId);
  if (subject) openSheet(subject);
  else focusAfterConfirmClose();
}

async function reconcilePersonExists(personId) {
  if (!state.token || personId == null) {
    return { status: 'unknown', reason: 'no_authority' };
  }
  try {
    await api(`/persons/${personId}`);
    return { status: 'exists' };
  } catch (err) {
    const code = Number(err?.status || 0);
    if (code === 404) {
      // Ambiguous single 404 is not proof by itself; confirm via scoped list.
      try {
        await loadPersons();
        const still = state.persons.some((p) => sameId(p.id, personId));
        if (!still && state.treeId && state.userId) {
          return { status: 'absent_confirmed' };
        }
        return { status: 'unknown', reason: 'ambiguous_404' };
      } catch (_) {
        return { status: 'unknown', reason: 'list_failed' };
      }
    }
    if (code === 401 || code === 403) {
      return { status: 'unknown', reason: 'auth' };
    }
    if (err?.uncertain) {
      return { status: 'unknown', reason: 'uncertain' };
    }
    return { status: 'unknown', reason: 'error' };
  }
}

async function reconcileRelationship(op) {
  if (!op) return { status: 'unknown' };
  if (op.op === 'clear_father' || op.op === 'clear_mother') {
    try {
      const person = await api(`/persons/${op.personId}`);
      const slot = op.slot;
      const cleared = person[slot] == null || person[slot] === '';
      return { status: cleared ? 'applied' : 'pending', person };
    } catch (err) {
      if (Number(err?.status) === 404) return { status: 'unknown', reason: 'person_missing' };
      return { status: 'unknown', reason: err?.uncertain ? 'uncertain' : 'error' };
    }
  }
  if (op.op === 'unlink_spouse' || op.op === 'unlink_sibling') {
    const path = op.op === 'unlink_spouse' ? '/spouse-links' : '/sibling-links';
    try {
      const list = await api(path);
      const rows = list?.data || [];
      const still = rows.some((row) => sameId(row.id, op.linkId));
      return { status: still ? 'pending' : 'applied' };
    } catch (err) {
      return { status: 'unknown', reason: err?.uncertain ? 'uncertain' : 'error' };
    }
  }
  if (op.op === 'delete_person') {
    return reconcilePersonExists(op.personId);
  }
  return { status: 'unknown' };
}

function showUnknownResult(op, detailMessage) {
  state.sheetOp = { ...op, phase: 'unknown' };
  openConfirmLayer({
    title: '结果还不确定',
    bodyHtml: `<p>还没有把这次操作当作已经成功。正在按发出请求时的原谱号 ${escapeHtml(String(op.personId))} 核对「${escapeHtml(op.name)}」。请稍候，不要重复点击。</p>`
      + (detailMessage ? `<p>${escapeHtml(detailMessage)}</p>` : ''),
    actions: [
      {
        label: '先核对原谱号',
        className: 'secondary',
        primary: true,
        onClick: () => reconcileAndContinue(),
      },
      { label: '关闭', className: 'ghost', cancel: true, onClick: () => cancelConfirm() },
    ],
  });
}

function showDeleteBlocked409(op, body) {
  state.sheetOp = { ...op, phase: 'rejected' };
  const children = Array.isArray(body?.children) ? body.children : [];
  const listHtml = children.length
    ? `<div class="child-correct-list">${children.map((c) => (
      `<button type="button" class="ghost" data-open-child="${escapeHtml(String(c.id))}">`
      + `${escapeHtml(c.name)}（谱号 ${escapeHtml(String(c.id))}）· 打开并更正记录</button>`
    )).join('')}</div>`
    : '<p>请到相关子女详情中清空误认的父或母栏后，再对原谱号重试。</p>';
  openConfirmLayer({
    title: `还不能删除『${op.name}』`,
    bodyHtml: `<p class="confirm-identity">${escapeHtml(personLabel({ name: op.name, id: op.personId }))}</p>`
      + '<p>还有成员将这位记为父亲或母亲，若关系记错请更正对应成员记录，无需删除这些成员。还有子女记在 TA 名下，所以不能删人。</p>'
      + listHtml,
    actions: [
      { label: '关闭', className: 'ghost', cancel: true, onClick: () => cancelConfirm() },
      {
        label: '仍针对原谱号重试删除',
        className: 'danger-solid',
        primary: true,
        onClick: () => {
          const frozen = state.sheetOp;
          if (!frozen || !sameId(frozen.personId, op.personId)) return;
          beginDeletePerson({ id: frozen.personId, name: frozen.name }, state.confirmTrigger);
        },
      },
    ],
  });
  el.sheetConfirmBody.querySelectorAll('[data-open-child]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const childId = btn.getAttribute('data-open-child');
      const child = findPerson(childId);
      hideConfirmLayer();
      if (child) openSheet(child);
    });
  });
}

async function afterSuccessfulDelete(op) {
  const deletedId = op.personId;
  const wasRoot = sameId(state.rootId, deletedId);
  const wasSelected = sameId(state.selectedId, deletedId);

  if (state.recovery) {
    const pendingHit = sameId(state.recovery.pendingPersonId, deletedId);
    const anchorHit = sameId(state.recovery.anchorId, deletedId);
    if (pendingHit || anchorHit) clearRecovery();
  }

  hideConfirmLayer();
  try {
    await loadPersons();
  } catch (_) { /* continue with local sync */ }

  if (state.persons.length === 0) {
    state.selectedId = null;
    state.rootId = '';
    localStorage.removeItem(ROOT_KEY);
    state.tree = { root_id: null, nodes: [], edges: [] };
    render();
    showFirstPersonForm();
    el.add?.focus();
    return;
  }

  if (wasRoot) {
    syncRootWithPersons();
    state.selectedId = state.rootId;
  } else if (wasSelected) {
    state.selectedId = null;
  }

  try {
    await loadTree();
  } catch (err) {
    showError(el.sheetError, '删除已成功，但画面没有刷新成功。请点「重新载入」，不会再次删除。');
    focusAfterConfirmClose();
    return;
  }

  if (wasRoot) {
    const survivor = findPerson(state.rootId);
    if (survivor) {
      openSheet(survivor);
      showError(el.sheetError, `当前视角已改为「${survivor.name}」（谱号 ${survivor.id}）。`);
    }
  } else if (wasSelected) {
    closeSheet();
  } else {
    const keep = findPerson(state.selectedId);
    if (keep) openSheet(keep);
  }
  focusAfterConfirmClose();
}

async function afterSuccessfulCorrection(op) {
  const subjectId = op.personId;
  hideConfirmLayer();
  try {
    await loadTree();
  } catch (err) {
    showError(el.sheetError, '关系已更正，但画面没有刷新成功。请点「重新载入」，不要重复提交。');
    focusAfterConfirmClose();
    return;
  }
  const subject = findPerson(subjectId);
  if (subject) {
    openSheet(subject);
    if (op.op === 'unlink_sibling') {
      const still = siblingsOf(subjectId).find((s) => sameId(s.id, op.counterpartId));
      if (still && (still.source === 'inferred' || still.source === 'both')) {
        showError(el.sheetError, '手动添加的兄弟姐妹关系记录已移除。因共同父母仍显示为兄弟姐妹。');
      }
    }
  }
  focusAfterConfirmClose();
}

async function reconcileAndContinue() {
  const op = state.sheetOp;
  if (!op) return;
  setConfirmBusy(true);
  try {
    const result = await reconcileRelationship(op);
    if (op.op === 'delete_person') {
      if (result.status === 'absent_confirmed') {
        await afterSuccessfulDelete(op);
        return;
      }
      if (result.status === 'exists') {
        state.sheetOp = { ...op, phase: 'confirm' };
        showError(el.sheetConfirmError, `核对后，谱号 ${op.personId} 仍在家谱中。若要再次操作，仍针对这一谱号。`);
        openConfirmLayer({
          title: '结果还不确定',
          bodyHtml: `<p>核对后，谱号 ${escapeHtml(String(op.personId))} 仍在家谱中。若要再次操作，仍针对这一谱号。</p>`,
          actions: [
            { label: '关闭', className: 'ghost', cancel: true, onClick: () => cancelConfirm() },
            {
              label: '仍删除原谱号',
              className: 'danger-solid',
              primary: true,
              onClick: () => submitSheetOp(),
            },
          ],
        });
        return;
      }
      showUnknownResult(op, '认证失败、权限不足或单次含义不明的结果，不能当作已删除。');
      return;
    }
    if (result.status === 'applied') {
      await afterSuccessfulCorrection(op);
      return;
    }
    if (result.status === 'pending') {
      showError(el.sheetConfirmError, '核对后，原关系仍在。可对同一目标重试。');
      setConfirmBusy(false);
      return;
    }
    showUnknownResult(op, '还不能确认关系是否已更正。');
  } finally {
    setConfirmBusy(false);
  }
}

async function submitSheetOp() {
  const op = state.sheetOp;
  if (!op || op.phase === 'submitting') return;
  // Freeze snapshot at send time.
  const frozen = { ...op, phase: 'submitting' };
  state.sheetOp = frozen;
  setConfirmBusy(true);
  showError(el.sheetConfirmError, '');

  try {
    if (frozen.op === 'delete_person') {
      await api(`/persons/${frozen.personId}`, { method: 'DELETE' });
      await afterSuccessfulDelete(frozen);
      return;
    }
    if (frozen.op === 'clear_father' || frozen.op === 'clear_mother') {
      await api(`/persons/${frozen.personId}`, {
        method: 'PATCH',
        body: JSON.stringify({ [frozen.slot]: null }),
      });
      await afterSuccessfulCorrection(frozen);
      return;
    }
    if (frozen.op === 'unlink_spouse') {
      await api(`/spouse-links/${frozen.linkId}`, { method: 'DELETE' });
      await afterSuccessfulCorrection(frozen);
      return;
    }
    if (frozen.op === 'unlink_sibling') {
      await api(`/sibling-links/${frozen.linkId}`, { method: 'DELETE' });
      await afterSuccessfulCorrection(frozen);
      return;
    }
  } catch (err) {
    if (frozen.op === 'delete_person' && Number(err?.status) === 409) {
      showDeleteBlocked409(frozen, err.body);
      return;
    }
    if (isDefiniteClientRejection(err) && Number(err?.status) !== 404) {
      state.sheetOp = { ...frozen, phase: 'rejected' };
      showError(el.sheetConfirmError, err.message || '没有保存成功，请再试一次。');
      setConfirmBusy(false);
      el.sheetConfirm.querySelectorAll('button').forEach((btn) => {
        btn.disabled = false;
        btn.classList.remove('is-busy');
      });
      return;
    }
    // Network / timeout / parse / ambiguous 404 → unknown; do not claim success.
    showUnknownResult(frozen, err?.message || '');
    return;
  } finally {
    setConfirmBusy(false);
  }
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
  hideConfirmLayer();
  el.sheetDetail.classList.remove('hidden');
  el.sheet.classList.remove('hidden');
  el.formAdd.classList.add('hidden');
  setFirstPersonChrome(false);
  setKinPressed('');
  updateAnchorLabel(node);
  el.sheetTitle.textContent = node.name;
  setPuhao(node);
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
  renderCorrectionList(node);
  if (el.deleteSection) el.deleteSection.classList.remove('hidden');
  if (el.correctSection) el.correctSection.classList.remove('hidden');
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
  hideConfirmLayer();
  el.formAdd.classList.add('hidden');
  setKinPressed('');
  setFirstPersonChrome(false);
  updateAnchorLabel(null);
  setPuhao(null);
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
    if (sameId(liveAnchor.id, liveTarget.id)) {
      throw new Error('一个人不能认自己为兄弟姐妹。');
    }
    await api('/sibling-links', {
      method: 'POST',
      body: JSON.stringify({
        person_a_id: Number(liveAnchor.id),
        person_b_id: Number(liveTarget.id),
      }),
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
    let parentRole = '';
    if (relation === 'child') {
      parentRole = childParentRole(anchor) || state.recovery?.parentRole || '';
      if (parentRole !== 'father' && parentRole !== 'mother') {
        showError(el.addError, `还不确定「${anchor.name}」是父亲还是母亲，请先选择后再添孩子。`);
        return;
      }
      state.addIntent.parentRole = parentRole;
    }

    const selectRaw = el.addExisting && !el.addExistingWrap.classList.contains('hidden')
      ? el.addExisting.value
      : '';
    const confirmNew = selectRaw === CONFIRM_NEW_VALUE;
    const existingId = confirmNew ? '' : selectRaw;

    if (existingId) {
      let existing = findPerson(existingId);
      if (!existing) existing = await fetchPersonById(existingId);
      if (!existing) {
        showError(el.addError, '请重新选择已经在谱里的那位亲人。');
        return;
      }
      // Explicit ID choice only — never inferred from name.
      if (!isFirst) {
        if (relation === 'father') ensureParentSlot(anchor, 'father_id', existing.id);
        if (relation === 'mother') ensureParentSlot(anchor, 'mother_id', existing.id);
        await bindPerson(existing, relation, anchor);
      } else {
        state.rootId = String(existing.id);
        localStorage.setItem(ROOT_KEY, state.rootId);
      }
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
    } else if (isCreateUnresolvedPhase(phase) && !confirmNew) {
      // NO name-based adopt/merge. Require explicit existing ID or confirm-new.
      try {
        await loadPersons();
      } catch (_) { /* still require explicit choice */ }
      prepareUncertainPersonSelect(anchor);
      const named = (state.recovery?.name || el.addName.value.trim() || '').trim();
      writeRecovery(buildRecoveryDraft({
        target: null,
        kinKey,
        relation,
        anchor,
        parentRole,
        name: named,
        phase: 'create_uncertain',
        message: CREATE_UNCERTAIN_MSG,
        clientOpId,
      }));
      state.mode = 'add';
      el.formAdd.classList.remove('hidden');
      showError(el.addError, CREATE_UNCERTAIN_MSG);
      showError(el.sheetError, CREATE_UNCERTAIN_MSG);
      return;
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
      // Ensure tree scope before durable inflight — empty list login cannot invent it.
      try {
        await ensureCurrentTreeId();
      } catch (scopeErr) {
        showError(el.addError, scopeErr.message || '还没拿到本谱编号，请重新登录后再试。');
        return;
      }
      if (!state.treeId) {
        showError(el.addError, '还没拿到本谱编号，请重新登录后再试。');
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
        if (isDefiniteClientRejection(createErr)) {
          // Definite validation/auth rejection: not "maybe saved". Allow corrected resubmit.
          clearRecovery();
          state.addIntent.pendingPersonId = null;
          state.mode = 'add';
          el.formAdd.classList.remove('hidden');
          showError(el.addError, createErr.message || '没有保存成功，请改一改再试。');
          showError(el.sheetError, '');
          return;
        }
        // Network / parse / unknown outcome — do not clear; no auto POST; no name adopt.
        try {
          await loadPersons();
          await ensureCurrentTreeId();
        } catch (_) { /* keep going to persist uncertain */ }
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
        prepareUncertainPersonSelect(anchor);
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
el.deletePerson?.addEventListener('click', (event) => {
  const person = findPerson(state.selectedId);
  if (!person) return;
  beginDeletePerson(person, event.currentTarget);
});
el.kinGrid.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-kin]');
  if (!button) return;
  startAddForKin(button.dataset.kin);
});
el.addExisting?.addEventListener('change', () => {
  const val = el.addExisting.value;
  const usingExisting = Boolean(val) && val !== CONFIRM_NEW_VALUE;
  el.addName.required = !usingExisting;
  if (usingExisting) {
    const label = el.addExisting.selectedOptions[0]?.textContent || '';
    el.addName.value = label.split('（')[0].split('·')[0].split('#')[0].trim() || el.addName.value;
  }
});
el.addParentRole?.addEventListener('change', () => {
  state.addIntent.parentRole = el.addParentRole.value || '';
});
el.formAdd.addEventListener('submit', (event) => submitAdd(event));
document.addEventListener('keydown', (event) => {
  if (!el.sheetConfirm || el.sheetConfirm.classList.contains('hidden')) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    cancelConfirm();
    return;
  }
  if (event.key !== 'Tab') return;
  const focusables = Array.from(
    el.sheetConfirm.querySelectorAll('button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'),
  ).filter((node) => !node.hasAttribute('disabled') && node.offsetParent !== null);
  if (focusables.length === 0) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
});
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
