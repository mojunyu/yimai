/**
 * 一脉 AC-4 frontend
 * Consumes ONLY GET /api/v1/persons/{id}/tree JSON for the canvas.
 * Does NOT invent parent/spouse edges client-side.
 *
 * Interaction defaults (Boss):
 * - Click node → open sheet (does NOT change root)
 * - Explicit「设为根」to change root and refetch
 * - 「添加成员」and bind forms call the existing API, then refetch the tree
 */

const API_BASE = `${window.location.origin}/api/v1`;
const TOKEN_KEY = 'yimai_token';
const ROOT_KEY = 'yimai_root_id';

const ERROR_ZH = {
  'Parent assignment would create a cycle.': '这样绑定父母会形成循环，未保存。',
  'A person cannot be their own parent.': '不能把成员设为自己的父母。',
  'Parent must belong to the same tree.': '父母必须是同一棵树上的成员。',
  'A person cannot be their own spouse.': '不能把成员设为自己的配偶。',
  'Person must belong to the same tree.': '配偶必须是同一棵树上的成员。',
  'An open spouse link already exists for this pair.': '这两人已有未结束的配偶关系。',
  'death_year must be greater than or equal to birth_year.': '卒年不能早于生年。',
  'end_year must be greater than or equal to start_year.': '结束年不能早于开始年。',
};

const state = {
  token: localStorage.getItem(TOKEN_KEY) || '',
  rootId: localStorage.getItem(ROOT_KEY) || '',
  tree: null, // { root_id, nodes, edges }
  persons: [],
  selectedId: null,
  mode: 'detail', // detail | add
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
  sheetBody: document.getElementById('sheet-body'),
  sheetDetail: document.getElementById('sheet-detail'),
  formAdd: document.getElementById('form-add'),
  formParents: document.getElementById('form-parents'),
  formSpouse: document.getElementById('form-spouse'),
  closeSheet: document.getElementById('btn-close-sheet'),
  cancelAdd: document.getElementById('btn-cancel-add'),
  setRoot: document.getElementById('btn-set-root'),
  addName: document.getElementById('add-name'),
  addGender: document.getElementById('add-gender'),
  addGeneration: document.getElementById('add-generation'),
  addBirthYear: document.getElementById('add-birth-year'),
  addDeathYear: document.getElementById('add-death-year'),
  addError: document.getElementById('add-error'),
  fatherId: document.getElementById('father-id'),
  motherId: document.getElementById('mother-id'),
  spouseId: document.getElementById('spouse-id'),
  spouseStart: document.getElementById('spouse-start'),
  spouseEnd: document.getElementById('spouse-end'),
  sheetError: document.getElementById('sheet-error'),
};

function authHeaders() {
  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Authorization: `Bearer ${state.token}`,
  };
}

function translateError(text) {
  if (!text) return '请求失败';
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
    let detail = `${res.status}: ${res.statusText}`;
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

/** Exported for browser console verification against API JSON. */
window.yimaiCountTree = countEdges;

function updateStats() {
  const c = countEdges(state.tree);
  el.stats.textContent = `root=${state.tree?.root_id ?? '—'} · nodes: ${c.nodes} · parent: ${c.parent} · spouse: ${c.spouse}`;
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

function fillPersonSelect(selectEl, { excludeId, emptyLabel, selectedId }) {
  const options = [`<option value="">${escapeHtml(emptyLabel)}</option>`];
  for (const person of state.persons) {
    if (excludeId != null && String(person.id) === String(excludeId)) continue;
    const selected = String(person.id) === String(selectedId ?? '') ? ' selected' : '';
    options.push(`<option value="${person.id}"${selected}>${escapeHtml(person.name)} (#${person.id})</option>`);
  }
  selectEl.innerHTML = options.join('');
}

async function loadPersons() {
  if (!state.token) {
    state.persons = [];
    return;
  }
  const list = await api('/persons');
  state.persons = list.data || [];
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
    if (!res.ok) throw new Error(`登录失败：${res.status}`);
    return res.json();
  });

  state.token = data.token;
  localStorage.setItem(TOKEN_KEY, state.token);
  setAuthed(true);

  await loadPersons();
  if (!state.rootId && state.persons[0]) {
    state.rootId = String(state.persons[0].id);
    localStorage.setItem(ROOT_KEY, state.rootId);
  }

  await loadTree();
}

async function loadTree() {
  if (!state.token) return;
  await loadPersons();
  if (!state.rootId) {
    state.tree = { root_id: null, nodes: [], edges: [] };
    render();
    return;
  }

  state.tree = await api(`/persons/${state.rootId}/tree`);
  // Trust server root_id
  state.rootId = String(state.tree.root_id);
  localStorage.setItem(ROOT_KEY, state.rootId);
  render();
  if (state.selectedId && state.mode === 'detail') {
    const person = state.persons.find((p) => String(p.id) === String(state.selectedId));
    if (person) openSheet(person);
  }
}

function genderGlyph(gender) {
  if (gender === 'male') return '♂';
  if (gender === 'female') return '♀';
  return '?';
}

function yearsLabel(node) {
  const b = node.birth_year ?? '?';
  const d = node.death_year == null ? '在世' : String(node.death_year);
  return `${b}–${d}`;
}

/**
 * Layout: group by generation, pack horizontally.
 * Edges drawn ONLY from tree.edges — no inferred links.
 */
function render() {
  updateStats();
  const tree = state.tree;
  const nodes = tree?.nodes || [];
  const edges = tree?.edges || [];

  el.empty.classList.toggle('hidden', nodes.length > 0);
  setAuthed(Boolean(state.token));

  const svg = d3.select(el.canvas);
  svg.selectAll('*').remove();

  const wrap = el.canvas.parentElement;
  const width = wrap.clientWidth || 800;
  const height = wrap.clientHeight || 600;
  svg.attr('viewBox', `0 0 ${width} ${height}`);

  if (nodes.length === 0) return;

  // legend
  const legend = document.createElement('div');
  legend.className = 'legend';
  legend.innerHTML = '实线 = parent · 虚线 = spouse · 单击开面板 · 「设为根」换 root';
  wrap.querySelectorAll('.legend').forEach((n) => n.remove());
  wrap.appendChild(legend);

  const byGen = d3.group(nodes, (d) => d.generation);
  const gens = Array.from(byGen.keys()).sort((a, b) => a - b);
  const cardW = 140;
  const cardH = 56;
  const yGap = Math.max(100, Math.min(140, (height - 80) / Math.max(gens.length, 1)));
  const positions = new Map();

  gens.forEach((g, gi) => {
    const row = byGen.get(g);
    const y = 48 + gi * yGap;
    const gap = Math.min(48, (width - 40 - row.length * cardW) / Math.max(row.length + 1, 1));
    const totalW = row.length * cardW + (row.length - 1) * Math.max(gap, 24);
    let x = Math.max(20, (width - totalW) / 2);
    row.forEach((n) => {
      positions.set(n.id, { x, y, node: n });
      x += cardW + Math.max(gap, 24);
    });
  });

  const gRoot = svg.append('g').attr('class', 'scene');

  // parent edges
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

  // spouse edges
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
    .attr('class', (d) => `node-card${String(d.id) === String(tree.root_id) ? ' root' : ''}`)
    .attr('transform', (d) => {
      const p = positions.get(d.id);
      return `translate(${p.x},${p.y})`;
    })
    .style('cursor', 'pointer')
    .on('click', (event, d) => {
      event.stopPropagation();
      const person = state.persons.find((p) => String(p.id) === String(d.id)) || d;
      openSheet(person);
    });

  cards.append('rect').attr('width', cardW).attr('height', cardH).attr('rx', 6);
  cards.append('text')
    .attr('x', 10)
    .attr('y', 22)
    .attr('font-size', 14)
    .attr('font-weight', 600)
    .text((d) => `${d.name} ${genderGlyph(d.gender)}`);
  cards.append('text')
    .attr('class', 'meta')
    .attr('x', 10)
    .attr('y', 42)
    .text((d) => `G${d.generation} · ${yearsLabel(d)}`);

  if (state.selectedId && state.mode === 'detail') {
    const sel = state.persons.find((n) => String(n.id) === String(state.selectedId))
      || nodes.find((n) => String(n.id) === String(state.selectedId));
    if (sel) openSheet(sel);
  }
}

function relationsFromEdges(personId) {
  const edges = state.tree?.edges || [];
  const nodesById = new Map((state.tree?.nodes || []).map((n) => [n.id, n]));
  const parents = edges
    .filter((e) => e.type === 'parent' && e.to === personId)
    .map((e) => nodesById.get(e.from))
    .filter(Boolean);
  const children = edges
    .filter((e) => e.type === 'parent' && e.from === personId)
    .map((e) => nodesById.get(e.to))
    .filter(Boolean);
  const spouses = edges
    .filter((e) => e.type === 'spouse' && (e.a === personId || e.b === personId))
    .map((e) => nodesById.get(e.a === personId ? e.b : e.a))
    .filter(Boolean);
  return { parents, children, spouses };
}

function showAddForm() {
  if (!state.token) {
    alert('请先登录');
    return;
  }
  state.mode = 'add';
  state.selectedId = null;
  el.sheet.classList.remove('hidden');
  el.sheetDetail.classList.add('hidden');
  el.formAdd.classList.remove('hidden');
  el.sheetTitle.textContent = '添加成员';
  el.formAdd.reset();
  el.addGeneration.value = '1';
  el.addGender.value = 'unknown';
  showError(el.addError, '');
}

function openSheet(node) {
  state.mode = 'detail';
  state.selectedId = node.id;
  el.formAdd.classList.add('hidden');
  el.sheetDetail.classList.remove('hidden');
  el.sheet.classList.remove('hidden');
  el.sheetTitle.textContent = node.name;
  showError(el.sheetError, '');
  const rel = relationsFromEdges(node.id);
  const rows = [
    ['ID', node.id],
    ['性别', node.gender],
    ['世代', node.generation],
    ['生年', node.birth_year ?? '—'],
    ['卒年', node.death_year == null ? '在世' : node.death_year],
    ['父母', rel.parents.map((p) => p.name).join('、') || '—'],
    ['配偶', rel.spouses.map((p) => p.name).join('、') || '—'],
    ['子女', rel.children.map((p) => p.name).join('、') || '—'],
  ];
  el.sheetBody.innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${escapeHtml(v)}</dd>`).join('');
  el.setRoot.dataset.personId = String(node.id);

  const record = state.persons.find((p) => String(p.id) === String(node.id)) || {};
  fillPersonSelect(el.fatherId, {
    excludeId: node.id,
    emptyLabel: '未绑定',
    selectedId: record.father_id,
  });
  fillPersonSelect(el.motherId, {
    excludeId: node.id,
    emptyLabel: '未绑定',
    selectedId: record.mother_id,
  });
  fillPersonSelect(el.spouseId, {
    excludeId: node.id,
    emptyLabel: '选择配偶',
    selectedId: '',
  });
  el.spouseStart.value = '';
  el.spouseEnd.value = '';
}

function closeSheet() {
  state.selectedId = null;
  state.mode = 'detail';
  el.sheet.classList.add('hidden');
  el.formAdd.classList.add('hidden');
  el.sheetDetail.classList.remove('hidden');
  showError(el.addError, '');
  showError(el.sheetError, '');
}

async function setAsRoot() {
  const id = el.setRoot.dataset.personId;
  if (!id) return;
  state.rootId = id;
  localStorage.setItem(ROOT_KEY, id);
  await loadTree();
}

async function submitAdd(event) {
  event.preventDefault();
  showError(el.addError, '');
  const payload = {
    name: el.addName.value.trim(),
    gender: el.addGender.value,
    generation: optionalInt(el.addGeneration.value) ?? 1,
    birth_year: optionalInt(el.addBirthYear.value),
    death_year: optionalInt(el.addDeathYear.value),
  };
  if (!payload.name) {
    showError(el.addError, '请填写姓名');
    return;
  }
  try {
    const created = await api('/persons', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    if (!state.rootId) {
      state.rootId = String(created.id);
      localStorage.setItem(ROOT_KEY, state.rootId);
    }
    await loadTree();
    const fresh = state.persons.find((p) => String(p.id) === String(created.id)) || created;
    openSheet(fresh);
  } catch (err) {
    showError(el.addError, err.message);
  }
}

async function submitParents(event) {
  event.preventDefault();
  showError(el.sheetError, '');
  const id = state.selectedId;
  if (!id) return;
  const payload = {
    father_id: optionalInt(el.fatherId.value),
    mother_id: optionalInt(el.motherId.value),
  };
  try {
    await api(`/persons/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    });
    await loadTree();
  } catch (err) {
    showError(el.sheetError, err.message);
  }
}

async function submitSpouse(event) {
  event.preventDefault();
  showError(el.sheetError, '');
  const id = state.selectedId;
  const spouseId = optionalInt(el.spouseId.value);
  if (!id) return;
  if (!spouseId) {
    showError(el.sheetError, '请先选择要绑定的配偶');
    return;
  }
  const payload = {
    person_a_id: Number(id),
    person_b_id: spouseId,
    start_year: optionalInt(el.spouseStart.value),
    end_year: optionalInt(el.spouseEnd.value),
  };
  try {
    await api('/spouse-links', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    await loadTree();
  } catch (err) {
    showError(el.sheetError, err.message);
  }
}

el.login.addEventListener('click', () => login().catch((e) => alert(e.message)));
el.reload.addEventListener('click', () => loadTree().catch((e) => alert(e.message)));
el.add.addEventListener('click', showAddForm);
el.cancelAdd.addEventListener('click', closeSheet);
el.closeSheet.addEventListener('click', closeSheet);
el.setRoot.addEventListener('click', () => setAsRoot().catch((e) => alert(e.message)));
el.formAdd.addEventListener('submit', (event) => submitAdd(event));
el.formParents.addEventListener('submit', (event) => submitParents(event));
el.formSpouse.addEventListener('submit', (event) => submitSpouse(event));
window.addEventListener('resize', () => {
  if (state.tree) render();
});

// Auto-load if token already present
if (state.token) {
  setAuthed(true);
  loadTree().catch(() => {
    /* token may be stale */
  });
}
