/**
 * In-memory fictitious family tree for login-free preview.
 * Never talks to the network. Not the production 18-person demo.
 */

function pairKey(a, b) {
  const x = Number(a);
  const y = Number(b);
  return x < y ? `${x}:${y}` : `${y}:${x}`;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function createPreviewFixture() {
  let nextPersonId = 1;
  let nextSpouseId = 1;
  let nextSiblingId = 1;
  const treeId = 900001;
  const userId = 900001;

  const persons = new Map();
  const spouseLinks = new Map();
  const siblingLinks = new Map();

  function personPayload(p) {
    return {
      id: p.id,
      tree_id: treeId,
      name: p.name,
      gender: p.gender,
      generation: p.generation,
      birth_year: p.birth_year,
      death_year: p.death_year,
      father_id: p.father_id,
      mother_id: p.mother_id,
    };
  }

  function addPerson({ name, gender, generation = 1, birth_year = null, death_year = null, father_id = null, mother_id = null }) {
    const id = nextPersonId++;
    const p = {
      id,
      name,
      gender,
      generation,
      birth_year,
      death_year,
      father_id,
      mother_id,
    };
    persons.set(id, p);
    return p;
  }

  function addSpouse(a, b) {
    const id = nextSpouseId++;
    spouseLinks.set(id, { id, person_a_id: Number(a), person_b_id: Number(b) });
    return spouseLinks.get(id);
  }

  function addSibling(a, b) {
    const id = nextSiblingId++;
    siblingLinks.set(id, { id, person_a_id: Number(a), person_b_id: Number(b) });
    return siblingLinks.get(id);
  }

  function reset() {
    persons.clear();
    spouseLinks.clear();
    siblingLinks.clear();
    nextPersonId = 1;
    nextSpouseId = 1;
    nextSiblingId = 1;

    // Fictitious 林岚 family — not production demo ids.
    const gu = addPerson({ name: '林谷', gender: 'male', generation: 1 });
    const yu = addPerson({ name: '陈雨', gender: 'female', generation: 1 });
    const zhou = addPerson({ name: '林舟', gender: 'female', generation: 2, father_id: gu.id, mother_id: yu.id });
    const lan = addPerson({ name: '林岚', gender: 'female', generation: 2, father_id: gu.id, mother_id: yu.id });
    const he = addPerson({ name: '林禾', gender: 'male', generation: 2, father_id: gu.id, mother_id: yu.id });
    const shi = addPerson({ name: '周石', gender: 'male', generation: 2 });
    addSpouse(lan.id, shi.id);
    addSibling(lan.id, zhou.id);
    void he;
    return { rootId: lan.id, treeId, userId };
  }

  const boot = reset();

  function listPersons() {
    return Array.from(persons.values())
      .sort((a, b) => a.generation - b.generation || a.id - b.id)
      .map(personPayload);
  }

  function buildTree(rootId) {
    const root = persons.get(Number(rootId));
    if (!root) {
      const err = new Error('找不到这位家人。');
      err.status = 404;
      err.body = { message: 'Not found' };
      throw err;
    }
    const nodes = listPersons().map((p) => ({
      id: p.id,
      name: p.name,
      gender: p.gender,
      generation: p.generation,
      birth_year: p.birth_year,
      death_year: p.death_year,
    }));
    const edges = [];
    for (const p of persons.values()) {
      if (p.father_id != null) edges.push({ type: 'parent', from: p.father_id, to: p.id });
      if (p.mother_id != null) edges.push({ type: 'parent', from: p.mother_id, to: p.id });
    }
    for (const link of spouseLinks.values()) {
      edges.push({
        type: 'spouse',
        a: link.person_a_id,
        b: link.person_b_id,
        link_id: link.id,
      });
    }
    for (const link of siblingLinks.values()) {
      edges.push({
        type: 'sibling',
        a: link.person_a_id,
        b: link.person_b_id,
        link_id: link.id,
      });
    }
    return { root_id: root.id, nodes, edges };
  }

  function parseBody(options) {
    if (!options?.body) return {};
    if (typeof options.body === 'string') {
      try {
        return JSON.parse(options.body);
      } catch (_) {
        return {};
      }
    }
    return options.body;
  }

  function childrenOf(id) {
    const pid = Number(id);
    return Array.from(persons.values())
      .filter((p) => Number(p.father_id) === pid || Number(p.mother_id) === pid)
      .map((p) => ({ id: p.id, name: p.name }));
  }

  function reject(status, message, extra = {}) {
    const err = new Error(message);
    err.status = status;
    err.body = { message, ...extra };
    throw err;
  }

  async function handle(path, options = {}) {
    const method = (options.method || 'GET').toUpperCase();
    const clean = String(path || '').replace(/\?.*$/, '');
    const body = parseBody(options);

    if (clean === '/trees/current' && method === 'GET') {
      return { id: treeId, title: '虚构预览家谱', owner_user_id: userId };
    }

    if (clean === '/persons' && method === 'GET') {
      return { data: listPersons() };
    }

    if (clean === '/persons' && method === 'POST') {
      const p = addPerson({
        name: String(body.name || '').trim() || '未命名',
        gender: body.gender || null,
        generation: body.generation || 1,
        birth_year: body.birth_year ?? null,
        death_year: body.death_year ?? null,
      });
      return personPayload(p);
    }

    let m = clean.match(/^\/persons\/(\d+)$/);
    if (m && method === 'GET') {
      const p = persons.get(Number(m[1]));
      if (!p) reject(404, '找不到这位家人。');
      return personPayload(p);
    }

    if (m && method === 'PATCH') {
      const p = persons.get(Number(m[1]));
      if (!p) reject(404, '找不到这位家人。');
      if ('name' in body) p.name = body.name;
      if ('gender' in body) p.gender = body.gender;
      if ('generation' in body) p.generation = body.generation;
      if ('birth_year' in body) p.birth_year = body.birth_year;
      if ('death_year' in body) p.death_year = body.death_year;
      for (const slot of ['father_id', 'mother_id']) {
        if (!(slot in body)) continue;
        const incoming = body[slot];
        const current = p[slot];
        if (current != null && incoming != null && Number(incoming) !== Number(current)) {
          reject(422, 'Parent slot already set; refusing silent overwrite.');
        }
        if (incoming != null && Number(incoming) === Number(p.id)) {
          reject(422, 'A person cannot be their own parent.');
        }
        p[slot] = incoming;
      }
      return personPayload(p);
    }

    if (m && method === 'DELETE') {
      const id = Number(m[1]);
      const p = persons.get(id);
      if (!p) reject(404, '找不到这位家人。');
      const children = childrenOf(id);
      if (children.length) {
        reject(409, 'Cannot delete person while children still reference them. Unbind children first.', {
          children,
        });
      }
      for (const [lid, link] of Array.from(spouseLinks.entries())) {
        if (Number(link.person_a_id) === id || Number(link.person_b_id) === id) spouseLinks.delete(lid);
      }
      for (const [lid, link] of Array.from(siblingLinks.entries())) {
        if (Number(link.person_a_id) === id || Number(link.person_b_id) === id) siblingLinks.delete(lid);
      }
      for (const other of persons.values()) {
        if (Number(other.father_id) === id) other.father_id = null;
        if (Number(other.mother_id) === id) other.mother_id = null;
      }
      persons.delete(id);
      return null;
    }

    m = clean.match(/^\/persons\/(\d+)\/tree$/);
    if (m && method === 'GET') {
      return buildTree(m[1]);
    }

    if (clean === '/spouse-links' && method === 'POST') {
      const a = Number(body.person_a_id);
      const b = Number(body.person_b_id);
      if (!persons.has(a) || !persons.has(b)) reject(422, 'Person must belong to the same tree.');
      if (a === b) reject(422, 'A person cannot be their own spouse.');
      for (const link of spouseLinks.values()) {
        if (pairKey(link.person_a_id, link.person_b_id) === pairKey(a, b)) {
          reject(422, 'An open spouse link already exists for this pair.');
        }
      }
      return addSpouse(a, b);
    }

    m = clean.match(/^\/spouse-links\/(\d+)$/);
    if (m && method === 'DELETE') {
      if (!spouseLinks.has(Number(m[1]))) reject(404, '找不到这段关系。');
      spouseLinks.delete(Number(m[1]));
      return null;
    }

    if (clean === '/sibling-links' && method === 'POST') {
      const a = Number(body.person_a_id);
      const b = Number(body.person_b_id);
      if (!persons.has(a) || !persons.has(b)) reject(422, 'Person must belong to the same tree.');
      if (a === b) reject(422, 'A person cannot be their own sibling.');
      return addSibling(a, b);
    }

    m = clean.match(/^\/sibling-links\/(\d+)$/);
    if (m && method === 'DELETE') {
      if (!siblingLinks.has(Number(m[1]))) reject(404, '找不到这段关系。');
      siblingLinks.delete(Number(m[1]));
      return null;
    }

    if (clean === '/auth/login') {
      reject(403, '预览模式不使用登录。');
    }

    reject(404, `预览未实现：${method} ${clean}`);
  }

  return {
    userId,
    treeId,
    rootId: boot.rootId,
    reset,
    handle,
    snapshot() {
      return {
        persons: listPersons(),
        tree: buildTree(boot.rootId),
        spouseLinks: Array.from(spouseLinks.values()),
        siblingLinks: Array.from(siblingLinks.values()),
      };
    },
    // expose for tests
    _cloneState: () => clone({
      persons: listPersons(),
      spouses: Array.from(spouseLinks.values()),
      siblings: Array.from(siblingLinks.values()),
    }),
  };
}
