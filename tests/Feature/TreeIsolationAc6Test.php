<?php

namespace Tests\Feature;

use App\Models\Person;
use App\Models\SiblingLink;
use App\Models\SpouseLink;
use App\Models\Tree;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

/**
 * AC-6 树隔离 (cut 2026-11-06):
 * 第二用户不能读写他人 tree 的 persons / spouse-links（401/403/404，不得 200）。
 * 客户端伪造 tree_id 不得写入他人树。
 */
class TreeIsolationAc6Test extends TestCase
{
    use RefreshDatabase;

    public function test_unauthenticated_returns_401_for_persons_and_spouse_links(): void
    {
        $this->getJson('/api/v1/persons')->assertUnauthorized();
        $this->postJson('/api/v1/persons', ['name' => 'x'])->assertUnauthorized();
        $this->getJson('/api/v1/persons/1')->assertUnauthorized();
        $this->patchJson('/api/v1/persons/1', ['name' => 'y'])->assertUnauthorized();
        $this->deleteJson('/api/v1/persons/1')->assertUnauthorized();
        $this->getJson('/api/v1/persons/1/tree')->assertUnauthorized();
        $this->getJson('/api/v1/spouse-links')->assertUnauthorized();
        $this->postJson('/api/v1/spouse-links', [
            'person_a_id' => 1,
            'person_b_id' => 2,
        ])->assertUnauthorized();
        $this->patchJson('/api/v1/spouse-links/1', ['note' => 'n'])->assertUnauthorized();
        $this->deleteJson('/api/v1/spouse-links/1')->assertUnauthorized();
        $this->getJson('/api/v1/sibling-links')->assertUnauthorized();
        $this->postJson('/api/v1/sibling-links', [
            'person_a_id' => 1,
            'person_b_id' => 2,
        ])->assertUnauthorized();
        $this->deleteJson('/api/v1/sibling-links/1')->assertUnauthorized();
    }

    public function test_second_user_cannot_read_or_write_other_tree_persons(): void
    {
        [$owner, $intruder, $ownerPerson] = $this->twoUsersWithPerson();

        Sanctum::actingAs($intruder);

        // Read / mutate by foreign person id → 404 (scoped to intruder's tree)
        $this->getJson('/api/v1/persons/'.$ownerPerson->id)
            ->assertNotFound();

        $this->patchJson('/api/v1/persons/'.$ownerPerson->id, [
            'name' => '被篡改',
        ])->assertNotFound();

        $this->deleteJson('/api/v1/persons/'.$ownerPerson->id)
            ->assertNotFound();

        $this->getJson('/api/v1/persons/'.$ownerPerson->id.'/tree')
            ->assertNotFound();

        // Index must not leak owner persons
        $list = $this->getJson('/api/v1/persons')->assertOk()->json('data');
        $ids = collect($list)->pluck('id')->all();
        $this->assertNotContains($ownerPerson->id, $ids);

        // Owner data unchanged
        $this->assertDatabaseHas('persons', [
            'id' => $ownerPerson->id,
            'name' => $ownerPerson->name,
            'tree_id' => $ownerPerson->tree_id,
        ]);
        $this->assertSame($owner->id, Tree::query()->find($ownerPerson->tree_id)->owner_user_id);
    }

    public function test_second_user_cannot_read_or_write_other_tree_spouse_links(): void
    {
        [$owner, $intruder, $ownerPerson] = $this->twoUsersWithPerson();

        $ownerTreeId = $ownerPerson->tree_id;
        $spouse = Person::query()->create([
            'tree_id' => $ownerTreeId,
            'name' => '配偶',
            'gender' => 'female',
            'generation' => 1,
        ]);
        $link = SpouseLink::query()->create([
            'tree_id' => $ownerTreeId,
            'person_a_id' => $ownerPerson->id,
            'person_b_id' => $spouse->id,
            'start_year' => 2000,
            'end_year' => null,
            'note' => 'secret',
        ]);

        Sanctum::actingAs($intruder);

        $this->getJson('/api/v1/spouse-links')
            ->assertOk()
            ->assertJsonPath('data', []);

        $this->patchJson('/api/v1/spouse-links/'.$link->id, [
            'note' => 'hacked',
        ])->assertNotFound();

        $this->deleteJson('/api/v1/spouse-links/'.$link->id)
            ->assertNotFound();

        // Cannot bind own person to foreign person
        $intruderPerson = $this->postJson('/api/v1/persons', [
            'name' => '入侵者成员',
            'gender' => 'male',
            'generation' => 1,
        ])->assertCreated()->json();

        $this->postJson('/api/v1/spouse-links', [
            'person_a_id' => $intruderPerson['id'],
            'person_b_id' => $ownerPerson->id,
        ])->assertStatus(422);

        $this->assertDatabaseHas('spouse_links', [
            'id' => $link->id,
            'note' => 'secret',
            'tree_id' => $ownerTreeId,
        ]);
    }

    public function test_second_user_cannot_read_or_write_other_tree_sibling_links(): void
    {
        [$owner, $intruder, $ownerPerson] = $this->twoUsersWithPerson();

        $ownerTreeId = $ownerPerson->tree_id;
        $sib = Person::query()->create([
            'tree_id' => $ownerTreeId,
            'name' => '兄弟姐妹',
            'gender' => 'female',
            'generation' => 1,
        ]);
        $aId = min($ownerPerson->id, $sib->id);
        $bId = max($ownerPerson->id, $sib->id);
        $link = SiblingLink::query()->create([
            'tree_id' => $ownerTreeId,
            'person_a_id' => $aId,
            'person_b_id' => $bId,
        ]);

        Sanctum::actingAs($intruder);

        $this->getJson('/api/v1/sibling-links')
            ->assertOk()
            ->assertJsonPath('data', []);

        $this->deleteJson('/api/v1/sibling-links/'.$link->id)
            ->assertNotFound();

        $intruderPerson = $this->postJson('/api/v1/persons', [
            'name' => '入侵者成员',
            'gender' => 'male',
            'generation' => 1,
        ])->assertCreated()->json();

        $this->postJson('/api/v1/sibling-links', [
            'person_a_id' => $intruderPerson['id'],
            'person_b_id' => $ownerPerson->id,
        ])->assertStatus(422);

        $this->assertDatabaseHas('sibling_links', [
            'id' => $link->id,
            'tree_id' => $ownerTreeId,
        ]);
    }

    public function test_forged_tree_id_on_create_is_ignored_and_stays_in_own_tree(): void
    {
        [$owner, $intruder, $ownerPerson] = $this->twoUsersWithPerson();

        Sanctum::actingAs($intruder);

        $response = $this->postJson('/api/v1/persons', [
            'name' => '伪造树',
            'gender' => 'unknown',
            'generation' => 1,
            'tree_id' => $ownerPerson->tree_id, // forged — must be ignored
        ])->assertCreated();

        $createdTreeId = $response->json('tree_id');
        $this->assertNotSame($ownerPerson->tree_id, $createdTreeId);

        $intruderTree = Tree::query()->where('owner_user_id', $intruder->id)->first();
        $this->assertNotNull($intruderTree);
        $this->assertSame($intruderTree->id, $createdTreeId);

        $this->assertDatabaseMissing('persons', [
            'name' => '伪造树',
            'tree_id' => $ownerPerson->tree_id,
        ]);
    }

    public function test_owner_still_can_access_own_resources_after_isolation_checks(): void
    {
        [$owner, , $ownerPerson] = $this->twoUsersWithPerson();
        Sanctum::actingAs($owner);

        $this->getJson('/api/v1/persons/'.$ownerPerson->id)
            ->assertOk()
            ->assertJsonPath('id', $ownerPerson->id);

        $this->getJson('/api/v1/persons/'.$ownerPerson->id.'/tree')
            ->assertOk()
            ->assertJsonPath('root_id', $ownerPerson->id);
    }

    /**
     * @return array{0: User, 1: User, 2: Person}
     */
    private function twoUsersWithPerson(): array
    {
        $owner = User::factory()->create();
        $intruder = User::factory()->create();

        $ownerTree = Tree::query()->create([
            'owner_user_id' => $owner->id,
            'title' => '业主家族',
        ]);

        $ownerPerson = Person::query()->create([
            'tree_id' => $ownerTree->id,
            'name' => '业主成员',
            'gender' => 'male',
            'generation' => 1,
        ]);

        return [$owner, $intruder, $ownerPerson];
    }
}
