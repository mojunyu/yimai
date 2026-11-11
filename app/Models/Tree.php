<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;

class Tree extends Model
{
    protected $fillable = [
        'owner_user_id',
        'title',
    ];

    public function owner(): BelongsTo
    {
        return $this->belongsTo(User::class, 'owner_user_id');
    }

    public function persons(): HasMany
    {
        return $this->hasMany(Person::class);
    }

    public function spouseLinks(): HasMany
    {
        return $this->hasMany(SpouseLink::class);
    }

    public function siblingLinks(): HasMany
    {
        return $this->hasMany(SiblingLink::class);
    }
}
