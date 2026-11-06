<?php

namespace App\Support;

use App\Models\Person;
use App\Models\SpouseLink;
use App\Models\Tree;

/**
 * Canonical ≥3-generation sample for AC-4 proof.
 *
 * Expected shape (locked):
 * - nodes: 5
 * - parent edges: 4 (祖父→父, 祖母→父, 父→子, 母→子)
 * - spouse edges: 2 (祖父↔祖母, 父↔母)
 */
class ThreeGenerationFixture
{
    public const EXPECTED_NODES = 5;

    public const EXPECTED_PARENT_EDGES = 4;

    public const EXPECTED_SPOUSE_EDGES = 2;

    /**
     * @return array{
     *   grandfather: Person,
     *   grandmother: Person,
     *   father: Person,
     *   mother: Person,
     *   child: Person,
     *   spouse_gf_gm: SpouseLink,
     *   spouse_f_m: SpouseLink,
     * }
     */
    public static function seedInto(Tree $tree): array
    {
        $grandfather = Person::query()->create([
            'tree_id' => $tree->id,
            'name' => '祖父',
            'gender' => 'male',
            'generation' => 1,
            'birth_year' => 1920,
            'death_year' => 2000,
        ]);

        $grandmother = Person::query()->create([
            'tree_id' => $tree->id,
            'name' => '祖母',
            'gender' => 'female',
            'generation' => 1,
            'birth_year' => 1925,
            'death_year' => null,
        ]);

        $father = Person::query()->create([
            'tree_id' => $tree->id,
            'name' => '父',
            'gender' => 'male',
            'generation' => 2,
            'birth_year' => 1955,
            'death_year' => null,
            'father_id' => $grandfather->id,
            'mother_id' => $grandmother->id,
        ]);

        $mother = Person::query()->create([
            'tree_id' => $tree->id,
            'name' => '母',
            'gender' => 'female',
            'generation' => 2,
            'birth_year' => 1958,
            'death_year' => null,
        ]);

        $child = Person::query()->create([
            'tree_id' => $tree->id,
            'name' => '子',
            'gender' => 'male',
            'generation' => 3,
            'birth_year' => 1985,
            'death_year' => null,
            'father_id' => $father->id,
            'mother_id' => $mother->id,
        ]);

        $spouseGfGm = SpouseLink::query()->create([
            'tree_id' => $tree->id,
            'person_a_id' => $grandfather->id,
            'person_b_id' => $grandmother->id,
            'start_year' => 1948,
        ]);

        $spouseFM = SpouseLink::query()->create([
            'tree_id' => $tree->id,
            'person_a_id' => $father->id,
            'person_b_id' => $mother->id,
            'start_year' => 1980,
        ]);

        return [
            'grandfather' => $grandfather,
            'grandmother' => $grandmother,
            'father' => $father,
            'mother' => $mother,
            'child' => $child,
            'spouse_gf_gm' => $spouseGfGm,
            'spouse_f_m' => $spouseFM,
        ];
    }
}
