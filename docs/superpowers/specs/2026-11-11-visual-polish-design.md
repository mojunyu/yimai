# Paper / ink / cinnabar visual polish — Design (APPROVED 15:49 Asia/Shanghai)

> **Status:** APPROVED by user 2026-11-11 15:49 Asia/Shanghai for Cursor Auto only.  
> **Same workstream/PR** as delete-correction (`cursor/delete-correction-02b3` from `ba353c1`).  
> **Sequence:** finish/verify DEL behavior first, then apply this visual layer, then combined regression.  
> **Source:** uploaded `yimai-visual-spec-2026-11-11` (approved; responsive clauses now in scope).  
> **Do not:** rewrite business copy, change data flows/navigation product, merge/deploy, touch demo18, use non-Auto models.

## Intent

Tighten the existing宣纸家谱 look: tokens, contrast, focus, busy indicators, selected-node strength, and CSS responsive stacking/wrapping (320 / 375 / 768 + desktop 200% zoom) **without** new pages or semantic-block removal.

## Rules relative to DEL

- DEL PM cut owns logic and confirm semantics.
- New DEL controls use **谱号** (not conflicting 「ID」 labels), integrating minimal DEL layout into the whole visual system.
- Existing locked sentences/buttons from visual spec §1 stay unchanged.
- Loading: non-text indicator + `aria-busy` only; never rewrite button labels to 「载入中」.

## In

- Token updates: `--control-line #8a8070`, `--parent #6a675c`; font fallbacks; solid disabled (not opacity-only); selected stroke stronger; 「当前视角」 ≥11px.
- Drop `body { min-width: 760px }`; stack topbar/workspace/sheet; canvas pans in its own region; no whole-page horizontal lock.
- Confirm/correction layers already introduced by DEL inherit paper/ink styles, full-width stacked buttons on narrow sheet.
- Measurable ACs in `docs/design/yimai-visual-component-spec-2026-11-11.md`.

## Out

- Competing visual redesigns, new icon language, copy changes, new navigation, rewriting DEL business rules, treating disabled contrast as AA failure.

## Acceptance

Visual component spec ACs + VIS-01…16 oracles as test evidence (QA matrix itself remains NOT RUN until executed on final SHA). Recalculate contrast on implemented surfaces. Same final HEAD as DEL evidence.
