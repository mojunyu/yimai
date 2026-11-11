# Explicit Two-Person Sibling Links Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist symmetric direct sibling relationships independent of parent fields, expose them on `/sibling-links` and tree `type=sibling` edges, and wire the 哥/姐/弟/妹 UI to that contract without copying parents.

**Architecture:** Mirror `SpouseLink`: new `sibling_links` table with canonical `person_a_id < person_b_id` uniqueness, `SiblingLinkController` under `/api/v1/sibling-links`, emit sibling edges from `PersonController::tree`, cascade-delete on person delete. Frontend removes the missing-parent gate and POSTs sibling-links on bind; details/graph union derived + explicit siblings by person id.

**Tech Stack:** Laravel 13 / PHP 8.3, Sanctum, SQLite, PHPUnit Feature tests, vanilla JS + D3 frontend, Puppeteer `tests/frontend-regression.test.mjs`.

## Global Constraints

- Base branch: `main` @ `12a3dbf` (includes `4e9b24a` lifecycle repair); work on `cursor/explicit-siblings-396c`.
- Cursor Auto only; no other paid models/services; no merge/deploy; no Mac/demo 18-person data.
- Do not fabricate parents or copy `father_id`/`mother_id` on sibling bind.
- No transitive A–C inference; no unlink UI; no age/rank validation for 哥姐弟妹.
- Preserve AC-5 (children → 409), spouse rules, parent conflict 422, recovery/no-name-adopt.
- Avoid unrelated refactors; run Pint on dirty PHP before finalize.
- Spec SoT: `docs/superpowers/specs/2026-11-11-explicit-siblings-design.md`.

## File map

| File | Responsibility |
| --- | --- |
| `database/migrations/2026_11_11_050000_create_sibling_links_table.php` | Schema + unique `(tree_id, person_a_id, person_b_id)` |
| `app/Models/SiblingLink.php` | Eloquent model |
| `app/Models/Tree.php` | `siblingLinks()` relation |
| `app/Http/Controllers/Api/V1/SiblingLinkController.php` | index/store/destroy |
| `routes/api.php` | Register sibling-link routes |
| `app/Http/Controllers/Api/V1/PersonController.php` | Emit sibling edges in `tree()` |
| `tests/Feature/SiblingAcTest.php` | SIB-AC API coverage |
| `tests/Feature/TreeIsolationAc6Test.php` | Extend isolation to sibling-links |
| `tests/Feature/PersonAc5Test.php` | Assert sibling cleanup on allowed delete |
| `frontend/js/app.js` | Bind/display/render/stats/context |
| `frontend/css/app.css` | `.edge-sibling` style |
| `tests/frontend-regression.test.mjs` | Replace obsolete missing-parent test; add SIB UI cases |
| Evidence under `/opt/cursor/artifacts/sib-ac-2026-11-11-<run>/` + Agent Store |

---

### Task 1: SiblingLink migration + model + routes + controller (TDD)

**Files:**
- Create: migration, `SiblingLink.php`, `SiblingLinkController.php`, `tests/Feature/SiblingAcTest.php`
- Modify: `routes/api.php`, `app/Models/Tree.php`
- Test: `tests/Feature/SiblingAcTest.php`

**Interfaces:**
- Produces: `POST/GET/DELETE /api/v1/sibling-links`; model `SiblingLink`; payload keys `id,tree_id,person_a_id,person_b_id,created_at,updated_at`
- Consumes: `EnsuresCurrentTree`, `Person` existence checks (same as spouse)

- [ ] **Step 1: Write failing Feature tests** covering SIB-AC1 (null parents → link + tree sibling edge, no parent edges), SIB-AC2 (self 422; distinct same-name; different parents unchanged), SIB-AC3 (A→B/B→A/repeat → one row; canonical a<b; idempotent 200), SIB-AC4 (PATCH A parents does not mutate B), SIB-AC5 (A-B + B-C ⇒ no A-C edge), SIB-AC7 delete cleans links / AC-5 409 unchanged.

- [ ] **Step 2: Run** `php artisan test --filter=SiblingAcTest` → expect FAIL (missing route/table).

- [ ] **Step 3: Implement** via `php artisan make:model SiblingLink -m --no-interaction`, `make:controller Api/V1/SiblingLinkController --no-interaction`, `make:test SiblingAcTest --phpunit --no-interaction` if stubs needed; migration columns + FKs cascadeOnDelete + unique; controller mirrors SpouseLinkController with normalize + idempotent store; register routes; `Tree::siblingLinks()`.

- [ ] **Step 4: Run SiblingAcTest → PASS**; `vendor/bin/pint --dirty --format agent`.

- [ ] **Step 5: Commit** `feat(api): add SiblingLink CRUD with normalized uniqueness`

---

### Task 2: Tree JSON sibling edges + isolation + delete cleanup

**Files:**
- Modify: `PersonController.php` `tree()`, `TreeIsolationAc6Test.php`, `PersonAc5Test.php` (or SiblingAcTest delete cases)
- Test: isolation + AC-5 sibling cleanup

- [ ] **Step 1: Failing tests** — tree JSON includes `{type:sibling,a,b,link_id}`; foreign sibling-link 404; unauthenticated 401; forged tree_id ignored; delete person without children removes incident sibling_links; has children → 409 and links untouched.

- [ ] **Step 2: Implement** sibling edge emission in `tree()` after spouse edges; extend AC6 unauth/foreign cases.

- [ ] **Step 3: Run** `php artisan test --filter='SiblingAc|TreeIsolation|PersonAc5|TreeAc4|SpouseAc'` → PASS (TreeAc4 fixture still 0 sibling edges).

- [ ] **Step 4: Commit** `feat(api): emit sibling edges and harden isolation/cleanup`

---

### Task 3: Frontend bind + display + graph

**Files:**
- Modify: `frontend/js/app.js`, `frontend/css/app.css`
- Test: browser suite updates in Task 4

**Interfaces:**
- Consumes: `POST /sibling-links`, tree `type=sibling`
- Produces: `siblingsOf` union; `.edge-sibling` paths; stats sibling count

- [ ] **Step 1: Remove** `hasKnownParent` gate in `startAddForKin` / `bindPerson` sibling branch; update `addContextText` (no parent-copy wording).

- [ ] **Step 2: `bindPerson` sibling → `POST /sibling-links` with anchor+target; treat 200/201 success; map API errors to ZH; do not PATCH parents.

- [ ] **Step 3: `siblingsOf` unions derived parents-sharing + explicit sibling edge endpoints; dedupe by id.

- [ ] **Step 4: `render()` draws sibling edges (e.g. side midpoints, dashed distinct from spouse); CSS `--sibling` / `.edge-sibling`; `countEdges` + stats include sibling.

- [ ] **Step 5: Commit** `feat(frontend): bind explicit siblings without copying parents`

---

### Task 4: Browser regressions + SIB-AC UI proof

**Files:**
- Modify: `tests/frontend-regression.test.mjs` (replace `testMissingSiblingParentError`; update shared-parent sibling expectation; add SIB-AC1/5 UI cases with real login where needed)
- Evidence scripts under artifacts run dir

- [ ] **Step 1: Replace obsolete test** — sibling with null parents succeeds (form opens, creates person + sibling edge, reciprocal details, no parent edges).

- [ ] **Step 2: Update** former “shares known father/mother” case → asserts **sibling** edge / link, parents of new sibling remain null (or unchanged), anchor parents unchanged.

- [ ] **Step 3: Add** chain A-B-C no A-C UI assertion; overlap derived+explicit shows once.

- [ ] **Step 4: Run** `npm run test:frontend` and full `php artisan test`; capture logs/screenshots/API JSON under unique run dir; copy to Agent Store.

- [ ] **Step 5: Commit** `test: cover explicit sibling SIB-AC UI and API regressions`

---

### Task 5: Evidence pack + PR

- [ ] Generate summary **before** `BUILD_HASHES`; record HEAD, served JS hash (`frontend/js/app.js`), backend PHP file hashes, test timestamps.
- [ ] Push `cursor/explicit-siblings-396c`; open PR via ManagePullRequest (do not merge).
- [ ] Final engineering report with paths + limitations.

## Spec coverage checklist

| Spec item | Task |
| --- | --- |
| SiblingLink + normalized uniqueness | 1 |
| API sibling-links idempotent POST | 1 |
| Tree sibling edge | 2 |
| No parent copy / parent edit isolation | 1, 3 |
| No A–C inference | 1, 4 |
| Details dedupe derived∪explicit | 3, 4 |
| Delete cleanup + AC-5 | 2 |
| Auth isolation | 2 |
| Recovery/`4e9b24a` preserved | 4 (full suite) |
| No unlink UI | (explicit non-goal) |
