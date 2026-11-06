/**
 * 一脉 AC-4 frontend
 * Consumes ONLY GET /api/v1/persons/{id}/tree JSON.
 * Does NOT invent parent/spouse edges client-side.
 *
 * Interaction defaults (Boss):
 * - Click node → open sheet (does NOT change root)
 * - Explicit「设为根」to change root and refetch
 */

const API_BASE = `${window.location.origin}/api/v1`;
const TOKEN_KEY = 'yimai_token';
const ROOT_KEY = 'yimai_root_id';

const state = {
  token: localStorage.getItem(TOKEN_KEY) || '',
  rootId: localStorage.getItem(ROOT_KEY) || '',
  tree: null, // { root_id, nodes, edges }
  selectedId: null,
};

const el = {
  email: document.getElementById('email'),
  password: document.getElementById('password'),
  login: document.getElementById('btn-login'),
  reload: document.getElementById('btn-reload'),
  stats: document.getElementById('stats'),
  empty: document.getElementById('empty'),
  canvas: document.getElementById('tree-canvas'),
  sheet: document.getElementById('sheet'),
  sheetTitle: document.getElementById('sheet-title'),
  sheetBody: document.getElementById('sheet-body'),
  closeSheet: document.getElementById('btn-close-sheet'),
  setRoot: document.getElementById('btn-set-root'),
};

function authHeaders() {
  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Authorization: `Bearer ${state.token}`,
  };
}

async function api(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: { ...authHeaders(), ...(options.headers || {}) },
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      detail = body.message || JSON.stringify(body);
    } catch (_) { /* ignore */ }
    throw new Error(`${res.status}: ${detail}`);
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
    if (!res.ok) throw new Error(`login failed: ${res.status}`);
    return res.json();
  });

  state.token = data.token;
  localStorage.setItem(TOKEN_KEY, state.token);
  el.reload.disabled = false;

  // Prefer stored root; else first person from list
  if (!state.rootId) {
    const list = await api('/persons');
    const first = (list.data || [])[0];
    if (first) {
      state.rootId = String(first.id);
      localStorage.setItem(ROOT_KEY, state.rootId);
    }
  }

  await loadTree();
}

async function loadTree() {
  if (!state.token) return;
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
  el.reload.disabled = !state.token;

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
      openSheet(d);
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

  if (state.selectedId) {
    const sel = nodes.find((n) => String(n.id) === String(state.selectedId));
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

function openSheet(node) {
  state.selectedId = node.id;
  el.sheet.classList.remove('hidden');
  el.sheetTitle.textContent = node.name;
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
  el.sheetBody.innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
  el.setRoot.dataset.personId = String(node.id);
}

function closeSheet() {
  state.selectedId = null;
  el.sheet.classList.add('hidden');
}

async function setAsRoot() {
  const id = el.setRoot.dataset.personId;
  if (!id) return;
  state.rootId = id;
  localStorage.setItem(ROOT_KEY, id);
  await loadTree();
}

el.login.addEventListener('click', () => login().catch((e) => alert(e.message)));
el.reload.addEventListener('click', () => loadTree().catch((e) => alert(e.message)));
el.closeSheet.addEventListener('click', closeSheet);
el.setRoot.addEventListener('click', () => setAsRoot().catch((e) => alert(e.message)));
window.addEventListener('resize', () => {
  if (state.tree) render();
});

// Auto-load if token already present
if (state.token) {
  el.reload.disabled = false;
  loadTree().catch(() => {
    /* token may be stale */
  });
}
