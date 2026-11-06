<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('persons', function (Blueprint $table) {
            $table->id();
            $table->foreignId('tree_id')->constrained('trees')->cascadeOnDelete();
            $table->string('name', 64);
            $table->string('gender', 16)->default('unknown'); // male|female|unknown
            $table->unsignedInteger('generation')->default(1);
            $table->unsignedSmallInteger('birth_year')->nullable();
            $table->unsignedSmallInteger('death_year')->nullable();
            $table->foreignId('father_id')->nullable()->constrained('persons')->nullOnDelete();
            $table->foreignId('mother_id')->nullable()->constrained('persons')->nullOnDelete();
            $table->timestamps();

            $table->index(['tree_id', 'generation']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('persons');
    }
};
