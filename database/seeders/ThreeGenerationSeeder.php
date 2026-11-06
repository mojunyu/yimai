<?php

namespace Database\Seeders;

use App\Models\Tree;
use App\Models\User;
use App\Support\ThreeGenerationFixture;
use Illuminate\Database\Seeder;
use Illuminate\Support\Facades\Hash;

/**
 * Demo user + ≥3-gen family for AC-4 frontend proof.
 *
 * Email: demo@yimai.test / Password: password
 */
class ThreeGenerationSeeder extends Seeder
{
    public function run(): void
    {
        $user = User::query()->updateOrCreate(
            ['email' => 'demo@yimai.test'],
            [
                'name' => '一脉演示',
                'password' => Hash::make('password'),
            ],
        );

        $tree = Tree::query()->firstOrCreate(
            ['owner_user_id' => $user->id],
            ['title' => '我的家族'],
        );

        if ($tree->persons()->exists()) {
            $this->command?->warn('Tree already has persons; skipping fixture seed.');

            return;
        }

        $fixture = ThreeGenerationFixture::seedInto($tree);

        $this->command?->info('Seeded 3-gen fixture. Root person id='.$fixture['grandfather']->id);
        $this->command?->info('Login: demo@yimai.test / password');
    }
}
