<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

class SpouseLink extends Model
{
    protected $fillable = [
        'tree_id',
        'person_a_id',
        'person_b_id',
        'start_year',
        'end_year',
        'note',
    ];

    protected function casts(): array
    {
        return [
            'start_year' => 'integer',
            'end_year' => 'integer',
        ];
    }

    public function tree(): BelongsTo
    {
        return $this->belongsTo(Tree::class);
    }

    public function personA(): BelongsTo
    {
        return $this->belongsTo(Person::class, 'person_a_id');
    }

    public function personB(): BelongsTo
    {
        return $this->belongsTo(Person::class, 'person_b_id');
    }
}
