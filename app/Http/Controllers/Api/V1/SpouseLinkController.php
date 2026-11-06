<?php

namespace App\Http\Controllers\Api\V1;

use App\Http\Controllers\Controller;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/**
 * Stubs for AC-3 spouse binding.
 */
class SpouseLinkController extends Controller
{
    public function index(Request $request): JsonResponse
    {
        return response()->json(['message' => 'stub: GET /api/v1/spouse-links', 'todo' => 'AC-3 list'], 501);
    }

    public function store(Request $request): JsonResponse
    {
        // self-spouse → 422; same open pair → reject
        return response()->json(['message' => 'stub: POST /api/v1/spouse-links', 'todo' => 'AC-3 create'], 501);
    }

    public function update(Request $request, string $id): JsonResponse
    {
        return response()->json(['message' => 'stub: PATCH /api/v1/spouse-links/{id}', 'todo' => 'AC-3 update', 'id' => $id], 501);
    }

    public function destroy(string $id): JsonResponse
    {
        return response()->json(['message' => 'stub: DELETE /api/v1/spouse-links/{id}', 'todo' => 'AC-3 delete', 'id' => $id], 501);
    }
}
