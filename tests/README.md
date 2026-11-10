# Frontend regression tests

Browser (Puppeteer) checks for the 一脉 static frontend at `/app/`.

## Prerequisites

1. Laravel app runnable with SQLite (isolated local DB only — do not use a shared demo DB).
2. Seed demo data on that DB: `php artisan yimai:demo --fresh`
3. Serve the app (same-origin `/app/` + `/api/v1`), e.g. `php artisan serve --host=0.0.0.0 --port=8000`
4. Install Node deps from the repo root: `npm install`  
   (`puppeteer` is declared in `package.json` `devDependencies`)
5. A Chrome/Chromium binary:
   - `export PUPPETEER_EXECUTABLE_PATH=/path/to/chrome`, or
   - `npx puppeteer browsers install chrome` (bundled), or
   - system `google-chrome` / `chromium` on a common path

No Vite/app build step is required for these tests.

## Run

```bash
# from repo root
BASE_URL=http://localhost:8000 npm run test:frontend
# or
BASE_URL=http://localhost:8000 node tests/frontend-regression.test.mjs
```

### Env

| Variable | Default | Meaning |
|----------|---------|---------|
| `BASE_URL` | `http://localhost:8000` | App origin |
| `APP_ROOT` | parent of `tests/` | Laravel project root (for `php artisan tinker`) |
| `PUPPETEER_EXECUTABLE_PATH` | auto-detect / bundled | Chrome binary |
| `ARTIFACTS_DIR` | `./artifacts` | Screenshots + JSON results |

The runner **fails** if:

- any logged assertion fails
- a setup/test/teardown throws (aborted suite ≠ green)
- the number of logged results ≠ `EXPECTED_TEST_COUNT` (20)

Coverage includes: login/reload/persisted token, empty-tree first person (including stale `yimai_root_id`), parent/child/spouse/sibling, existing-person bind, missing-sibling-parent guard, persistent partial-save message, retry without duplicate POST, double-submit, parent overwrite block, idempotent same-parent bind.
