<?php

namespace Tests\Feature;

use App\Models\Person;
use App\Models\Tree;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

class PersonAc1Test extends TestCase
{
    use RefreshDatabase;

    public function test_authenticated_user_can_create_and_read_person(): void
    {
        $user = User::factory()->create();
        Sanctum::actingAs($user);

        $create = $this->postJson('/api/v1/persons', [
            'name' => '张三',
            'gender' => 'male',
            'generation' => 1,
            'birth_year' => 1950,
            'death_year' => null,
        ]);

        $create->assertCreated()
            ->assertJsonPath('name', '张三')
            ->assertJsonPath('gender', 'male')
            ->assertJsonPath('generation', 1)
            ->assertJsonPath('birth_year', 1950)
            ->assertJsonPath('death_year', null);

        $id = $create->json('id');
        $this->assertNotNull($id);

        $tree = Tree::query()->where('owner_user_id', $user->id)->first();
        $this->assertNotNull($tree);
        $this->assertSame($tree->id, $create->json('tree_id'));

        $show = $this->getJson('/api/v1/persons/'.$id);
        $show->assertOk()
            ->assertJsonPath('id', $id)
            ->assertJsonPath('name', '张三')
            ->assertJsonPath('gender', 'male')
            ->assertJsonPath('generation', 1)
            ->assertJsonPath('birth_year', 1950);
    }

    public function test_create_person_without_name_returns_422(): void
    {
        $user = User::factory()->create();
        Sanctum::actingAs($user);

        $response = $this->postJson('/api/v1/persons', [
            'gender' => 'female',
            'generation' => 2,
        ]);

        $response->assertStatus(422)
            ->assertJsonValidationErrors(['name']);
    }

    public function test_trees_current_auto_creates_tree(): void
    {
        $user = User::factory()->create();
        Sanctum::actingAs($user);

        $this->assertDatabaseCount('trees', 0);

        $response = $this->getJson('/api/v1/trees/current');

        $response->assertOk()
            ->assertJsonPath('title', '我的家族')
            ->assertJsonPath('owner_user_id', $user->id);

        $this->assertDatabaseCount('trees', 1);
    }

    public function test_delete_person_with_children_returns_409(): void
    {
        $user = User::factory()->create();
        Sanctum::actingAs($user);

        $tree = Tree::query()->create([
            'owner_user_id' => $user->id,
            'title' => '我的家族',
        ]);

        $parent = Person::query()->create([
            'tree_id' => $tree->id,
            'name' => '父',
            'gender' => 'male',
            'generation' => 1,
        ]);

        Person::query()->create([
            'tree_id' => $tree->id,
            'name' => '子',
            'gender' => 'unknown',
            'generation' => 2,
            'father_id' => $parent->id,
        ]);

        $this->deleteJson('/api/v1/persons/'.$parent->id)
            ->assertStatus(409);
    }

    public function test_unauthenticated_persons_request_returns_401(): void
    {
        $this->postJson('/api/v1/persons', ['name' => '无人'])->assertUnauthorized();
    }
}
