# AC-5 / AC-6 evidence — 2026-11-06 cut

Binding SoT: `docs/prd/yimai.md` (APPROVED). Eng path: local Grok Bot (no Cloud Agent).

## AC-5 删除保护

**Behavior (already in `PersonController::destroy`):**
- DELETE `/api/v1/persons/{id}` while any same-tree person has `father_id` or `mother_id` pointing at `{id}` → **409**
- After unbinding (`PATCH` child with `father_id`/`mother_id` null) → DELETE **204**

**Proof (Feature tests):**
- `tests/Feature/PersonAc1Test.php` — `test_delete_person_with_children_returns_409` (father path, kept)
- `tests/Feature/PersonAc5Test.php`
  - father / mother reference → 409
  - unbind then delete → 204 + row gone

## AC-6 树隔离

**Behavior:**
- All person / spouse-link routes use `EnsuresCurrentTree` + `where('tree_id', $currentTree->id)`; foreign IDs → **404**
- Unauthenticated → **401**
- Client-supplied `tree_id` on POST person is ignored; record lands in the caller's tree only

**Proof (Feature tests):**
- `tests/Feature/TreeIsolationAc6Test.php` — two users; persons read/write/list/tree; spouse-links list/patch/delete/cross-bind; forged `tree_id`; owner still OK
- Related earlier guards: `PersonAc2Test::test_parent_from_other_tree_returns_422`, `SpouseAc3Test` outsider spouse → 422

## How to re-run

```bash
php artisan test --filter='PersonAc5|TreeIsolationAc6'
php artisan test
```
