# 一脉（yimai）

家族树与家庭成员分支记录 — MVP（binding cut **2026-11-06 APPROVED**）。

Living SoT: [`docs/prd/yimai.md`](docs/prd/yimai.md)  
UI handoff: [`docs/design/`](docs/design/)  
Frontend (AC-4): [`frontend/README.md`](frontend/README.md)

## Stack

- Backend: Laravel + Sanctum (`/api/v1`)
- DB: SQLite by default (`.env` → `DB_CONNECTION=sqlite`)
- Frontend: static D3 app under `frontend/` (served at `/app/`), consumes `GET /persons/{id}/tree` only

## Requirements

- PHP ≥ 8.2 with extensions: mbstring, sqlite3, xml, curl, zip
- Composer 2.x

## Setup

```bash
composer install
cp .env.example .env   # if needed
php artisan key:generate
touch database/database.sqlite
php artisan migrate
php artisan yimai:demo --fresh   # demo user + 3-gen fixture + token
php artisan serve
```

- API: `http://127.0.0.1:8000/api/v1`
- App: `http://127.0.0.1:8000/app/`
- Demo login: `demo@yimai.test` / `password`

## API surface

| Method | Path | AC |
| --- | --- | --- |
| POST | `/auth/login` | demo auth |
| GET | `/trees/current` | AC-1 |
| GET/POST | `/persons` | AC-1 |
| GET/PATCH/DELETE | `/persons/{id}` | AC-1 / AC-2 / AC-5 |
| GET | `/persons/{id}/tree` | AC-4 |
| GET/POST | `/spouse-links` | AC-3 |
| PATCH/DELETE | `/spouse-links/{id}` | AC-3 |

Tree JSON field names are **locked** (AC-4):

```json
{
  "root_id": 1,
  "nodes": [{ "id": 1, "name": "…", "gender": "male", "generation": 1, "birth_year": 1950, "death_year": null }],
  "edges": [
    { "type": "parent", "from": 1, "to": 2 },
    { "type": "spouse", "a": 1, "b": 3, "link_id": 9 }
  ]
}
```

3-gen fixture expected counts: **nodes=5 · parent=4 · spouse=2** (see `App\Support\ThreeGenerationFixture`).

## Unlock order

AC-1 → AC-2 → AC-3 → AC-4 → AC-5 → AC-6

## UI defaults (Boss)

- Click node → open sheet only (no implicit root change; explicit「设为根」)
- No 「我」 marker in this cut
- Separate father / mother bind entries
- Hide spouse `start_year` / `end_year` / `note` in UI
- Frontend must trust `/persons/{id}/tree` only

## Tests

```bash
php artisan test --filter=TreeAc4Test
php artisan test
```

## Eng notes

- Scaffolded / implemented locally by Grok Bot (**no Cursor Cloud Agent**).
