<?php

namespace Tests\Feature;

use App\Models\Person;
use App\Models\SiblingLink;
use App\Models\Tree;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Laravel\Sanctum\Sanctum;
use PHPUnit\Framework\Attributes\TestDox;
use Tests\TestCase;

/**
 * SIB-AC (cut 2026-11-11): explicit two-person sibling links.
 */
class SiblingAcTest extends TestCase
{
    use RefreshDatabase;

    #[TestDox('SIB-AC1 null parents: sibling edge only, no parent edges/fields')]
    public function test_sib_ac1_null_parents_create_sibling_edge_without_parent_edges(): void
    {
        [$user, $tree, $a] = $this->seedUserWithPerson('甲', parents: false);
        Sanctum::actingAs($user);

        $b = Person::query()->create([
            'tree_id' => $tree->id,
            'name' => '乙',
            'gender' => 'male',
            'generation' => 1,
        ]);

        $this->assertNull($a->fresh()->father_id);
        $this->assertNull($a->fresh()->mother_id);
        $this->assertNull($b->fresh()->father_id);
        $this->assertNull($b->fresh()->mother_id);

        $create = $this->postJson('/api/v1/sibling-links', [
            'person_a_id' => $a->id,
            'person_b_id' => $b->id,
        ]);

        $create->assertCreated()
            ->assertJsonPath('person_a_id', min($a->id, $b->id))
            ->assertJsonPath('person_b_id', max($a->id, $b->id));

        $linkId = $create->json('id');

        $list = $this->getJson('/api/v1/sibling-links')->assertOk();
        $this->assertCount(1, $list->json('data'));
        $this->assertSame($linkId, $list->json('data.0.id'));

        $treeJson = $this->getJson('/api/v1/persons/'.$a->id.'/tree')->assertOk();
        $edges = collect($treeJson->json('edges'));
        $siblingEdges = $edges->where('type', 'sibling')->values();
        $parentEdges = $edges->where('type', 'parent')->values();

        $this->assertCount(1, $siblingEdges);
        $this->assertSame($linkId, $siblingEdges[0]['link_id']);
        $this->assertSame(min($a->id, $b->id), $siblingEdges[0]['a']);
        $this->assertSame(max($a->id, $b->id), $siblingEdges[0]['b']);
        $this->assertCount(0, $parentEdges);

        $this->assertNull($a->fresh()->father_id);
        $this->assertNull($a->fresh()->mother_id);
        $this->assertNull($b->fresh()->father_id);
        $this->assertNull($b->fresh()->mother_id);
    }

    #[TestDox('SIB-AC2 self-link 422; same-name half-siblings keep distinct parents')]
    public function test_sib_ac2_self_link_rejected_and_different_parents_untouched(): void
    {
        [$user, $tree, $a] = $this->seedUserWithPerson('同名甲', parents: false);
        Sanctum::actingAs($user);

        $fatherA = Person::query()->create([
            'tree_id' => $tree->id,
            'name' => '父A',
            'gender' => 'male',
            'generation' => 1,
        ]);
        $fatherB = Person::query()->create([
            'tree_id' => $tree->id,
            'name' => '父B',
            'gender' => 'male',
            'generation' => 1,
        ]);

        $a->father_id = $fatherA->id;
        $a->save();

        $b = Person::query()->create([
            'tree_id' => $tree->id,
            'name' => '同名甲',
            'gender' => 'male',
            'generation' => 2,
            'father_id' => $fatherB->id,
        ]);

        $this->postJson('/api/v1/sibling-links', [
            'person_a_id' => $a->id,
            'person_b_id' => $a->id,
        ])->assertStatus(422)
            ->assertJsonValidationErrors(['person_b_id']);

        $this->postJson('/api/v1/sibling-links', [
            'person_a_id' => $a->id,
            'person_b_id' => $b->id,
        ])->assertCreated();

        $this->assertSame($fatherA->id, $a->fresh()->father_id);
        $this->assertSame($fatherB->id, $b->fresh()->father_id);
        $this->assertNotSame($a->fresh()->father_id, $b->fresh()->father_id);
        $this->assertSame(2, Person::query()->where('tree_id', $tree->id)->where('name', '同名甲')->count());
    }

    #[TestDox('SIB-AC3 AB/BA/repeat → one canonical link (serial idempotent)')]
    public function test_sib_ac3_unordered_pair_is_idempotent_and_unique(): void
    {
        [$user, $tree, $a] = $this->seedUserWithPerson('甲', parents: false);
        Sanctum::actingAs($user);

        $b = Person::query()->create([
            'tree_id' => $tree->id,
            'name' => '乙',
            'gender' => 'female',
            'generation' => 1,
        ]);

        $first = $this->postJson('/api/v1/sibling-links', [
            'person_a_id' => $a->id,
            'person_b_id' => $b->id,
        ])->assertCreated();

        $linkId = $first->json('id');
        $canonicalA = $first->json('person_a_id');
        $canonicalB = $first->json('person_b_id');
        $this->assertSame(min($a->id, $b->id), $canonicalA);
        $this->assertSame(max($a->id, $b->id), $canonicalB);

        $reverse = $this->postJson('/api/v1/sibling-links', [
            'person_a_id' => $b->id,
            'person_b_id' => $a->id,
        ])->assertOk();

        $this->assertSame($linkId, $reverse->json('id'));

        $repeat = $this->postJson('/api/v1/sibling-links', [
            'person_a_id' => $a->id,
            'person_b_id' => $b->id,
        ])->assertOk();

        $this->assertSame($linkId, $repeat->json('id'));
        $this->assertSame(1, SiblingLink::query()->where('tree_id', $tree->id)->count());

        $treeJson = $this->getJson('/api/v1/persons/'.$a->id.'/tree')->assertOk();
        $siblingEdges = collect($treeJson->json('edges'))->where('type', 'sibling')->values();
        $this->assertCount(1, $siblingEdges);
    }

    #[TestDox('SIB-AC4 PATCH parents on A does not mutate B; conflict still 422')]
    public function test_sib_ac4_adding_parents_to_a_does_not_mutate_b_or_overwrite(): void
    {
        [$user, $tree, $a] = $this->seedUserWithPerson('甲', parents: false);
        Sanctum::actingAs($user);

        $b = Person::query()->create([
            'tree_id' => $tree->id,
            'name' => '乙',
            'gender' => 'male',
            'generation' => 1,
        ]);

        $existingFatherForB = Person::query()->create([
            'tree_id' => $tree->id,
            'name' => '乙父',
            'gender' => 'male',
            'generation' => 1,
        ]);
        $b->father_id = $existingFatherForB->id;
        $b->save();

        $this->postJson('/api/v1/sibling-links', [
            'person_a_id' => $a->id,
            'person_b_id' => $b->id,
        ])->assertCreated();

        $beforeB = $b->fresh()->only(['father_id', 'mother_id', 'name']);

        $newFather = Person::query()->create([
            'tree_id' => $tree->id,
            'name' => '甲父',
            'gender' => 'male',
            'generation' => 1,
        ]);

        $this->patchJson('/api/v1/persons/'.$a->id, [
            'father_id' => $newFather->id,
        ])->assertOk()
            ->assertJsonPath('father_id', $newFather->id);

        $this->assertSame($beforeB['father_id'], $b->fresh()->father_id);
        $this->assertSame($beforeB['mother_id'], $b->fresh()->mother_id);

        $otherFather = Person::query()->create([
            'tree_id' => $tree->id,
            'name' => '别人父',
            'gender' => 'male',
            'generation' => 1,
        ]);

        $this->patchJson('/api/v1/persons/'.$b->id, [
            'father_id' => $otherFather->id,
        ])->assertStatus(422);

        $this->assertSame($existingFatherForB->id, $b->fresh()->father_id);
    }

    #[TestDox('SIB-AC5 A-B + B-C does not emit A-C sibling edge')]
    public function test_sib_ac5_chain_does_not_infer_ac_edge(): void
    {
        [$user, $tree, $a] = $this->seedUserWithPerson('A', parents: false);
        Sanctum::actingAs($user);

        $b = Person::query()->create([
            'tree_id' => $tree->id,
            'name' => 'B',
            'gender' => 'male',
            'generation' => 1,
        ]);
        $c = Person::query()->create([
            'tree_id' => $tree->id,
            'name' => 'C',
            'gender' => 'male',
            'generation' => 1,
        ]);

        $this->postJson('/api/v1/sibling-links', [
            'person_a_id' => $a->id,
            'person_b_id' => $b->id,
        ])->assertCreated();

        $this->postJson('/api/v1/sibling-links', [
            'person_a_id' => $b->id,
            'person_b_id' => $c->id,
        ])->assertCreated();

        $this->assertSame(2, SiblingLink::query()->where('tree_id', $tree->id)->count());

        $treeJson = $this->getJson('/api/v1/persons/'.$a->id.'/tree')->assertOk();
        $siblingEdges = collect($treeJson->json('edges'))->where('type', 'sibling');

        $this->assertCount(2, $siblingEdges);
        $hasAC = $siblingEdges->contains(function (array $e) use ($a, $c) {
            $pair = [min($e['a'], $e['b']), max($e['a'], $e['b'])];

            return $pair === [min($a->id, $c->id), max($a->id, $c->id)];
        });
        $this->assertFalse($hasAC);

        // Separate shared-parent evidence still yields parent edges only (not sibling inference in JSON).
        $parent = Person::query()->create([
            'tree_id' => $tree->id,
            'name' => '共父',
            'gender' => 'male',
            'generation' => 1,
        ]);
        $this->patchJson('/api/v1/persons/'.$a->id, ['father_id' => $parent->id])->assertOk();
        $this->patchJson('/api/v1/persons/'.$c->id, ['father_id' => $parent->id])->assertOk();

        $after = $this->getJson('/api/v1/persons/'.$a->id.'/tree')->assertOk();
        $siblingAfter = collect($after->json('edges'))->where('type', 'sibling');
        $this->assertCount(2, $siblingAfter);
        $parentEdges = collect($after->json('edges'))->where('type', 'parent');
        $this->assertTrue($parentEdges->contains(fn ($e) => $e['from'] === $parent->id && $e['to'] === $a->id));
        $this->assertTrue($parentEdges->contains(fn ($e) => $e['from'] === $parent->id && $e['to'] === $c->id));
    }

    #[TestDox('SIB-AC7/AC5: children→409 leaves person+links; allowed delete removes incident sibling links only')]
    public function test_sib_ac7_delete_person_cleans_sibling_links_ac5_guard_unchanged(): void
    {
        [$user, $tree, $a] = $this->seedUserWithPerson('甲', parents: false);
        Sanctum::actingAs($user);

        $b = Person::query()->create([
            'tree_id' => $tree->id,
            'name' => '乙',
            'gender' => 'male',
            'generation' => 1,
        ]);
        $c = Person::query()->create([
            'tree_id' => $tree->id,
            'name' => '丙',
            'gender' => 'male',
            'generation' => 1,
        ]);
        $child = Person::query()->create([
            'tree_id' => $tree->id,
            'name' => '甲子',
            'gender' => 'male',
            'generation' => 2,
            'father_id' => $a->id,
        ]);

        $linkAb = $this->postJson('/api/v1/sibling-links', [
            'person_a_id' => $a->id,
            'person_b_id' => $b->id,
        ])->assertCreated()->json();

        $linkBc = $this->postJson('/api/v1/sibling-links', [
            'person_a_id' => $b->id,
            'person_b_id' => $c->id,
        ])->assertCreated()->json();

        $this->deleteJson('/api/v1/persons/'.$a->id)
            ->assertStatus(409);

        $this->assertDatabaseHas('persons', ['id' => $a->id]);
        $this->assertDatabaseHas('sibling_links', ['id' => $linkAb['id']]);
        $this->assertDatabaseHas('sibling_links', ['id' => $linkBc['id']]);
        $this->assertSame(2, SiblingLink::query()->where('tree_id', $tree->id)->count());

        $this->patchJson('/api/v1/persons/'.$child->id, ['father_id' => null])->assertOk();

        $this->deleteJson('/api/v1/persons/'.$a->id)->assertNoContent();

        $this->assertDatabaseMissing('persons', ['id' => $a->id]);
        $this->assertDatabaseMissing('sibling_links', ['id' => $linkAb['id']]);
        // Non-incident B–C link must survive A's deletion.
        $this->assertDatabaseHas('sibling_links', ['id' => $linkBc['id']]);
        $this->assertDatabaseHas('persons', ['id' => $b->id]);
        $this->assertDatabaseHas('persons', ['id' => $c->id]);
        $this->assertSame(1, SiblingLink::query()->where('tree_id', $tree->id)->count());
    }

    #[TestDox('SIB cross-tree person bind rejected; forged tree_id on body ignored')]
    public function test_outsider_person_cannot_be_linked(): void
    {
        [$user, $tree, $a] = $this->seedUserWithPerson('甲', parents: false);
        Sanctum::actingAs($user);

        $otherUser = User::factory()->create();
        $otherTree = Tree::query()->create([
            'owner_user_id' => $otherUser->id,
            'title' => '别家',
        ]);
        $outsider = Person::query()->create([
            'tree_id' => $otherTree->id,
            'name' => '外人',
            'gender' => 'male',
            'generation' => 1,
        ]);

        $this->postJson('/api/v1/sibling-links', [
            'person_a_id' => $a->id,
            'person_b_id' => $outsider->id,
            'tree_id' => $otherTree->id,
        ])->assertStatus(422)
            ->assertJsonValidationErrors(['person_b_id']);

        $this->assertSame(0, SiblingLink::query()->count());
    }

    #[TestDox('SIB race: unique constraint after empty check returns 200 with canonical one link')]
    public function test_unique_constraint_race_reconciles_to_existing_pair(): void
    {
        [$user, $tree, $a] = $this->seedUserWithPerson('甲', parents: false);
        Sanctum::actingAs($user);

        $b = Person::query()->create([
            'tree_id' => $tree->id,
            'name' => '乙',
            'gender' => 'female',
            'generation' => 1,
        ]);

        $aId = min($a->id, $b->id);
        $bId = max($a->id, $b->id);

        // Simulate lost race: another request inserts the canonical row between check and insert.
        SiblingLink::creating(function () use ($tree, $aId, $bId) {
            static $injected = false;
            if ($injected) {
                return;
            }
            $injected = true;
            if (SiblingLink::query()->where('tree_id', $tree->id)->where('person_a_id', $aId)->where('person_b_id', $bId)->exists()) {
                return;
            }
            DB::table('sibling_links')->insert([
                'tree_id' => $tree->id,
                'person_a_id' => $aId,
                'person_b_id' => $bId,
                'created_at' => now(),
                'updated_at' => now(),
            ]);
        });

        try {
            $response = $this->postJson('/api/v1/sibling-links', [
                'person_a_id' => $b->id,
                'person_b_id' => $a->id,
            ]);

            $response->assertOk()
                ->assertJsonPath('person_a_id', $aId)
                ->assertJsonPath('person_b_id', $bId);

            $this->assertSame(1, SiblingLink::query()->where('tree_id', $tree->id)->count());
        } finally {
            SiblingLink::flushEventListeners();
        }
    }

    /**
     * @return array{0: User, 1: Tree, 2: Person}
     */
    private function seedUserWithPerson(string $name, bool $parents = false): array
    {
        $user = User::factory()->create();
        $tree = Tree::query()->create([
            'owner_user_id' => $user->id,
            'title' => '我的家族',
        ]);

        $attrs = [
            'tree_id' => $tree->id,
            'name' => $name,
            'gender' => 'male',
            'generation' => 1,
        ];

        if ($parents) {
            $father = Person::query()->create([
                'tree_id' => $tree->id,
                'name' => '父',
                'gender' => 'male',
                'generation' => 1,
            ]);
            $attrs['father_id'] = $father->id;
            $attrs['generation'] = 2;
        }

        $person = Person::query()->create($attrs);

        return [$user, $tree, $person];
    }
}
