<?php

namespace App\Http\Controllers\Api\V1;

use App\Http\Controllers\Controller;
use App\Models\Person;
use App\Models\SpouseLink;
use App\Support\EnsuresCurrentTree;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Validation\ValidationException;

/**
 * AC-3: spouse-link CRUD.
 *
 * Constraints (cut 2026-11-06):
 * - person_a ≠ person_b; same tree
 * - self-spouse → 422
 * - at most one unended (end_year null) link per unordered pair (a,b)
 */
class SpouseLinkController extends Controller
{
    use EnsuresCurrentTree;

    public function index(Request $request): JsonResponse
    {
        $tree = $this->currentTreeFor($request->user());

        $links = SpouseLink::query()
            ->where('tree_id', $tree->id)
            ->orderBy('id')
            ->get()
            ->map(fn (SpouseLink $link) => $this->linkPayload($link));

        return response()->json(['data' => $links]);
    }

    public function store(Request $request): JsonResponse
    {
        $tree = $this->currentTreeFor($request->user());

        $data = $request->validate([
            'person_a_id' => ['required', 'integer'],
            'person_b_id' => ['required', 'integer'],
            'start_year' => ['nullable', 'integer', 'min:1', 'max:9999'],
            'end_year' => ['nullable', 'integer', 'min:1', 'max:9999'],
            'note' => ['nullable', 'string', 'max:200'],
        ]);

        $aId = (int) $data['person_a_id'];
        $bId = (int) $data['person_b_id'];

        if ($aId === $bId) {
            throw ValidationException::withMessages([
                'person_b_id' => ['A person cannot be their own spouse.'],
            ]);
        }

        $this->assertPersonsInTree($tree->id, $aId, $bId);
        $this->assertYearOrder($data['start_year'] ?? null, $data['end_year'] ?? null);

        $endYear = $data['end_year'] ?? null;
        if ($endYear === null) {
            $this->assertNoOpenPair($tree->id, $aId, $bId);
        }

        $link = SpouseLink::query()->create([
            'tree_id' => $tree->id,
            'person_a_id' => $aId,
            'person_b_id' => $bId,
            'start_year' => $data['start_year'] ?? null,
            'end_year' => $endYear,
            'note' => $data['note'] ?? null,
        ]);

        return response()->json($this->linkPayload($link), 201);
    }

    public function update(Request $request, string $id): JsonResponse
    {
        $link = $this->findInCurrentTree($request, $id);

        $data = $request->validate([
            'start_year' => ['sometimes', 'nullable', 'integer', 'min:1', 'max:9999'],
            'end_year' => ['sometimes', 'nullable', 'integer', 'min:1', 'max:9999'],
            'note' => ['sometimes', 'nullable', 'string', 'max:200'],
        ]);

        $nextStart = array_key_exists('start_year', $data) ? $data['start_year'] : $link->start_year;
        $nextEnd = array_key_exists('end_year', $data) ? $data['end_year'] : $link->end_year;
        $this->assertYearOrder($nextStart, $nextEnd);

        // When resulting state is open, enforce unique open pair (exclude self).
        if ($nextEnd === null) {
            $this->assertNoOpenPair(
                $link->tree_id,
                (int) $link->person_a_id,
                (int) $link->person_b_id,
                excludeId: (int) $link->id,
            );
        }

        $link->fill($data);
        $link->save();

        return response()->json($this->linkPayload($link->fresh()));
    }

    public function destroy(Request $request, string $id): JsonResponse
    {
        $link = $this->findInCurrentTree($request, $id);
        $link->delete();

        return response()->json(null, 204);
    }

    private function findInCurrentTree(Request $request, string $id): SpouseLink
    {
        $tree = $this->currentTreeFor($request->user());

        return SpouseLink::query()
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

    private function assertYearOrder(?int $startYear, ?int $endYear): void
    {
        if ($startYear !== null && $endYear !== null && $endYear < $startYear) {
            throw ValidationException::withMessages([
                'end_year' => ['end_year must be greater than or equal to start_year.'],
            ]);
        }
    }

    /**
     * At most one unended link for unordered pair (a,b).
     */
    private function assertNoOpenPair(int $treeId, int $aId, int $bId, ?int $excludeId = null): void
    {
        $query = SpouseLink::query()
            ->where('tree_id', $treeId)
            ->whereNull('end_year')
            ->where(function ($q) use ($aId, $bId) {
                $q->where(function ($inner) use ($aId, $bId) {
                    $inner->where('person_a_id', $aId)->where('person_b_id', $bId);
                })->orWhere(function ($inner) use ($aId, $bId) {
                    $inner->where('person_a_id', $bId)->where('person_b_id', $aId);
                });
            });

        if ($excludeId !== null) {
            $query->where('id', '!=', $excludeId);
        }

        if ($query->exists()) {
            throw ValidationException::withMessages([
                'person_b_id' => ['An open spouse link already exists for this pair.'],
            ]);
        }
    }

    /**
     * @return array<string, mixed>
     */
    private function linkPayload(SpouseLink $link): array
    {
        return [
            'id' => $link->id,
            'tree_id' => $link->tree_id,
            'person_a_id' => $link->person_a_id,
            'person_b_id' => $link->person_b_id,
            'start_year' => $link->start_year,
            'end_year' => $link->end_year,
            'note' => $link->note,
            'created_at' => $link->created_at?->toISOString(),
            'updated_at' => $link->updated_at?->toISOString(),
        ];
    }
}
