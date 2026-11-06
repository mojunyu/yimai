<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;

class Person extends Model
{
    protected $table = 'persons';

    protected $fillable = [
        'tree_id',
        'name',
        'gender',
        'generation',
        'birth_year',
        'death_year',
        'father_id',
        'mother_id',
    ];

    protected function casts(): array
    {
        return [
            'generation' => 'integer',
            'birth_year' => 'integer',
            'death_year' => 'integer',
        ];
    }

    public function tree(): BelongsTo
    {
        return $this->belongsTo(Tree::class);
    }

    public function father(): BelongsTo
    {
        return $this->belongsTo(Person::class, 'father_id');
    }

    public function mother(): BelongsTo
    {
        return $this->belongsTo(Person::class, 'mother_id');
    }

    public function childrenAsFather(): HasMany
    {
        return $this->hasMany(Person::class, 'father_id');
    }

    public function childrenAsMother(): HasMany
    {
        return $this->hasMany(Person::class, 'mother_id');
    }
}
