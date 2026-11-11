<?php

namespace App\Http\Controllers\Api\V1;

use App\Http\Controllers\Controller;
use App\Models\Person;
use App\Models\SiblingLink;
use App\Support\EnsuresCurrentTree;
use Illuminate\Database\UniqueConstraintViolationException;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Validation\ValidationException;

/**
 * Explicit two-person sibling links (cut 2026-11-11).
 *
 * - Undirected pair; stored with person_a_id < person_b_id
 * - Unique per (tree_id, a, b); POST is idempotent (200 if exists, 201 if created)
 * - Self-link → 422; persons must belong to current tree
 */
class SiblingLinkController extends Controller
{
    use EnsuresCurrentTree;

    public function index(Request $request): JsonResponse
    {
        $tree = $this->currentTreeFor($request->user());

        $links = SiblingLink::query()
            ->where('tree_id', $tree->id)
            ->orderBy('id')
            ->get()
            ->map(fn (SiblingLink $link) => $this->linkPayload($link));

        return response()->json(['data' => $links]);
    }

    public function store(Request $request): JsonResponse
    {
        $tree = $this->currentTreeFor($request->user());

        $data = $request->validate([
            'person_a_id' => ['required', 'integer'],
            'person_b_id' => ['required', 'integer'],
        ]);

        $rawA = (int) $data['person_a_id'];
        $rawB = (int) $data['person_b_id'];

        if ($rawA === $rawB) {
            throw ValidationException::withMessages([
                'person_b_id' => ['A person cannot be their own sibling.'],
            ]);
        }

        $this->assertPersonsInTree($tree->id, $rawA, $rawB);

        $aId = min($rawA, $rawB);
        $bId = max($rawA, $rawB);

        $existing = $this->findPair($tree->id, $aId, $bId);
        if ($existing !== null) {
            return response()->json($this->linkPayload($existing), 200);
        }

        try {
            $link = SiblingLink::query()->create([
                'tree_id' => $tree->id,
                'person_a_id' => $aId,
                'person_b_id' => $bId,
            ]);
        } catch (UniqueConstraintViolationException $e) {
            // Concurrent AB/BA (or retry) lost the race after the empty check.
            // Reconcile to the surviving canonical row — do not mask unrelated DB errors.
            $existing = $this->findPair($tree->id, $aId, $bId);
            if ($existing === null) {
                throw $e;
            }

            return response()->json($this->linkPayload($existing), 200);
        }

        return response()->json($this->linkPayload($link), 201);
    }

    private function findPair(int $treeId, int $aId, int $bId): ?SiblingLink
    {
        return SiblingLink::query()
            ->where('tree_id', $treeId)
            ->where('person_a_id', $aId)
            ->where('person_b_id', $bId)
            ->first();
    }

    public function destroy(Request $request, string $id): JsonResponse
    {
        $link = $this->findInCurrentTree($request, $id);
        $link->delete();

        return response()->json(null, 204);
    }

    private function findInCurrentTree(Request $request, string $id): SiblingLink
    {
        $tree = $this->currentTreeFor($request->user());

        return SiblingLink::query()
            ->where('tree_id', $tree->id)
            ->where('id', $id)
            ->firstOrFail();
    }

    private function assertPersonsInTree(int $treeId, int $aId, int $bId): void
    {
        foreach (['person_a_id' => $aId, 'person_b_id' => $bId] as $key => $personId) {
            $exists = Person::query()
                ->where('tree_id', $treeId)
                ->where('id', $personId)
                ->exists();
            if (! $exists) {
                throw ValidationException::withMessages([
                    $key => ['Person must belong to the same tree.'],
                ]);
            }
        }
    }

    /**
     * @return array<string, mixed>
     */
    private function linkPayload(SiblingLink $link): array
    {
        return [
            'id' => $link->id,
            'tree_id' => $link->tree_id,
            'person_a_id' => $link->person_a_id,
            'person_b_id' => $link->person_b_id,
            'created_at' => $link->created_at?->toISOString(),
            'updated_at' => $link->updated_at?->toISOString(),
        ];
    }
}
