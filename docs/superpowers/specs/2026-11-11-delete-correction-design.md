# Delete + relationship correction — Design (APPROVED)

> **Status:** APPROVED by Boss via Master / user 2026-11-11; Cursor Auto only.  
> **Base:** `main` @ `ba353c1573d12afd18431c2b8ab107a6aa0475d5`.  
> **Binding cut:** uploaded DEL-1…DEL-7 + Proof map (same-day sibling cut remains in force).  
> **Also in this workstream (user 15:49 Asia/Shanghai):** paper/ink/cinnabar visual polish — see `docs/design/yimai-visual-component-spec-2026-11-11.md`. Sequence: DEL behavior first → visual → combined regression.  
> **Do not:** merge, deploy, touch Mac/demo 18-person data, create tunnels, broaden API endpoints, cascade-delete other people, invent divorce/death semantics, or start a competing branch.

---

## 1. Problem

Detail sheet shows name only (no stable id), has no delete confirmation, and no specified-slot / specified-link correction UI. Users cannot safely remove a mistaken person among same-name peers, clear a wrong parent slot, or unlink an exact spouse / explicit sibling edge. Child protection (AC-5 409) exists API-side but has no Chinese next-step UI. Failure/unknown network results risk optimistic fake deletion or retrying against a newly selected person.

## 2. Approved outcome

1. Detail always shows **姓名 + 谱号 {id}**; same-name choices, confirmations, and 409 child rows use the same pairing.
2. Confirm delete of **one** person id only; no cascade of other people; not death registration.
3. Correct relations separately from add: clear exact father/mother slot; DELETE exact spouse `link_id`; DELETE exact sibling `link_id`.
4. Explicit vs common-parent-inferred sibling sources are distinct; unlinking explicit while parents remain keeps inferred display + true parent edges (never recreate explicit edge).
5. Children → 409 with Chinese reason + open-child-for-parent-correction; spouse alone does not block delete.
6. No optimistic removal; freeze original person/link/slot at confirm/send; unknown results reconcile original target under same account/tree authority; safe retry original id only (DEL-7).
7. DEL-6 close-out: non-root selected → close detail / keep root; delete root → select survivor + state viewpoint; last person → empty / add-first. Recovery cleared only if `pendingPersonId` / `anchorId` equals deleted id.

## 3. Architecture (no new endpoints)

Reuse existing contracts:

| Action | Contract |
| --- | --- |
| Delete person | `DELETE /persons/{id}` → **204** empty success (must not require JSON body parse); **409** with English `message` containing `children` (old tests) **plus** additive `children: [{id,name},…]` for UI |
| Clear parent slot | `PATCH /persons/{id}` `{ father_id: null }` or `{ mother_id: null }` |
| Unlink spouse | `DELETE /spouse-links/{link_id}` → 204 |
| Unlink explicit sibling | `DELETE /sibling-links/{link_id}` → 204 |
| Graph | existing tree JSON parent / spouse / sibling edges |

### 3.1 Soft contract note (409 children)

Additive JSON field `children` does **not** change status codes or the English `message` substring required by `PersonAc5Test` / `PersonAc1Test`. Flagged only if product later demands removing English text — out of scope.

### 3.2 Deletion safety / concurrency

- Application still checks children before delete (AC-5).
- Schema: `father_id`/`mother_id` are `nullOnDelete`; spouse/sibling FKs are `cascadeOnDelete`.
- **Assessment:** FK `SET NULL` does **not** enforce strict 409. A check-then-delete race can still clear child parent slots via `nullOnDelete` if a concurrent writer loses the race, or leave application and DB briefly inconsistent. Hardening in-scope: wrap destroy in a DB transaction and **re-check children immediately before delete** (same response shape). Do not claim FK alone guarantees 409.
- Spouse-only deletion remains allowed (no 409 for spouse presence).

### 3.3 Frontend state machine (delete / correct)

Frozen at confirm open / send:

- `op`: `delete_person` | `clear_father` | `clear_mother` | `unlink_spouse` | `unlink_sibling`
- `personId`, `name`, optional `counterpartId`/`counterpartName`, `linkId`, `slot`
- `phase`: `confirm` | `submitting` | `rejected` | `unknown` | `success`

Rules:

- Disable double writes while `submitting`.
- Never optimistically remove nodes/edges.
- **204** → success without parsing JSON body.
- Network / timeout / parse error / ambiguous 404 / 401 / 403 / local partial graph absence → **unknown**, not success.
- Reconcile only under valid same-account + same-tree: `GET /persons/{frozenId}` (or reload list and look up frozen id). Missing under that authority after a write attempt may confirm delete; auth failure or ambiguous 404 alone must not.
- After selection switch, retry/reconcile still targets **frozen** id.
- Write success + reload failure ≠ failed write: offer reload, not mutation retry.
- Unresolved unknown remains unknown until reconcile decides.

### 3.4 Sibling display sources

`siblingsOf` returns rows with `source`: `explicit` | `inferred` | `both`, plus `link_id` when explicit edge exists. Unlink button only when `link_id` present. After explicit unlink with shared parents: keep inferred line + explanation 「因共同父母仍显示为兄弟姐妹」; do not POST sibling-links again.

### 3.5 Recovery interaction

On successful delete of id D: clear recovery **only if** `recovery.pendingPersonId` or `recovery.anchorId` equals D. Do not clear unrelated recovery; do not create another person.

## 4. UI (extend existing `#sheet` only)

- Title = name; subtitle = `谱号 {id}` (unify; do not mix 「ID」 labels on new DEL controls).
- Section **更正关系** (separate from **添加**): parent clear / spouse unlink / explicit sibling unlink / children open-only.
- Bottom secondary dangerous **删除此人记录** away from 「记下」.
- Confirm / 409 / unknown layers inside sheet; 330px wraps/scrolls/stacks buttons; keyboard trap + Esc cancel; after close, focus returns to trigger if still present, else survivor node or 「添加」—never focus a deleted node.
- Copy for new layers: Marketer strings from visual spec §5 with **谱号** substituted for ID; existing non-DEL copy unchanged.

## 5. Acceptance

Official: **DEL-1…DEL-7** (Proof: screenshot + API JSON as cut). Preserve **AC-5, AC-6, SIB-AC, login/load/idempotent/non-transitive, first-person recovery**.

QA prep incorporated as **test oracles / fixtures**, not scope expansion:

- `DEL-H-01…24` high-risk cases
- `REG-S-*` / `REG-F-*` (15 groups) named regressions
- Evidence protocol: isolated A/B trees; fresh-fixture autoincrement id=1 allowed; original Mac demo tree forbidden
- Visual matrix VIS-* executed after visual pass on same SHA (see visual component spec)

**Unlock order:** DEL-1,3,5 → DEL-2,4 → DEL-6,7 → visual polish → combined regression.

## 6. Out / conflicts

Out unchanged from cut (no cascade family delete, no recycle bin, no养父母, no global redesign beyond approved visual tokens, no new API routes).

**Flagged (not expanded):**

1. Visual Marketer draft used 「ID」; product unify is **谱号** — implemented as 谱号 everywhere in new DEL UI.
2. Visual VIS matrix is NOT RUN prep; AA contrast is QA baseline; disabled-control contrast exempt.
3. Child-check vs `nullOnDelete` race — assessed + transactional re-check; not claimed as FK-enforced 409.
4. Full global visual “product rewrite” remains out; only approved paper/ink token/responsive CSS on same structure.
