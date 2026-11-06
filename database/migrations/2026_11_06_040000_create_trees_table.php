<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('trees', function (Blueprint $table) {
            $table->id();
            $table->foreignId('owner_user_id')->constrained('users')->cascadeOnDelete();
            $table->string('title')->default('我的家族');
            $table->timestamps();

            $table->unique('owner_user_id'); // MVP: one tree per user
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('trees');
    }
};
