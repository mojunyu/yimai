<?php

namespace App\Console\Commands;

use App\Models\User;
use Database\Seeders\ThreeGenerationSeeder;
use Illuminate\Console\Command;

class YimaiDemoCommand extends Command
{
    protected $signature = 'yimai:demo {--fresh : migrate:fresh before seeding}';

    protected $description = 'Seed demo user + 3-gen fixture and print a Sanctum token for the frontend';

    public function handle(): int
    {
        if ($this->option('fresh')) {
            $this->call('migrate:fresh', ['--force' => true]);
        }

        $this->call(ThreeGenerationSeeder::class);

        $user = User::query()->where('email', 'demo@yimai.test')->firstOrFail();
        $token = $user->createToken('yimai-demo')->plainTextToken;
        $rootId = $user->tree?->persons()->orderBy('generation')->orderBy('id')->value('id');

        $this->newLine();
        $this->info('AC-4 demo ready');
        $this->line('  API:    '.rtrim((string) config('app.url'), '/').'/api/v1');
        $this->line('  App:    '.rtrim((string) config('app.url'), '/').'/app/');
        $this->line('  Login:  demo@yimai.test / password');
        $this->line('  Token:  '.$token);
        $this->line('  Root:   person id '.$rootId.' (祖父)');
        $this->line('  Expect: nodes=5 parent_edges=4 spouse_edges=2');
        $this->newLine();

        return self::SUCCESS;
    }
}
