<?php

namespace Tests\Feature;

use App\Models\Tree;
use App\Models\User;
use App\Support\ThreeGenerationFixture;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

/**
 * AC-4: tree JSON shape for ≥3-gen fixture has expected node/edge counts.
 * Frontend must consume this JSON only (no client-side relationship inventing).
 */
class TreeAc4Test extends TestCase
{
    use RefreshDatabase;

    public function test_three_generation_fixture_tree_json_counts(): void
    {
        $user = User::factory()->create();
        Sanctum::actingAs($user);

        $tree = Tree::query()->create([
            'owner_user_id' => $user->id,
            'title' => '我的家族',
        ]);

        $fixture = ThreeGenerationFixture::seedInto($tree);
        $rootId = $fixture['grandfather']->id;

        $response = $this->getJson('/api/v1/persons/'.$rootId.'/tree');

        $response->assertOk()
            ->assertJsonPath('root_id', $rootId)
            ->assertJsonStructure([
                'root_id',
                'nodes' => [
                    ['id', 'name', 'gender', 'generation', 'birth_year', 'death_year'],
                ],
                'edges',
            ]);

        $nodes = collect($response->json('nodes'));
        $edges = collect($response->json('edges'));
        $parentEdges = $edges->where('type', 'parent')->values();
        $spouseEdges = $edges->where('type', 'spouse')->values();

        $this->assertCount(ThreeGenerationFixture::EXPECTED_NODES, $nodes);
        $this->assertCount(ThreeGenerationFixture::EXPECTED_PARENT_EDGES, $parentEdges);
        $this->assertCount(ThreeGenerationFixture::EXPECTED_SPOUSE_EDGES, $spouseEdges);
        $this->assertSame(
            ThreeGenerationFixture::EXPECTED_PARENT_EDGES + ThreeGenerationFixture::EXPECTED_SPOUSE_EDGES,
            $edges->count()
        );

        // Generations span 1..3
        $this->assertSame([1, 2, 3], $nodes->pluck('generation')->unique()->sort()->values()->all());

        // Exact parent edges
        $gf = $fixture['grandfather']->id;
        $gm = $fixture['grandmother']->id;
        $f = $fixture['father']->id;
        $m = $fixture['mother']->id;
        $c = $fixture['child']->id;

        $this->assertTrue($parentEdges->contains(fn ($e) => $e['from'] === $gf && $e['to'] === $f));
        $this->assertTrue($parentEdges->contains(fn ($e) => $e['from'] === $gm && $e['to'] === $f));
        $this->assertTrue($parentEdges->contains(fn ($e) => $e['from'] === $f && $e['to'] === $c));
        $this->assertTrue($parentEdges->contains(fn ($e) => $e['from'] === $m && $e['to'] === $c));

        // Spouse edges carry link_id
        foreach ($spouseEdges as $edge) {
            $this->assertArrayHasKey('a', $edge);
            $this->assertArrayHasKey('b', $edge);
            $this->assertArrayHasKey('link_id', $edge);
        }

        $this->assertTrue(
            $spouseEdges->contains(fn ($e) =>
                ($e['a'] === $gf && $e['b'] === $gm) || ($e['a'] === $gm && $e['b'] === $gf)
            )
        );
        $this->assertTrue(
            $spouseEdges->contains(fn ($e) =>
                ($e['a'] === $f && $e['b'] === $m) || ($e['a'] === $m && $e['b'] === $f)
            )
        );
    }

    public function test_root_id_follows_path_person_without_changing_graph_counts(): void
    {
        $user = User::factory()->create();
        Sanctum::actingAs($user);

        $tree = Tree::query()->create([
            'owner_user_id' => $user->id,
            'title' => '我的家族',
        ]);

        $fixture = ThreeGenerationFixture::seedInto($tree);
        $childId = $fixture['child']->id;

        $response = $this->getJson('/api/v1/persons/'.$childId.'/tree');

        $response->assertOk()->assertJsonPath('root_id', $childId);

        $this->assertCount(ThreeGenerationFixture::EXPECTED_NODES, $response->json('nodes'));
        $edges = collect($response->json('edges'));
        $this->assertCount(ThreeGenerationFixture::EXPECTED_PARENT_EDGES, $edges->where('type', 'parent'));
        $this->assertCount(ThreeGenerationFixture::EXPECTED_SPOUSE_EDGES, $edges->where('type', 'spouse'));
    }
}
