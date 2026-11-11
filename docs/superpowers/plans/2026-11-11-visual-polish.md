# Visual polish Implementation Plan (after DEL baseline)

**Gate:** DEL behavior tests green on branch before editing visual tokens beyond minimal confirm layout.

### Task V1: Tokens + component CSS

- [ ] Update `:root` tokens, fonts, disabled solid styles, focus preserved, parent edge color, selected stroke, viewpoint label ≥11px, icon 16/20, name input emphasis.
- [ ] Remove body min-width 760; responsive stacking for topbar/workspace/sheet/legend/kin/confirm buttons; canvas overflow independent.
- [ ] Busy: `.is-busy` spinner on reload/submit/confirm without label rewrite; `aria-busy`.

### Task V2: Wire busy/disabled in JS (no copy change)

- [ ] `setSaving` / tree reload / confirm submit set `aria-busy` + class; restore labels unchanged.

### Task V3: VIS evidence

- [ ] Screenshots desktop/narrow/empty/loading/error/confirm; 320/375/768 + 200% sample; contrast notes recalculated; pin hashes with DEL evidence same SHA.
