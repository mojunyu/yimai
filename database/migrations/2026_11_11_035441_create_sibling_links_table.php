<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('sibling_links', function (Blueprint $table) {
            $table->id();
            $table->foreignId('tree_id')->constrained('trees')->cascadeOnDelete();
            $table->foreignId('person_a_id')->constrained('persons')->cascadeOnDelete();
            $table->foreignId('person_b_id')->constrained('persons')->cascadeOnDelete();
            $table->timestamps();

            // Canonical store order is person_a_id < person_b_id (enforced in controller).
            $table->unique(['tree_id', 'person_a_id', 'person_b_id']);
            $table->index(['tree_id', 'person_a_id']);
            $table->index(['tree_id', 'person_b_id']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('sibling_links');
    }
};
