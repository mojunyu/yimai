<?php

namespace Tests\Feature;

use App\Models\Person;
use App\Models\Tree;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

class PersonAc2Test extends TestCase
{
    use RefreshDatabase;

    public function test_patch_parents_then_tree_has_parent_edges(): void
    {
        $user = User::factory()->create();
        Sanctum::actingAs($user);

        $tree = Tree::query()->create([
            'owner_user_id' => $user->id,
            'title' => '我的家族',
        ]);

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

        $child = Person::query()->create([
            'tree_id' => $tree->id,
            'name' => '子',
            'gender' => 'unknown',
            'generation' => 2,
        ]);

        $patch = $this->patchJson('/api/v1/persons/'.$child->id, [
            'father_id' => $father->id,
            'mother_id' => $mother->id,
        ]);

        $patch->assertOk()
            ->assertJsonPath('father_id', $father->id)
            ->assertJsonPath('mother_id', $mother->id);

        $treeJson = $this->getJson('/api/v1/persons/'.$child->id.'/tree');

        $treeJson->assertOk()
            ->assertJsonPath('root_id', $child->id);

        $nodeIds = collect($treeJson->json('nodes'))->pluck('id')->all();
        $this->assertContains($child->id, $nodeIds);
        $this->assertContains($father->id, $nodeIds);
        $this->assertContains($mother->id, $nodeIds);

        $edges = collect($treeJson->json('edges'));
        $parentEdges = $edges->where('type', 'parent')->values();

        $this->assertTrue(
            $parentEdges->contains(fn ($e) => $e['from'] === $father->id && $e['to'] === $child->id),
            'expected father→child parent edge'
        );
        $this->assertTrue(
            $parentEdges->contains(fn ($e) => $e['from'] === $mother->id && $e['to'] === $child->id),
            'expected mother→child parent edge'
        );
    }

    public function test_self_parent_returns_422(): void
    {
        $user = User::factory()->create();
        Sanctum::actingAs($user);

        $tree = Tree::query()->create([
            'owner_user_id' => $user->id,
            'title' => '我的家族',
        ]);

        $person = Person::query()->create([
            'tree_id' => $tree->id,
            'name' => '自',
            'gender' => 'unknown',
            'generation' => 1,
        ]);

        $this->patchJson('/api/v1/persons/'.$person->id, [
            'father_id' => $person->id,
        ])->assertStatus(422)
            ->assertJsonValidationErrors(['father_id']);
    }

    public function test_parent_cycle_returns_422(): void
    {
        $user = User::factory()->create();
        Sanctum::actingAs($user);

        $tree = Tree::query()->create([
            'owner_user_id' => $user->id,
            'title' => '我的家族',
        ]);

        $a = Person::query()->create([
            'tree_id' => $tree->id,
            'name' => 'A',
            'gender' => 'male',
            'generation' => 1,
        ]);

        $b = Person::query()->create([
            'tree_id' => $tree->id,
            'name' => 'B',
            'gender' => 'male',
            'generation' => 2,
            'father_id' => $a->id,
        ]);

        // A ← B already; setting A.father = B would cycle.
        $this->patchJson('/api/v1/persons/'.$a->id, [
            'father_id' => $b->id,
        ])->assertStatus(422)
            ->assertJsonValidationErrors(['father_id']);
    }

    public function test_three_node_cycle_returns_422(): void
    {
        $user = User::factory()->create();
        Sanctum::actingAs($user);

        $tree = Tree::query()->create([
            'owner_user_id' => $user->id,
            'title' => '我的家族',
        ]);

        $a = Person::query()->create([
            'tree_id' => $tree->id,
            'name' => 'A',
            'gender' => 'male',
            'generation' => 1,
        ]);

        $b = Person::query()->create([
            'tree_id' => $tree->id,
            'name' => 'B',
            'gender' => 'male',
            'generation' => 2,
            'father_id' => $a->id,
        ]);

        $c = Person::query()->create([
            'tree_id' => $tree->id,
            'name' => 'C',
            'gender' => 'male',
            'generation' => 3,
            'father_id' => $b->id,
        ]);

        // A→B→C; setting C as father of A cycles.
        $this->patchJson('/api/v1/persons/'.$a->id, [
            'father_id' => $c->id,
        ])->assertStatus(422)
            ->assertJsonValidationErrors(['father_id']);
    }

    public function test_parent_from_other_tree_returns_422(): void
    {
        $user = User::factory()->create();
        $other = User::factory()->create();
        Sanctum::actingAs($user);

        $tree = Tree::query()->create([
            'owner_user_id' => $user->id,
            'title' => '我的家族',
        ]);

        $otherTree = Tree::query()->create([
            'owner_user_id' => $other->id,
            'title' => '别人的家族',
        ]);

        $outsider = Person::query()->create([
            'tree_id' => $otherTree->id,
            'name' => '外人',
            'gender' => 'male',
            'generation' => 1,
        ]);

        $child = Person::query()->create([
            'tree_id' => $tree->id,
            'name' => '子',
            'gender' => 'unknown',
            'generation' => 2,
        ]);

        $this->patchJson('/api/v1/persons/'.$child->id, [
            'father_id' => $outsider->id,
        ])->assertStatus(422)
            ->assertJsonValidationErrors(['father_id']);
    }

    public function test_overwrite_existing_father_returns_422(): void
    {
        $user = User::factory()->create();
        Sanctum::actingAs($user);
        $tree = Tree::query()->create([
            'owner_user_id' => $user->id,
            'title' => '我的家族',
        ]);
        $fatherA = Person::query()->create([
            'tree_id' => $tree->id,
            'name' => '父甲',
            'gender' => 'male',
            'generation' => 1,
        ]);
        $fatherB = Person::query()->create([
            'tree_id' => $tree->id,
            'name' => '父乙',
            'gender' => 'male',
            'generation' => 1,
        ]);
        $child = Person::query()->create([
            'tree_id' => $tree->id,
            'name' => '子',
            'gender' => 'unknown',
            'generation' => 2,
            'father_id' => $fatherA->id,
        ]);

        $this->patchJson('/api/v1/persons/'.$child->id, [
            'father_id' => $fatherB->id,
        ])->assertStatus(422)
            ->assertJsonValidationErrors(['father_id']);

        $this->assertDatabaseHas('persons', [
            'id' => $child->id,
            'father_id' => $fatherA->id,
        ]);
    }

    public function test_overwrite_existing_mother_returns_422(): void
    {
        $user = User::factory()->create();
        Sanctum::actingAs($user);
        $tree = Tree::query()->create([
            'owner_user_id' => $user->id,
            'title' => '我的家族',
        ]);
        $motherA = Person::query()->create([
            'tree_id' => $tree->id,
            'name' => '母甲',
            'gender' => 'female',
            'generation' => 1,
        ]);
        $motherB = Person::query()->create([
            'tree_id' => $tree->id,
            'name' => '母乙',
            'gender' => 'female',
            'generation' => 1,
        ]);
        $child = Person::query()->create([
            'tree_id' => $tree->id,
            'name' => '子',
            'gender' => 'unknown',
            'generation' => 2,
            'mother_id' => $motherA->id,
        ]);

        $this->patchJson('/api/v1/persons/'.$child->id, [
            'mother_id' => $motherB->id,
        ])->assertStatus(422)
            ->assertJsonValidationErrors(['mother_id']);

        $this->assertDatabaseHas('persons', [
            'id' => $child->id,
            'mother_id' => $motherA->id,
        ]);
    }

    public function test_same_father_id_patch_is_idempotent(): void
    {
        $user = User::factory()->create();
        Sanctum::actingAs($user);
        $tree = Tree::query()->create([
            'owner_user_id' => $user->id,
            'title' => '我的家族',
        ]);
        $father = Person::query()->create([
            'tree_id' => $tree->id,
            'name' => '父',
            'gender' => 'male',
            'generation' => 1,
        ]);
        $child = Person::query()->create([
            'tree_id' => $tree->id,
            'name' => '子',
            'gender' => 'unknown',
            'generation' => 2,
            'father_id' => $father->id,
        ]);

        $this->patchJson('/api/v1/persons/'.$child->id, [
            'father_id' => $father->id,
        ])->assertOk()
            ->assertJsonPath('father_id', $father->id);
    }
}
