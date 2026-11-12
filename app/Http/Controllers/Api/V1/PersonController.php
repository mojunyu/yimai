<?php

namespace App\Http\Controllers\Api\V1;

use App\Http\Controllers\Controller;
use App\Models\Person;
use App\Models\SiblingLink;
use App\Models\SpouseLink;
use App\Support\EnsuresCurrentTree;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Collection;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\Rule;
use Illuminate\Validation\ValidationException;

/**
 * AC-1: person CRUD.
 * AC-2: father_id/mother_id binding + cycle hard-fail + parent edges on tree JSON.
 * AC-3: spouse edges on tree JSON (type=spouse with a,b,link_id).
 * SIB (2026-11-11): sibling edges on tree JSON (type=sibling with a,b,link_id).
 *
 * Tree JSON (locked field names for AC-4; sibling added 2026-11-11):
 * {
 *   "root_id": <id>,
 *   "nodes": [{ "id","name","gender","generation","birth_year","death_year" }],
 *   "edges": [
 *     { "type":"parent", "from": <parent_id>, "to": <child_id> },
 *     { "type":"spouse", "a": <id>, "b": <id>, "link_id": <id> },
 *     { "type":"sibling", "a": <id>, "b": <id>, "link_id": <id> }
 *   ]
 * }
 */
class PersonController extends Controller
{
    use EnsuresCurrentTree;

    public function index(Request $request): JsonResponse
    {
        $tree = $this->currentTreeFor($request->user());

        $persons = Person::query()
            ->where('tree_id', $tree->id)
            ->orderBy('generation')
            ->orderBy('id')
            ->get()
            ->map(fn (Person $p) => $this->personPayload($p));

        return response()->json(['data' => $persons]);
    }

    public function store(Request $request): JsonResponse
    {
        $tree = $this->currentTreeFor($request->user());
        $data = $this->validatedPersonAttributes($request);

        $person = Person::query()->create([
            'tree_id' => $tree->id,
            ...$data,
        ]);

        return response()->json($this->personPayload($person), 201);
    }

    public function show(Request $request, string $id): JsonResponse
    {
        $person = $this->findInCurrentTree($request, $id);

        return response()->json($this->personPayload($person));
    }

    public function update(Request $request, string $id): JsonResponse
    {
        $person = $this->findInCurrentTree($request, $id);
        $data = $this->validatedPersonAttributes($request, partial: true);

        if ($request->exists('father_id') || $request->exists('mother_id')) {
            $parentData = $request->validate([
                'father_id' => ['nullable', 'integer'],
                'mother_id' => ['nullable', 'integer'],
            ]);

            $nextFather = array_key_exists('father_id', $parentData)
                ? $parentData['father_id']
                : $person->father_id;
            $nextMother = array_key_exists('mother_id', $parentData)
                ? $parentData['mother_id']
                : $person->mother_id;

            foreach (['father_id' => $nextFather, 'mother_id' => $nextMother] as $key => $parentId) {
                if ($parentId === null) {
                    continue;
                }
                if ((int) $parentId === (int) $person->id) {
                    throw ValidationException::withMessages([
                        $key => ['A person cannot be their own parent.'],
                    ]);
                }
                $exists = Person::query()
                    ->where('tree_id', $person->tree_id)
                    ->where('id', $parentId)
                    ->exists();
                if (! $exists) {
                    throw ValidationException::withMessages([
                        $key => ['Parent must belong to the same tree.'],
                    ]);
                }
            }

            $this->assertNoParentCycle(
                $person,
                $nextFather !== null ? (int) $nextFather : null,
                $nextMother !== null ? (int) $nextMother : null,
            );

            // Refuse silent overwrite of an already-set parent slot.
            // null clears (unbind / AC-5); same id is idempotent; different non-null is 422.
            foreach (['father_id', 'mother_id'] as $slot) {
                if (! array_key_exists($slot, $parentData)) {
                    continue;
                }
                $incoming = $parentData[$slot];
                $current = $person->{$slot};
                if (
                    $current !== null
                    && $incoming !== null
                    && (int) $incoming !== (int) $current
                ) {
                    throw ValidationException::withMessages([
                        $slot => ['Parent slot already set; refusing silent overwrite.'],
                    ]);
                }
                $data[$slot] = $incoming;
            }
        }

        $person->fill($data);
        $person->save();

        return response()->json($this->personPayload($person->fresh()));
    }

    public function destroy(Request $request, string $id): JsonResponse
    {
        $person = $this->findInCurrentTree($request, $id);

        // Application-level child guard (AC-5). Parent FKs use nullOnDelete, so the
        // schema alone does not enforce 409 — re-check inside a transaction before delete.
        return DB::transaction(function () use ($person) {
            $children = Person::query()
                ->where('tree_id', $person->tree_id)
                ->where(function ($q) use ($person) {
                    $q->where('father_id', $person->id)
                        ->orWhere('mother_id', $person->id);
                })
                ->orderBy('id')
                ->get(['id', 'name']);

            if ($children->isNotEmpty()) {
                return response()->json([
                    'message' => 'Cannot delete person while children still reference them. Unbind children first.',
                    'children' => $children->map(fn (Person $child) => [
                        'id' => $child->id,
                        'name' => $child->name,
                    ])->values()->all(),
                ], 409);
            }

            $person->delete();

            return response()->json(null, 204);
        });
    }

    public function tree(Request $request, string $id): JsonResponse
    {
        $root = $this->findInCurrentTree($request, $id);

        /** @var Collection<int, Person> $persons */
        $persons = Person::query()
            ->where('tree_id', $root->tree_id)
            ->orderBy('generation')
            ->orderBy('id')
            ->get();

        $nodes = $persons->map(fn (Person $p) => [
            'id' => $p->id,
            'name' => $p->name,
            'gender' => $p->gender,
            'generation' => $p->generation,
            'birth_year' => $p->birth_year,
            'death_year' => $p->death_year,
        ])->values()->all();

        $edges = [];
        foreach ($persons as $p) {
            if ($p->father_id !== null) {
                $edges[] = [
                    'type' => 'parent',
                    'from' => $p->father_id,
                    'to' => $p->id,
                ];
            }
            if ($p->mother_id !== null) {
                $edges[] = [
                    'type' => 'parent',
                    'from' => $p->mother_id,
                    'to' => $p->id,
                ];
            }
        }

        $spouseLinks = SpouseLink::query()
            ->where('tree_id', $root->tree_id)
            ->orderBy('id')
            ->get();

        foreach ($spouseLinks as $link) {
            $edges[] = [
                'type' => 'spouse',
                'a' => $link->person_a_id,
                'b' => $link->person_b_id,
                'link_id' => $link->id,
            ];
        }

        $siblingLinks = SiblingLink::query()
            ->where('tree_id', $root->tree_id)
            ->orderBy('id')
            ->get();

        foreach ($siblingLinks as $link) {
            $edges[] = [
                'type' => 'sibling',
                'a' => $link->person_a_id,
                'b' => $link->person_b_id,
                'link_id' => $link->id,
            ];
        }

        return response()->json([
            'root_id' => $root->id,
            'nodes' => $nodes,
            'edges' => $edges,
        ]);
    }

    /**
     * Hard-fail if assigning the proposed parents would create a parent-link cycle.
     */
    private function assertNoParentCycle(Person $person, ?int $fatherId, ?int $motherId): void
    {
        $relatives = Person::query()
            ->where('tree_id', $person->tree_id)
            ->get(['id', 'father_id', 'mother_id']);

        $fathers = [];
        $mothers = [];
        foreach ($relatives as $row) {
            $fathers[$row->id] = $row->father_id !== null ? (int) $row->father_id : null;
            $mothers[$row->id] = $row->mother_id !== null ? (int) $row->mother_id : null;
        }

        $fathers[$person->id] = $fatherId;
        $mothers[$person->id] = $motherId;

        foreach (['father_id' => $fatherId, 'mother_id' => $motherId] as $key => $parentId) {
            if ($parentId === null) {
                continue;
            }
            // Cycle if walking up from the proposed parent reaches the child.
            if ($this->ancestorWalkReaches($parentId, $person->id, $fathers, $mothers)) {
                throw ValidationException::withMessages([
                    $key => ['Parent assignment would create a cycle.'],
                ]);
            }
        }
    }

    /**
     * @param  array<int, int|null>  $fathers
     * @param  array<int, int|null>  $mothers
     */
    private function ancestorWalkReaches(int $startId, int $targetId, array $fathers, array $mothers): bool
    {
        $seen = [];
        $stack = [$startId];

        while ($stack !== []) {
            $id = array_pop($stack);
            if ($id === $targetId) {
                return true;
            }
            if (isset($seen[$id])) {
                continue;
            }
            $seen[$id] = true;

            if (! empty($fathers[$id])) {
                $stack[] = $fathers[$id];
            }
            if (! empty($mothers[$id])) {
                $stack[] = $mothers[$id];
            }
        }

        return false;
    }

    /**
     * @return array<string, mixed>
     */
    private function validatedPersonAttributes(Request $request, bool $partial = false): array
    {
        $nameRule = $partial
            ? ['sometimes', 'required', 'string', 'min:1', 'max:64']
            : ['required', 'string', 'min:1', 'max:64'];

        $rules = [
            'name' => $nameRule,
            'gender' => [$partial ? 'sometimes' : 'nullable', Rule::in(['male', 'female', 'unknown'])],
            'generation' => [$partial ? 'sometimes' : 'nullable', 'integer', 'min:1'],
            'birth_year' => ['nullable', 'integer', 'min:1', 'max:9999'],
            'death_year' => ['nullable', 'integer', 'min:1', 'max:9999'],
        ];

        $data = $request->validate($rules);

        if (! $partial) {
            $data['gender'] = $data['gender'] ?? 'unknown';
            $data['generation'] = $data['generation'] ?? 1;
        }

        if (
            array_key_exists('birth_year', $data)
            && array_key_exists('death_year', $data)
            && $data['birth_year'] !== null
            && $data['death_year'] !== null
            && $data['death_year'] < $data['birth_year']
        ) {
            throw ValidationException::withMessages([
                'death_year' => ['death_year must be greater than or equal to birth_year.'],
            ]);
        }

        return $data;
    }

    private function findInCurrentTree(Request $request, string $id): Person
    {
        $tree = $this->currentTreeFor($request->user());

        return Person::query()
            ->where('tree_id', $tree->id)
            ->where('id', $id)
            ->firstOrFail();
    }

    /**
     * @return array<string, mixed>
     */
    private function personPayload(Person $person): array
    {
        return [
            'id' => $person->id,
            'tree_id' => $person->tree_id,
            'name' => $person->name,
            'gender' => $person->gender,
            'generation' => $person->generation,
            'birth_year' => $person->birth_year,
            'death_year' => $person->death_year,
            'father_id' => $person->father_id,
            'mother_id' => $person->mother_id,
            'created_at' => $person->created_at?->toISOString(),
            'updated_at' => $person->updated_at?->toISOString(),
        ];
    }
}
