<?php

namespace App\Support;

use App\Models\Tree;
use App\Models\User;

trait EnsuresCurrentTree
{
    /**
     * MVP: one tree per user. Create with default title on first use.
     */
    protected function currentTreeFor(User $user): Tree
    {
        return Tree::query()->firstOrCreate(
            ['owner_user_id' => $user->id],
            ['title' => '我的家族'],
        );
    }
}
