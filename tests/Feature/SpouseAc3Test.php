<?php

namespace Tests\Feature;

use App\Models\Person;
use App\Models\SpouseLink;
use App\Models\Tree;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

class SpouseAc3Test extends TestCase
{
    use RefreshDatabase;

    public function test_create_spouse_link_then_tree_has_spouse_edge(): void
    {
        $user = User::factory()->create();
        Sanctum::actingAs($user);

        $tree = Tree::query()->create([
            'owner_user_id' => $user->id,
            'title' => '我的家族',
        ]);

        $a = Person::query()->create([
            'tree_id' => $tree->id,
            'name' => '甲',
            'gender' => 'male',
            'generation' => 1,
        ]);

        $b = Person::query()->create([
            'tree_id' => $tree->id,
            'name' => '乙',
            'gender' => 'female',
            'generation' => 1,
        ]);

        $create = $this->postJson('/api/v1/spouse-links', [
            'person_a_id' => $a->id,
            'person_b_id' => $b->id,
        ]);

        $create->assertCreated()
            ->assertJsonPath('person_a_id', $a->id)
            ->assertJsonPath('person_b_id', $b->id)
            ->assertJsonPath('end_year', null);

        $linkId = $create->json('id');
        $this->assertNotNull($linkId);

        $list = $this->getJson('/api/v1/spouse-links');
        $list->assertOk();
        $this->assertCount(1, $list->json('data'));
        $this->assertSame($linkId, $list->json('data.0.id'));

        $treeJson = $this->getJson('/api/v1/persons/'.$a->id.'/tree');
        $treeJson->assertOk()->assertJsonPath('root_id', $a->id);

        $spouseEdges = collect($treeJson->json('edges'))->where('type', 'spouse')->values();
        $this->assertCount(1, $spouseEdges);
        $edge = $spouseEdges->first();
        $this->assertSame($a->id, $edge['a']);
        $this->assertSame($b->id, $edge['b']);
        $this->assertSame($linkId, $edge['link_id']);
    }

    public function test_self_spouse_returns_422(): void
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

        $this->postJson('/api/v1/spouse-links', [
            'person_a_id' => $person->id,
            'person_b_id' => $person->id,
        ])->assertStatus(422)
            ->assertJsonValidationErrors(['person_b_id']);
    }

    public function test_duplicate_open_pair_returns_422(): void
    {
        $user = User::factory()->create();
        Sanctum::actingAs($user);

        $tree = Tree::query()->create([
            'owner_user_id' => $user->id,
            'title' => '我的家族',
        ]);

        $a = Person::query()->create([
            'tree_id' => $tree->id,
            'name' => '甲',
            'gender' => 'male',
            'generation' => 1,
        ]);

        $b = Person::query()->create([
            'tree_id' => $tree->id,
            'name' => '乙',
            'gender' => 'female',
            'generation' => 1,
        ]);

        $this->postJson('/api/v1/spouse-links', [
            'person_a_id' => $a->id,
            'person_b_id' => $b->id,
        ])->assertCreated();

        // Same order
        $this->postJson('/api/v1/spouse-links', [
            'person_a_id' => $a->id,
            'person_b_id' => $b->id,
        ])->assertStatus(422)
            ->assertJsonValidationErrors(['person_b_id']);

        // Reversed order still counts as same unordered pair
        $this->postJson('/api/v1/spouse-links', [
            'person_a_id' => $b->id,
            'person_b_id' => $a->id,
        ])->assertStatus(422)
            ->assertJsonValidationErrors(['person_b_id']);
    }

    public function test_ended_pair_can_create_new_open_link(): void
    {
        $user = User::factory()->create();
        Sanctum::actingAs($user);

        $tree = Tree::query()->create([
            'owner_user_id' => $user->id,
            'title' => '我的家族',
        ]);

        $a = Person::query()->create([
            'tree_id' => $tree->id,
            'name' => '甲',
            'gender' => 'male',
            'generation' => 1,
        ]);

        $b = Person::query()->create([
            'tree_id' => $tree->id,
            'name' => '乙',
            'gender' => 'female',
            'generation' => 1,
        ]);

        $first = $this->postJson('/api/v1/spouse-links', [
            'person_a_id' => $a->id,
            'person_b_id' => $b->id,
            'start_year' => 1990,
        ])->assertCreated();

        $this->patchJson('/api/v1/spouse-links/'.$first->json('id'), [
            'end_year' => 2000,
        ])->assertOk()
            ->assertJsonPath('end_year', 2000);

        $this->postJson('/api/v1/spouse-links', [
            'person_a_id' => $a->id,
            'person_b_id' => $b->id,
            'start_year' => 2005,
        ])->assertCreated()
            ->assertJsonPath('start_year', 2005)
            ->assertJsonPath('end_year', null);
    }

    public function test_patch_and_delete_spouse_link(): void
    {
        $user = User::factory()->create();
        Sanctum::actingAs($user);

        $tree = Tree::query()->create([
            'owner_user_id' => $user->id,
            'title' => '我的家族',
        ]);

        $a = Person::query()->create([
            'tree_id' => $tree->id,
            'name' => '甲',
            'gender' => 'male',
            'generation' => 1,
        ]);

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

        $this->patchJson('/api/v1/spouse-links/'.$link->id, [
            'note' => '初婚',
            'start_year' => 1988,
        ])->assertOk()
            ->assertJsonPath('note', '初婚')
            ->assertJsonPath('start_year', 1988);

        $this->deleteJson('/api/v1/spouse-links/'.$link->id)
            ->assertNoContent();

        $this->assertDatabaseMissing('spouse_links', ['id' => $link->id]);

        $treeJson = $this->getJson('/api/v1/persons/'.$a->id.'/tree');
        $spouseEdges = collect($treeJson->json('edges'))->where('type', 'spouse');
        $this->assertCount(0, $spouseEdges);
    }

    public function test_person_from_other_tree_returns_422(): void
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

        $a = Person::query()->create([
            'tree_id' => $tree->id,
            'name' => '甲',
            'gender' => 'male',
            'generation' => 1,
        ]);

        $outsider = Person::query()->create([
            'tree_id' => $otherTree->id,
            'name' => '外人',
            'gender' => 'female',
            'generation' => 1,
        ]);

        $this->postJson('/api/v1/spouse-links', [
            'person_a_id' => $a->id,
            'person_b_id' => $outsider->id,
        ])->assertStatus(422)
            ->assertJsonValidationErrors(['person_b_id']);
    }
}
