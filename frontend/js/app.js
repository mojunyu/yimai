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
};

const state = {
  token: localStorage.getItem(TOKEN_KEY) || '',
  rootId: localStorage.getItem(ROOT_KEY) || '',
  tree: null,
  persons: [],
  selectedId: null,
  mode: 'detail',
  addIntent: { relation: '', anchorId: null },
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
  formParents: document.getElementById('form-parents'),
  formSpouse: document.getElementById('form-spouse'),
  closeSheet: document.getElementById('btn-close-sheet'),
  cancelAdd: document.getElementById('btn-cancel-add'),
  setRoot: document.getElementById('btn-set-root'),
  addFather: document.getElementById('btn-add-father'),
  addMother: document.getElementById('btn-add-mother'),
  addSpouse: document.getElementById('btn-add-spouse'),
  addChild: document.getElementById('btn-add-child'),
  addName: document.getElementById('add-name'),
  addGender: document.getElementById('add-gender'),
  addBirthYear: document.getElementById('add-birth-year'),
  addDeathYear: document.getElementById('add-death-year'),
  addContext: document.getElementById('add-context'),
  addRelationWrap: document.getElementById('add-relation-wrap'),
  addAnchor: document.getElementById('add-anchor'),
  addRelation: document.getElementById('add-relation'),
  addParentRoleWrap: document.getElementById('add-parent-role-wrap'),
  addParentRole: document.getElementById('add-parent-role'),
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
  el.stats.textContent = `这本家谱里现有 ${c.nodes} 位亲人，${c.parent} 门亲子，${c.spouse} 对夫妻`;
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

function spouseButtonLabel(person) {
  if (person?.gender === 'male') return '添妻子';
  if (person?.gender === 'female') return '添丈夫';
  return '添配偶';
}

function generationFor(relation, anchor) {
  const current = Number(anchor?.generation) || 1;
  if (relation === 'father' || relation === 'mother') return Math.max(1, current - 1);
  if (relation === 'child') return current + 1;
  if (relation === 'spouse') return current;
  return 1;
}

function defaultGenderFor(relation, anchor) {
  if (relation === 'father') return 'male';
  if (relation === 'mother') return 'female';
  if (relation === 'spouse' && anchor?.gender === 'male') return 'female';
  if (relation === 'spouse' && anchor?.gender === 'female') return 'male';
  return 'unknown';
}

function childParentRole(anchor) {
  if (anchor?.gender === 'female') return 'mother';
  if (anchor?.gender === 'male') return 'father';
  return el.addParentRole.value || 'father';
}

function updateParentRoleVisibility() {
  const relation = state.addIntent.relation || el.addRelation.value;
  const anchor = findPerson(state.addIntent.anchorId || el.addAnchor.value);
  const needChoice = relation === 'child' && anchor && !anchor.gender || relation === 'child' && anchor?.gender === 'unknown';
  el.addParentRoleWrap.classList.toggle('hidden', !needChoice);
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
    if (!res.ok) throw new Error('账号或密码不对，请再试一次。');
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
  state.rootId = String(state.tree.root_id);
  localStorage.setItem(ROOT_KEY, state.rootId);
  render();
  if (state.selectedId && state.mode === 'detail') {
    const person = findPerson(state.selectedId);
    if (person) openSheet(person);
  }
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
  setAuthed(Boolean(state.token));

  const svg = d3.select(el.canvas);
  svg.selectAll('*').remove();

  const wrap = el.canvas.parentElement;
  const width = wrap.clientWidth || 800;
  const height = wrap.clientHeight || 600;
  svg.attr('viewBox', `0 0 ${width} ${height}`);

  wrap.querySelectorAll('.legend').forEach((n) => n.remove());
  if (nodes.length === 0) return;

  const legend = document.createElement('div');
  legend.className = 'legend';
  legend.textContent = '实线是父母与子女，虚线是夫妻。点名字可以查看、添亲人。';
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
    .attr('class', (d) => `node-card${sameId(d.id, tree.root_id) ? ' root' : ''}`)
    .attr('transform', (d) => {
      const p = positions.get(d.id);
      return `translate(${p.x},${p.y})`;
    })
    .style('cursor', 'pointer')
    .on('click', (event, d) => {
      event.stopPropagation();
      openSheet(findPerson(d.id) || d);
    });

  cards.append('rect').attr('width', cardW).attr('height', cardH).attr('rx', 6);
  cards.append('text')
    .attr('x', 10)
    .attr('y', 22)
    .attr('font-size', 14)
    .attr('font-weight', 600)
    .text((d) => {
      const g = genderGlyph(d.gender);
      return g ? `${d.name}  ${g}` : d.name;
    });
  cards.append('text')
    .attr('class', 'meta')
    .attr('x', 10)
    .attr('y', 42)
    .text((d) => yearsLabel(d));

  if (state.selectedId && state.mode === 'detail') {
    const sel = findPerson(state.selectedId);
    if (sel) openSheet(sel);
  }
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

function addContextText(relation, anchor) {
  if (!anchor) return '先把这位亲人的名字记下来。若已经知道和家里谁有关系，也可以一起选上。';
  const name = `「${anchor.name}」`;
  if (relation === 'father') return `给${name}添一位父亲。`;
  if (relation === 'mother') return `给${name}添一位母亲。`;
  if (relation === 'spouse' && anchor.gender === 'male') return `给${name}添一位妻子。`;
  if (relation === 'spouse' && anchor.gender === 'female') return `给${name}添一位丈夫。`;
  if (relation === 'spouse') return `给${name}添一位配偶。`;
  if (relation === 'child') return `给${name}添一个孩子。`;
  return `给${name}添一位亲人。`;
}

function showAddForm({ relation = '', anchor = null, chooseRelation = false } = {}) {
  if (!state.token) {
    alert('请先登录，再给家里添人。');
    return;
  }
  state.mode = 'add';
  state.selectedId = null;
  state.addIntent = { relation, anchorId: anchor ? anchor.id : null };
  el.sheet.classList.remove('hidden');
  el.sheetDetail.classList.add('hidden');
  el.formAdd.classList.remove('hidden');
  el.sheetTitle.textContent = '添一位家人';
  el.formAdd.reset();
  el.addGender.value = defaultGenderFor(relation, anchor);
  el.addContext.textContent = addContextText(relation, anchor);
  showError(el.addError, '');

  if (chooseRelation) {
    el.addRelationWrap.classList.remove('hidden');
    fillPersonSelect(el.addAnchor, {
      excludeId: null,
      emptyLabel: '先不选，只把人记下',
      selectedId: anchor?.id || '',
    });
    el.addRelation.value = relation;
  } else {
    el.addRelationWrap.classList.add('hidden');
  }
  updateParentRoleVisibility();
}

function openSheet(node) {
  state.mode = 'detail';
  state.selectedId = node.id;
  el.formAdd.classList.add('hidden');
  el.sheetDetail.classList.remove('hidden');
  el.sheet.classList.remove('hidden');
  el.sheetTitle.textContent = node.name;
  el.setRoot.textContent = `从「${node.name}」看这棵家谱`;
  el.addSpouse.textContent = spouseButtonLabel(node);
  showError(el.sheetError, '');

  const rel = relationsFromEdges(node.id);
  const gender = genderWord(node.gender);
  const intro = gender
    ? `${escapeHtml(node.name)}，${gender}。${lifeSentence(node)}。`
    : `${escapeHtml(node.name)}。${lifeSentence(node)}。`;
  const parentsLine = rel.parents.length ? `父母是${namesOf(rel.parents)}。` : '父母还没有记下。';
  const spouseLine = rel.spouses.length ? `配偶是${namesOf(rel.spouses)}。` : '配偶还没有记下。';
  const childLine = rel.children.length ? `子女有${namesOf(rel.children)}。` : '子女还没有记下。';
  el.sheetSummary.innerHTML = `<p>${intro}</p><p class="muted">${parentsLine}${spouseLine}${childLine}</p>`;
  el.setRoot.dataset.personId = String(node.id);

  const record = findPerson(node.id) || {};
  fillPersonSelect(el.fatherId, {
    excludeId: node.id,
    emptyLabel: '先不选',
    selectedId: record.father_id,
  });
  fillPersonSelect(el.motherId, {
    excludeId: node.id,
    emptyLabel: '先不选',
    selectedId: record.mother_id,
  });
  fillPersonSelect(el.spouseId, {
    excludeId: node.id,
    emptyLabel: '请选择家里的人',
    selectedId: '',
  });
  el.spouseStart.value = '';
  el.spouseEnd.value = '';
}

function closeSheet() {
  state.selectedId = null;
  state.mode = 'detail';
  state.addIntent = { relation: '', anchorId: null };
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

function currentAddIntent() {
  if (el.addRelationWrap.classList.contains('hidden')) {
    return { relation: state.addIntent.relation, anchor: findPerson(state.addIntent.anchorId) };
  }
  return { relation: el.addRelation.value, anchor: findPerson(el.addAnchor.value) };
}

async function bindNewPerson(created, relation, anchor) {
  if (!relation || !anchor) return;
  if (relation === 'father') {
    await api(`/persons/${anchor.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ father_id: created.id }),
    });
    return;
  }
  if (relation === 'mother') {
    await api(`/persons/${anchor.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ mother_id: created.id }),
    });
    return;
  }
  if (relation === 'spouse') {
    await api('/spouse-links', {
      method: 'POST',
      body: JSON.stringify({
        person_a_id: Number(anchor.id),
        person_b_id: Number(created.id),
      }),
    });
    return;
  }
  if (relation === 'child') {
    const role = childParentRole(anchor);
    const payload = role === 'mother'
      ? { mother_id: Number(anchor.id) }
      : { father_id: Number(anchor.id) };
    await api(`/persons/${created.id}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    });
  }
}

async function submitAdd(event) {
  event.preventDefault();
  showError(el.addError, '');
  const { relation, anchor } = currentAddIntent();
  const payload = {
    name: el.addName.value.trim(),
    gender: el.addGender.value,
    generation: generationFor(relation, anchor),
    birth_year: optionalInt(el.addBirthYear.value),
    death_year: optionalInt(el.addDeathYear.value),
  };
  if (!payload.name) {
    showError(el.addError, '请先写下这位亲人的名字。');
    return;
  }
  try {
    const created = await api('/persons', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    try {
      await bindNewPerson(created, relation, anchor);
    } catch (bindErr) {
      showError(el.addError, `人已经记下了，但亲疏关系没有保存：${bindErr.message}`);
      if (!state.rootId) {
        state.rootId = String(created.id);
        localStorage.setItem(ROOT_KEY, state.rootId);
      }
      await loadTree();
      openSheet(findPerson(created.id) || created);
      return;
    }
    if (!state.rootId) {
      state.rootId = String(created.id);
      localStorage.setItem(ROOT_KEY, state.rootId);
    }
    await loadTree();
    openSheet(findPerson(created.id) || created);
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
    showError(el.sheetError, '请先选择要结为夫妻的那位家人。');
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

function startAddFor(relation) {
  const anchor = findPerson(state.selectedId);
  if (!anchor) return;
  showAddForm({ relation, anchor, chooseRelation: false });
}

el.login.addEventListener('click', () => login().catch((e) => alert(e.message)));
el.reload.addEventListener('click', () => loadTree().catch((e) => alert(e.message)));
el.add.addEventListener('click', () => showAddForm({ chooseRelation: true }));
el.cancelAdd.addEventListener('click', closeSheet);
el.closeSheet.addEventListener('click', closeSheet);
el.setRoot.addEventListener('click', () => setAsRoot().catch((e) => alert(e.message)));
el.addFather.addEventListener('click', () => startAddFor('father'));
el.addMother.addEventListener('click', () => startAddFor('mother'));
el.addSpouse.addEventListener('click', () => startAddFor('spouse'));
el.addChild.addEventListener('click', () => startAddFor('child'));
el.addAnchor.addEventListener('change', updateParentRoleVisibility);
el.addRelation.addEventListener('change', () => {
  const anchor = findPerson(el.addAnchor.value);
  const relation = el.addRelation.value;
  state.addIntent = { relation, anchorId: anchor ? anchor.id : null };
  el.addContext.textContent = addContextText(relation, anchor);
  if (relation) el.addGender.value = defaultGenderFor(relation, anchor);
  updateParentRoleVisibility();
});
el.formAdd.addEventListener('submit', (event) => submitAdd(event));
el.formParents.addEventListener('submit', (event) => submitParents(event));
el.formSpouse.addEventListener('submit', (event) => submitSpouse(event));
window.addEventListener('resize', () => {
  if (state.tree) render();
});

if (state.token) {
  setAuthed(true);
  loadTree().catch(() => {
    /* token may be stale */
  });
}
