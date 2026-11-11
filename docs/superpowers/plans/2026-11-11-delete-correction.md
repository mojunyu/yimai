# Delete-correction (+ approved visual) Implementation Plan

> **For agentic workers:** Execute task-by-task on branch `cursor/delete-correction-02b3` from `ba353c1`. Cursor Auto only. No merge/deploy. No Mac/demo18 writes.

**Goal:** Ship DEL-1…DEL-7 delete/correction UX on existing APIs with safe unknown-result reconcile; then apply approved paper/ink visual tokens/responsive stacking; prove DEL-H oracles + REG named suites + VIS cases against one final SHA.

**Architecture:** Extend `#sheet` only. Freeze op targets at confirm/send. Backend keeps contracts; optional transactional child re-check + additive 409 `children[]`. Visual is CSS/token/aria-busy only after DEL green.

**Tech Stack:** Laravel 13 / PHP 8.3, Sanctum, SQLite, PHPUnit Feature + TestDox, vanilla JS + D3, Puppeteer `tests/frontend-regression.test.mjs`.

## Global Constraints

- Base: `ba353c1573d12afd18431c2b8ab107a6aa0475d5`; branch `cursor/delete-correction-02b3`.
- Cursor Auto only; no other paid models/services.
- 谱号 unified on new DEL controls (not mixed ID labels).
- Preserve AC-5/AC-6/SIB/login/loading/person-recovery; do not weaken assertions to counts-only.
- Isolated disposable fixtures; id=1 on fresh DB OK; original demo tree forbidden.
- Sequence: **DEL behavior → visual → combined regression**.
- Evidence under Agent Store `del-evidence/` (new run dir only) + `/opt/cursor/artifacts/…`.

## File map

| File | Responsibility |
| --- | --- |
| `docs/prd/yimai.md` | Dated delete-correction cut (+ visual note); keep sibling cut |
| `docs/superpowers/specs/2026-11-11-delete-correction-design.md` | DEL design |
| `docs/superpowers/plans/2026-11-11-delete-correction.md` | This plan |
| `docs/design/yimai-visual-component-spec-2026-11-11.md` | Committed visual component ACs |
| `docs/superpowers/specs/2026-11-11-visual-polish-design.md` | Visual design summary |
| `docs/superpowers/plans/2026-11-11-visual-polish.md` | Visual task plan |
| `app/Http/Controllers/Api/V1/PersonController.php` | 409 children[]; transactional re-check |
| `frontend/index.html` | Correction/delete/confirm containers |
| `frontend/js/app.js` | DEL UI + reconcile + 谱号 + busy |
| `frontend/css/app.css` | DEL layout + visual tokens/responsive |
| `tests/Feature/PersonDeleteCorrectionTest.php` | Named DEL backend testdox |
| `tests/Feature/PersonAc5Test.php` | Preserve English children message |
| `tests/frontend-regression.test.mjs` | DEL-H browser + REG retention + VIS |
| Evidence: `/cursor/stores/self/del-evidence/<run>/` |

---

### Task 1: Docs + PRD cut

- [ ] Write design/plan/visual docs; prepend PRD cut without replacing sibling cut.
- [ ] Commit `docs: add 2026-11-11 delete-correction + visual specs/plans`

### Task 2: Backend 409 children + delete hardening (TDD)

**Files:** `PersonController.php`, `tests/Feature/PersonDeleteCorrectionTest.php`

- [ ] Failing tests: 409 includes English `children` + `children[{id,name}]`; spouse-only delete 204; incident spouse/sibling cleanup; non-incident links remain; parent PATCH null; link DELETE; isolation A/B; transactional no half-delete on 409.
- [ ] Implement additive payload + transaction re-check; no new routes.
- [ ] `php artisan test --filter='PersonDelete|PersonAc5|SiblingAc|TreeIsolation|SpouseAc'` PASS; pint.
- [ ] Commit `feat(api): enrich delete 409 children and harden destroy`

### Task 3: Frontend DEL behavior (before visual polish)

**Files:** `index.html`, `app.js`, minimal CSS for confirm stack/scroll only

- [ ] Sheet title + 谱号; correct-relations list; delete entry; in-sheet confirm/409/unknown.
- [ ] Freeze targets; no optimistic delete; 204 no JSON parse; reconcile rules; DEL-6 close-outs; recovery id-gated clear.
- [ ] Sibling source labels; explicit unlink keeps inferred.
- [ ] Commit `feat(frontend): delete confirmation and relationship correction`

### Task 4: Frontend DEL browser tests

- [ ] Cover DEL-1…7 / DEL-H-01…24 oracles with isolated fixtures (screenshots + JSON).
- [ ] Keep prior SIB/first-person/recovery tests intact (REG checklist).
- [ ] Commit `test: cover delete-correction DEL browser oracles`

### Task 5: Visual polish on DEL baseline

- [ ] Apply tokens, responsive (drop body min-width 760), busy/aria-busy, focus/disabled solid styles per component spec — no copy rewrites.
- [ ] Commit `style: paper-ink visual polish and responsive stacking`

### Task 6: Combined regression + evidence + PR

- [ ] Full PHPUnit testdox + `npm run test:frontend` + VIS screenshots 320/375/768/desktop/200% zoom samples.
- [ ] Pin HEAD, source hashes, served hashes; store originals in Agent Store `del-evidence/`.
- [ ] Push; open PR via ManagePullRequest; stop (no merge/deploy).

## Spec coverage

| Item | Task |
| --- | --- |
| DEL-1…7 / 谱号 | 3–4 |
| DEL-H-01…24 oracles | 4 |
| REG-S/F named | 4, 6 |
| 409 English+children | 2 |
| Visual tokens/responsive/VIS | 5–6 |
| AC-5/6/SIB preserved | 2, 4, 6 |
