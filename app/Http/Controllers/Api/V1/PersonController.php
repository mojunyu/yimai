<?php

namespace App\Http\Controllers\Api\V1;

use App\Http\Controllers\Controller;
use App\Models\Person;
use App\Support\EnsuresCurrentTree;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Validation\Rule;
use Illuminate\Validation\ValidationException;

/**
 * AC-1: person CRUD. Tree JSON (AC-4) and deep parent/spouse rules stay later.
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

        // AC-2 parent binding can land later; accept fields if present but keep AC-1 focused.
        if ($request->exists('father_id') || $request->exists('mother_id')) {
            $parentData = $request->validate([
                'father_id' => ['nullable', 'integer'],
                'mother_id' => ['nullable', 'integer'],
            ]);
            foreach (['father_id', 'mother_id'] as $key) {
                if (! array_key_exists($key, $parentData)) {
                    continue;
                }
                $parentId = $parentData[$key];
                if ($parentId === null) {
                    $data[$key] = null;
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
                $data[$key] = $parentId;
            }
        }

        $person->fill($data);
        $person->save();

        return response()->json($this->personPayload($person->fresh()));
    }

    public function destroy(Request $request, string $id): JsonResponse
    {
        $person = $this->findInCurrentTree($request, $id);

        $hasChildren = Person::query()
            ->where('tree_id', $person->tree_id)
            ->where(function ($q) use ($person) {
                $q->where('father_id', $person->id)
                    ->orWhere('mother_id', $person->id);
            })
            ->exists();

        if ($hasChildren) {
            return response()->json([
                'message' => 'Cannot delete person while children still reference them. Unbind children first.',
            ], 409);
        }

        $person->delete();

        return response()->json(null, 204);
    }

    public function tree(string $id): JsonResponse
    {
        // AC-4 stub — unlock after AC-1…AC-3
        return response()->json([
            'message' => 'stub: GET /api/v1/persons/{id}/tree',
            'todo' => 'AC-4 tree JSON',
            'root_id' => (int) $id,
            'nodes' => [],
            'edges' => [],
        ], 501);
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
