<?php

namespace App\Http\Controllers\Api\V1;

use App\Http\Controllers\Controller;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/**
 * Stub for AC scaffold. Real current-tree logic lands with AC-1.
 */
class TreeController extends Controller
{
    public function current(Request $request): JsonResponse
    {
        // TODO(AC-1): ensure user has a tree; return { id, title, owner_user_id }
        return response()->json([
            'message' => 'stub: GET /api/v1/trees/current',
            'todo' => 'Return current user tree metadata',
        ], 501);
    }
}
