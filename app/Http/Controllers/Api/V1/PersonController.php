<?php

namespace App\Http\Controllers\Api\V1;

use App\Http\Controllers\Controller;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/**
 * Stubs aligned to cut 2026-11-06. Implement unlock order AC-1 → AC-6.
 *
 * Tree JSON (locked field names for AC-4):
 * {
 *   "root_id": <id>,
 *   "nodes": [{ "id","name","gender","generation","birth_year","death_year" }],
 *   "edges": [
 *     { "type":"parent", "from": <parent_id>, "to": <child_id> },
 *     { "type":"spouse", "a": <id>, "b": <id>, "link_id": <id> }
 *   ]
 * }
 */
class PersonController extends Controller
{
    public function index(Request $request): JsonResponse
    {
        return response()->json(['message' => 'stub: GET /api/v1/persons', 'todo' => 'AC-1 list'], 501);
    }

    public function store(Request $request): JsonResponse
    {
        // AC-1: validate name required (422), gender, generation, birth_year, death_year
        return response()->json(['message' => 'stub: POST /api/v1/persons', 'todo' => 'AC-1 create'], 501);
    }

    public function show(string $id): JsonResponse
    {
        return response()->json(['message' => 'stub: GET /api/v1/persons/{id}', 'todo' => 'AC-1 show', 'id' => $id], 501);
    }

    public function update(Request $request, string $id): JsonResponse
    {
        // AC-2: father_id / mother_id; ring hard-fail 4xx
        return response()->json(['message' => 'stub: PATCH /api/v1/persons/{id}', 'todo' => 'AC-1/AC-2 update', 'id' => $id], 501);
    }

    public function destroy(string $id): JsonResponse
    {
        // AC-5: if still has children → 409
        return response()->json(['message' => 'stub: DELETE /api/v1/persons/{id}', 'todo' => 'AC-5 delete', 'id' => $id], 501);
    }

    public function tree(string $id): JsonResponse
    {
        // AC-4: return locked tree JSON shape; frontend must not invent edges
        return response()->json([
            'message' => 'stub: GET /api/v1/persons/{id}/tree',
            'todo' => 'AC-4 tree JSON',
            'root_id' => (int) $id,
            'nodes' => [],
            'edges' => [],
        ], 501);
    }
}
