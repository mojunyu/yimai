<?php

namespace Tests\Feature;

use App\Models\Person;
use App\Models\Tree;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

/**
 * AC-5 删除保护 (cut 2026-11-06):
 * - 仍有子女指向该成员（father_id 或 mother_id）时 DELETE → 409
 * - 解绑子女后可删 → 204
 */
class PersonAc5Test extends TestCase
{
    use RefreshDatabase;

    public function test_delete_person_referenced_as_father_returns_409(): void
    {
        [$parent] = $this->seedParentWithChild(via: 'father_id');

        Sanctum::actingAs(User::query()->find(
            Tree::query()->find($parent->tree_id)->owner_user_id
        ));

        $response = $this->deleteJson('/api/v1/persons/'.$parent->id)
            ->assertStatus(409);
        $this->assertStringContainsString('children', (string) $response->json('message'));
    }

    public function test_delete_person_referenced_as_mother_returns_409(): void
    {
        [$parent] = $this->seedParentWithChild(via: 'mother_id');

        Sanctum::actingAs(User::query()->find(
            Tree::query()->find($parent->tree_id)->owner_user_id
        ));

        $this->deleteJson('/api/v1/persons/'.$parent->id)
            ->assertStatus(409);
    }

    public function test_after_unbind_parent_can_be_deleted(): void
    {
        [$parent, $child, $user] = $this->seedParentWithChild(via: 'father_id');
        Sanctum::actingAs($user);

        $this->deleteJson('/api/v1/persons/'.$parent->id)->assertStatus(409);

        $this->patchJson('/api/v1/persons/'.$child->id, [
            'father_id' => null,
        ])->assertOk()
            ->assertJsonPath('father_id', null);

        $this->deleteJson('/api/v1/persons/'.$parent->id)
            ->assertNoContent();

        $this->assertDatabaseMissing('persons', ['id' => $parent->id]);
    }

    public function test_after_unbind_mother_can_be_deleted(): void
    {
        [$parent, $child, $user] = $this->seedParentWithChild(via: 'mother_id');
        Sanctum::actingAs($user);

        $this->deleteJson('/api/v1/persons/'.$parent->id)->assertStatus(409);

        $this->patchJson('/api/v1/persons/'.$child->id, [
            'mother_id' => null,
        ])->assertOk()
            ->assertJsonPath('mother_id', null);

        $this->deleteJson('/api/v1/persons/'.$parent->id)
            ->assertNoContent();

        $this->assertDatabaseMissing('persons', ['id' => $parent->id]);
    }

    /**
     * @return array{0: Person, 1: Person, 2: User}
     */
    private function seedParentWithChild(string $via): array
    {
        $user = User::factory()->create();
        $tree = Tree::query()->create([
            'owner_user_id' => $user->id,
            'title' => '我的家族',
        ]);

        $parent = Person::query()->create([
            'tree_id' => $tree->id,
            'name' => $via === 'father_id' ? '父' : '母',
            'gender' => $via === 'father_id' ? 'male' : 'female',
            'generation' => 1,
        ]);

        $childAttrs = [
            'tree_id' => $tree->id,
            'name' => '子',
            'gender' => 'unknown',
            'generation' => 2,
        ];
        $childAttrs[$via] = $parent->id;

        $child = Person::query()->create($childAttrs);

        return [$parent, $child, $user];
    }
}
