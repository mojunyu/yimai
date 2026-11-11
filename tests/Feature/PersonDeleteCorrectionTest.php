<?php

namespace Tests\Feature;

use App\Models\Person;
use App\Models\SiblingLink;
use App\Models\SpouseLink;
use App\Models\Tree;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Laravel\Sanctum\Sanctum;
use PHPUnit\Framework\Attributes\TestDox;
use Tests\TestCase;

/**
 * 2026-11-11 delete-correction API contracts (no new endpoints).
 */
class PersonDeleteCorrectionTest extends TestCase
{
    use RefreshDatabase;

    #[TestDox('DEL-3/AC-5: 409 keeps English children message and lists child id+name; no mutations')]
    public function test_delete_with_children_returns_409_with_english_message_and_children_list(): void
    {
        [$user, $tree, $parent] = $this->seedTreeWithPerson('父', gender: 'male');
        Sanctum::actingAs($user);

        $child = Person::query()->create([
            'tree_id' => $tree->id,
            'name' => '子甲',
            'gender' => 'male',
            'generation' => 2,
            'father_id' => $parent->id,
        ]);
        $child2 = Person::query()->create([
            'tree_id' => $tree->id,
            'name' => '子乙',
            'gender' => 'female',
            'generation' => 2,
            'father_id' => $parent->id,
        ]);

        $spouse = Person::query()->create([
            'tree_id' => $tree->id,
            'name' => '配偶',
            'gender' => 'female',
            'generation' => 1,
        ]);
        $spouseLink = SpouseLink::query()->create([
            'tree_id' => $tree->id,
            'person_a_id' => $parent->id,
            'person_b_id' => $spouse->id,
        ]);

        $response = $this->deleteJson('/api/v1/persons/'.$parent->id)
            ->assertStatus(409);

        $message = (string) $response->json('message');
        $this->assertStringContainsString('children', $message);

        $children = collect($response->json('children'));
        $this->assertCount(2, $children);
        $this->assertTrue($children->contains(fn ($c) => (int) $c['id'] === $child->id && $c['name'] === '子甲'));
        $this->assertTrue($children->contains(fn ($c) => (int) $c['id'] === $child2->id && $c['name'] === '子乙'));

        $this->assertDatabaseHas('persons', ['id' => $parent->id]);
        $this->assertDatabaseHas('persons', ['id' => $child->id]);
        $this->assertDatabaseHas('persons', ['id' => $child2->id]);
        $this->assertDatabaseHas('spouse_links', ['id' => $spouseLink->id]);
        $this->assertSame($parent->id, Person::query()->find($child->id)?->father_id);
    }

    #[TestDox('DEL-3: spouse-only person deletes with 204; counterpart remains')]
    public function test_spouse_only_deletion_allowed_counterpart_remains(): void
    {
        [$user, $tree, $a] = $this->seedTreeWithPerson('甲', gender: 'male');
        Sanctum::actingAs($user);

        $b = Person::query()->create([
            'tree_id' => $tree->id,
            'name' => '乙',
            'gender' => 'female',
            'generation' => 1,
        ]);
        $link = SpouseLink::query()->create([
            'tree_id' => $tree->id,
            'person_a_id' => $a->id,
            'person_b_id' => $b->id,
        ]);

        $this->deleteJson('/api/v1/persons/'.$a->id)->assertNoContent();

        $this->assertDatabaseMissing('persons', ['id' => $a->id]);
        $this->assertDatabaseHas('persons', ['id' => $b->id]);
        $this->assertDatabaseMissing('spouse_links', ['id' => $link->id]);
    }

    #[TestDox('DEL-5: allowed delete removes incident spouse/sibling edges only; non-incident unchanged')]
    public function test_allowed_delete_cleans_incident_edges_keeps_nonincident(): void
    {
        [$user, $tree, $t] = $this->seedTreeWithPerson('目标', gender: 'male');
        Sanctum::actingAs($user);

        $s = Person::query()->create([
            'tree_id' => $tree->id,
            'name' => '配偶',
            'gender' => 'female',
            'generation' => 1,
        ]);
        $b = Person::query()->create([
            'tree_id' => $tree->id,
            'name' => '兄妹',
            'gender' => 'male',
            'generation' => 1,
        ]);
        $x = Person::query()->create([
            'tree_id' => $tree->id,
            'name' => '无关甲',
            'gender' => 'male',
            'generation' => 1,
        ]);
        $y = Person::query()->create([
            'tree_id' => $tree->id,
            'name' => '无关乙',
            'gender' => 'female',
            'generation' => 1,
        ]);

        $spouseTs = SpouseLink::query()->create([
            'tree_id' => $tree->id,
            'person_a_id' => $t->id,
            'person_b_id' => $s->id,
        ]);
        $siblingTb = SiblingLink::query()->create([
            'tree_id' => $tree->id,
            'person_a_id' => min($t->id, $b->id),
            'person_b_id' => max($t->id, $b->id),
        ]);
        $spouseXy = SpouseLink::query()->create([
            'tree_id' => $tree->id,
            'person_a_id' => $x->id,
            'person_b_id' => $y->id,
        ]);
        $siblingXy = SiblingLink::query()->create([
            'tree_id' => $tree->id,
            'person_a_id' => min($x->id, $y->id),
            'person_b_id' => max($x->id, $y->id),
        ]);

        $this->deleteJson('/api/v1/persons/'.$t->id)->assertNoContent();

        $this->assertDatabaseMissing('persons', ['id' => $t->id]);
        $this->assertDatabaseHas('persons', ['id' => $s->id]);
        $this->assertDatabaseHas('persons', ['id' => $b->id]);
        $this->assertDatabaseHas('persons', ['id' => $x->id]);
        $this->assertDatabaseHas('persons', ['id' => $y->id]);
        $this->assertDatabaseMissing('spouse_links', ['id' => $spouseTs->id]);
        $this->assertDatabaseMissing('sibling_links', ['id' => $siblingTb->id]);
        $this->assertDatabaseHas('spouse_links', ['id' => $spouseXy->id]);
        $this->assertDatabaseHas('sibling_links', ['id' => $siblingXy->id]);

        $treeJson = $this->getJson('/api/v1/persons/'.$s->id.'/tree')->assertOk()->json();
        $dangling = collect($treeJson['edges'])->filter(function ($e) use ($t) {
            $ids = array_filter([
                $e['from'] ?? null,
                $e['to'] ?? null,
                $e['a'] ?? null,
                $e['b'] ?? null,
            ]);

            return in_array($t->id, $ids, true);
        });
        $this->assertCount(0, $dangling);
    }

    #[TestDox('DEL-4: PATCH father_id/mother_id null clears only that slot; both people remain')]
    public function test_parent_slot_null_clears_only_target_slot(): void
    {
        [$user, $tree, $child] = $this->seedTreeWithPerson('子女', gender: 'unknown', generation: 2);
        Sanctum::actingAs($user);

        $father = Person::query()->create([
            'tree_id' => $tree->id,
            'name' => '父',
            'gender' => 'male',
            'generation' => 1,
        ]);
        $mother = Person::query()->create([
            'tree_id' => $tree->id,
            'name' => '母',
            'gender' => 'female',
            'generation' => 1,
        ]);
        $child->father_id = $father->id;
        $child->mother_id = $mother->id;
        $child->save();

        $this->patchJson('/api/v1/persons/'.$child->id, ['father_id' => null])
            ->assertOk()
            ->assertJsonPath('father_id', null)
            ->assertJsonPath('mother_id', $mother->id);

        $this->assertDatabaseHas('persons', ['id' => $father->id]);
        $this->assertDatabaseHas('persons', ['id' => $mother->id]);
        $this->assertDatabaseHas('persons', ['id' => $child->id, 'mother_id' => $mother->id, 'father_id' => null]);

        $this->patchJson('/api/v1/persons/'.$child->id, ['mother_id' => null])
            ->assertOk()
            ->assertJsonPath('mother_id', null);

        $this->assertDatabaseHas('persons', ['id' => $mother->id]);
    }

    #[TestDox('DEL-4: DELETE spouse-links/{id} and sibling-links/{id} remove exact link only')]
    public function test_exact_link_delete_keeps_people_and_other_links(): void
    {
        [$user, $tree, $a] = $this->seedTreeWithPerson('甲', gender: 'male');
        Sanctum::actingAs($user);

        $b = Person::query()->create([
            'tree_id' => $tree->id,
            'name' => '乙',
            'gender' => 'female',
            'generation' => 1,
        ]);
        $c = Person::query()->create([
            'tree_id' => $tree->id,
            'name' => '丙',
            'gender' => 'male',
            'generation' => 1,
        ]);
        $d = Person::query()->create([
            'tree_id' => $tree->id,
            'name' => '丁',
            'gender' => 'female',
            'generation' => 1,
        ]);

        $spouseAb = $this->postJson('/api/v1/spouse-links', [
            'person_a_id' => $a->id,
            'person_b_id' => $b->id,
        ])->assertCreated()->json();
        $spouseCd = $this->postJson('/api/v1/spouse-links', [
            'person_a_id' => $c->id,
            'person_b_id' => $d->id,
        ])->assertCreated()->json();
        $sibAb = $this->postJson('/api/v1/sibling-links', [
            'person_a_id' => $a->id,
            'person_b_id' => $c->id,
        ])->assertCreated()->json();
        $sibBd = $this->postJson('/api/v1/sibling-links', [
            'person_a_id' => $b->id,
            'person_b_id' => $d->id,
        ])->assertCreated()->json();

        $this->deleteJson('/api/v1/spouse-links/'.$spouseAb['id'])->assertNoContent();
        $this->assertDatabaseMissing('spouse_links', ['id' => $spouseAb['id']]);
        $this->assertDatabaseHas('spouse_links', ['id' => $spouseCd['id']]);
        $this->assertDatabaseHas('persons', ['id' => $a->id]);
        $this->assertDatabaseHas('persons', ['id' => $b->id]);

        $this->deleteJson('/api/v1/sibling-links/'.$sibAb['id'])->assertNoContent();
        $this->assertDatabaseMissing('sibling_links', ['id' => $sibAb['id']]);
        $this->assertDatabaseHas('sibling_links', ['id' => $sibBd['id']]);
        $this->assertDatabaseHas('persons', ['id' => $c->id]);
    }

    #[TestDox('DEL-5/AC-6: foreign tree cannot delete; owner unchanged')]
    public function test_foreign_tree_delete_person_is_404_owner_untouched(): void
    {
        [$owner, $tree, $person] = $this->seedTreeWithPerson('主人', gender: 'male');
        $outsider = User::factory()->create();
        Tree::query()->create([
            'owner_user_id' => $outsider->id,
            'title' => '外人家族',
        ]);

        Sanctum::actingAs($outsider);
        $this->deleteJson('/api/v1/persons/'.$person->id)->assertNotFound();

        $this->assertDatabaseHas('persons', ['id' => $person->id, 'tree_id' => $tree->id]);
        Sanctum::actingAs($owner);
        $this->getJson('/api/v1/persons/'.$person->id)->assertOk();
    }

    #[TestDox('DEL-3: after clearing mistaken parent, original parent id can be deleted')]
    public function test_after_child_parent_correction_original_parent_deletes(): void
    {
        [$user, $tree, $parent] = $this->seedTreeWithPerson('误认父', gender: 'male');
        Sanctum::actingAs($user);

        $child = Person::query()->create([
            'tree_id' => $tree->id,
            'name' => '子女',
            'gender' => 'unknown',
            'generation' => 2,
            'father_id' => $parent->id,
        ]);

        $this->deleteJson('/api/v1/persons/'.$parent->id)->assertStatus(409);

        $this->patchJson('/api/v1/persons/'.$child->id, ['father_id' => null])
            ->assertOk()
            ->assertJsonPath('father_id', null);

        $this->deleteJson('/api/v1/persons/'.$parent->id)->assertNoContent();
        $this->assertDatabaseMissing('persons', ['id' => $parent->id]);
        $this->assertDatabaseHas('persons', ['id' => $child->id]);
    }

    /**
     * @return array{0: User, 1: Tree, 2: Person}
     */
    private function seedTreeWithPerson(string $name, string $gender = 'unknown', int $generation = 1): array
    {
        $user = User::factory()->create();
        $tree = Tree::query()->create([
            'owner_user_id' => $user->id,
            'title' => '隔离测试家族',
        ]);
        $person = Person::query()->create([
            'tree_id' => $tree->id,
            'name' => $name,
            'gender' => $gender,
            'generation' => $generation,
        ]);

        return [$user, $tree, $person];
    }
}
