# Explicit two-person sibling relationships — Design (APPROVED)

> **Status:** APPROVED by user 2026-11-11; implementation authorized for Cursor Auto only.  
> **Base:** `main` @ `12a3dbf700a9be63e465879b6a6f20af8a7c935f` (includes lifecycle repair `4e9b24a`).  
> **Do not:** merge, deploy, touch Mac/demo 18-person data, fabricate parents, auto-propagate parent IDs, infer transitive siblings, add unlink-management UI.

---

## 1. Problem

Today 哥/姐/弟/妹 is a **frontend-only** workflow that requires the anchor to have a known `father_id` and/or `mother_id`, then **copies those parent IDs** onto the new/existing person via `PATCH /persons/{id}`.

That blocks recording a known sibling when parents are unknown or different, and falsely asserts shared parents.

## 2. Approved outcome

1. Select current person → 哥/姐/弟/妹 → name → save, **or** explicitly select an existing person by concrete ID.
2. Persist a **symmetric direct two-person sibling relationship** independent of parent fields.
3. Visible in graph and both people's details; survives refresh and reroot.
4. **No** inference A–C merely from A–B and B–C.
5. Shared known parents remain a **separate, existing** evidence source for derived sibling display.
6. No fake parent nodes, no name matching, no automatic merging.
7. Adding/editing parents modifies **only** the target person; keep conflict-rejection protections.
8. Existing known parents must **not** be copied when recording siblings.
9. Preserve old parent/spouse data and existing derived sibling display; **deduplicate display by person ID** without discarding underlying evidence.
10. No new unlink-management UI this iteration; **correct deletion cleanup** of new relationships is required.

## 3. Architecture (fits existing SpouseLink pattern)

### 3.1 Data: `SiblingLink`

New table `sibling_links`, modeled like `spouse_links` but without years/note:

| Column | Type | Notes |
| --- | --- | --- |
| id | bigint PK | |
| tree_id | FK → trees | cascadeOnDelete |
| person_a_id | FK → persons | cascadeOnDelete |
| person_b_id | FK → persons | cascadeOnDelete |
| created_at / updated_at | timestamps | |

**Normalized pair uniqueness (DB-backed):**

- On write, store with `person_a_id < person_b_id` (canonical order).
- Unique index on `(tree_id, person_a_id, person_b_id)`.
- Reject self-link (`person_a_id === person_b_id`) with 422.
- Both persons must belong to the current user's tree; otherwise 422 (same-tree) / foreign IDs appear as 404 on show/delete scoped lookups.

No sibling groups, no transitive closure table, no placeholder people.

### 3.2 API contract (stable for QA)

Prefix `/api/v1`, `auth:sanctum`, scoped via `EnsuresCurrentTree` (same as spouse-links).

| Method | Path | Behavior |
| --- | --- | --- |
| GET | `/sibling-links` | `{ data: [linkPayload…] }` for current tree |
| POST | `/sibling-links` | body `{ person_a_id, person_b_id }` (order irrelevant). Creates canonical row. **Idempotent:** if unordered pair already exists, return **200** with existing payload; if created, **201**. |
| GET | `/sibling-links/{id}` | optional; not required if list+tree suffice. Prefer list only to match spouse surface unless show is trivial. |
| DELETE | `/sibling-links/{id}` | 204; scoped to current tree → else 404. **No UI** for this in this cut. |

**linkPayload:**

```json
{
  "id": 1,
  "tree_id": 1,
  "person_a_id": 10,
  "person_b_id": 12,
  "created_at": "…",
  "updated_at": "…"
}
```

`person_a_id` / `person_b_id` in responses are the **canonical stored** order (`a < b`), not request order.

**Errors:**

| Case | Status | Notes |
| --- | --- | --- |
| Unauthenticated | 401 | |
| Self-link | 422 | `A person cannot be their own sibling.` |
| Person not in current tree | 422 | `Person must belong to the same tree.` |
| Foreign link id (other tree) | 404 | |
| Forged `tree_id` on body | ignored | tree always from current user |

### 3.3 Tree JSON extension

`GET /persons/{id}/tree` edges gain a third type:

```json
{ "type": "sibling", "a": <id>, "b": <id>, "link_id": <sibling_link.id> }
```

- `a`/`b` match stored canonical IDs.
- Parent and spouse edges unchanged.
- Fixture 3-gen demo remains `nodes=5 · parent=4 · spouse=2` with **zero** sibling edges unless tests add them.
- **No** inferred sibling edges from shared parents in the API payload. Derived siblinghood stays a **display** concern (as today) plus explicit edges.

### 3.4 Deletion cleanup

- `sibling_links.person_a_id` / `person_b_id` use `cascadeOnDelete` (same as spouse).
- Allowed `DELETE /persons/{id}` (AC-5: no children → 204) atomically removes incident sibling links; no dangling rows.
- AC-5 guard unchanged: has children → **409**, no member/link mutations.
- Spouse deletion rules unchanged.

### 3.5 Parent edits

- `PATCH /persons/{id}` with `father_id`/`mother_id` continues to mutate **only that person**.
- Silent overwrite of a conflicting filled slot remains **422**.
- Sibling bind **must not** write parent fields.

## 4. Frontend behavior

### 4.1 Add flow

- Keep kin labels 哥/姐/弟/妹 (set gender on new person only; **no** age/rank validation).
- **Remove** `hasKnownParent` prerequisite and `missingParentsMessage` gate.
- Context copy: e.g. `给「甲」添一位哥哥。` — do **not** say parents will be copied.
- On bind (`relation === 'sibling'`): `POST /sibling-links` with anchor + target IDs. Treat idempotent 200/201 as success. Do **not** PATCH parent IDs.
- Existing-person path: concrete ID from select only (preserve no-name-adopt / uncertain-create recovery from `4e9b24a`).
- Reverse wording in any generic kin copy: use **兄弟姐妹** when gender/age of reverse is unknown — do not guess 哥/弟.

### 4.2 Details + graph

- `siblingsOf(id)` = union of:
  - **Derived:** people sharing ≥1 known parent via parent edges (existing logic), and
  - **Explicit:** endpoints of `type=sibling` edges incident on `id`
  - Dedupe by person ID.
- Graph: draw sibling edges with a **distinguishable** style (not identical to parent or spouse). Include sibling count in top-bar stats when edges present.
- Reroot / refresh: reload tree JSON; explicit edges come from API.

### 4.3 Partial save / recovery (preserve prior repair)

Retain `4e9b24a` behavior:

- Empty-account login → `GET /trees/current` before first create.
- Lost create response + F5 → user/tree-scoped recovery; no duplicate; no auto-adopt by name.
- Definite 422 ≠ uncertain response.
- Clear recovery only after display load success.
- Creation success + binding failure → keep saved person ID + durable notice; retry binds ID only.
- Unknown network outcome → reconcile / concrete-ID choice, not blind new POST.

Sibling bind failure uses the same partial-save path as other relations.

### 4.4 Out of scope this cut

- Unlink-management UI for sibling links
- Sibling groups / transitive closure
- Adoption / step-parent modeling
- Placeholder people / batch backfill
- Complex layout rewrite / kinship naming engine
- Age/elder-younger validation for 哥姐弟妹 labels

## 5. Acceptance map (SIB-AC)

| ID | Requirement | Proof |
| --- | --- | --- |
| SIB-AC1 | Both parents null → add sibling by name; both nodes + distinguishable sibling edge; reciprocal details; no parent rows/edges | API JSON + screenshot |
| SIB-AC2 | Same-name people remain distinct; explicit existing ID; different parents / half siblings without mutating either parents; reject self-link | API |
| SIB-AC3 | A→B / B→A / repeats → one undirected link; DB uniqueness; retry/double-click no extra people | API/assertions |
| SIB-AC4 | Later parents on A do not mutate B; conflicting parent slot not silently overwritten | API before/after |
| SIB-AC5 | A–B and B–C alone do not create A–C; shared parent IDs remain separate evidence | Fixture + JSON + screenshot |
| SIB-AC6 | Auth/tree isolation for member/link/tree IDs including forged IDs | API assertions |
| SIB-AC7 | Persistence/UI/API consistency; derived+explicit overlap renders once; AC-5 deletion guard; allowed delete cleans sibling links; spouse rules unchanged; create/bind/uncertain recovery behaviors preserved | API + UI + regression suites |

## 6. Regressions

Must retain prior lifecycle repair on main (`4e9b24a` and related). Run full backend Feature suite and frontend Puppeteer suite. Prior counts (35 browser / 34 backend) are historical evidence only — re-run and report actual results for this HEAD. Add strong SIB scenario ID/edge assertions; use real UI login (no `injectAuth`) for new flows where needed. Isolated disposable fixtures only.

## 7. Evidence expectations

- Exact final HEAD, PR URL, execution-time SHA
- Served JS/backend resource hashes tied to final test run
- Log/JSON with timestamps and individual results
- API evidence with fixture IDs
- Fresh screenshots for this version (old artifacts labeled old)
- Unique run directory + Agent Store copy for read-only QA
- Engineering completion report only; independent SWE/QA by Master
