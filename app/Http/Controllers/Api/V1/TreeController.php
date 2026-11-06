<?php

namespace App\Http\Controllers\Api\V1;

use App\Http\Controllers\Controller;
use App\Support\EnsuresCurrentTree;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

class TreeController extends Controller
{
    use EnsuresCurrentTree;

    public function current(Request $request): JsonResponse
    {
        $tree = $this->currentTreeFor($request->user());

        return response()->json([
            'id' => $tree->id,
            'title' => $tree->title,
            'owner_user_id' => $tree->owner_user_id,
        ]);
    }
}
