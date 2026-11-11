<?php

use App\Http\Controllers\Api\V1\AuthController;
use App\Http\Controllers\Api\V1\PersonController;
use App\Http\Controllers\Api\V1\SiblingLinkController;
use App\Http\Controllers\Api\V1\SpouseLinkController;
use App\Http\Controllers\Api\V1\TreeController;
use Illuminate\Support\Facades\Route;

/*
|--------------------------------------------------------------------------
| 一脉 API v1 — cut 2026-11-06
| Prefix: /api/v1  (configured in bootstrap/app.php)
| Auth: Sanctum (auth:sanctum)
|--------------------------------------------------------------------------
*/

Route::prefix('v1')->group(function () {
    Route::post('auth/login', [AuthController::class, 'login']);

    Route::middleware('auth:sanctum')->group(function () {
        Route::post('auth/logout', [AuthController::class, 'logout']);

        Route::get('trees/current', [TreeController::class, 'current']);

        Route::get('persons', [PersonController::class, 'index']);
        Route::post('persons', [PersonController::class, 'store']);
        Route::get('persons/{id}', [PersonController::class, 'show']);
        Route::patch('persons/{id}', [PersonController::class, 'update']);
        Route::delete('persons/{id}', [PersonController::class, 'destroy']);
        Route::get('persons/{id}/tree', [PersonController::class, 'tree']);

        Route::get('spouse-links', [SpouseLinkController::class, 'index']);
        Route::post('spouse-links', [SpouseLinkController::class, 'store']);
        Route::patch('spouse-links/{id}', [SpouseLinkController::class, 'update']);
        Route::delete('spouse-links/{id}', [SpouseLinkController::class, 'destroy']);

        Route::get('sibling-links', [SiblingLinkController::class, 'index']);
        Route::post('sibling-links', [SiblingLinkController::class, 'store']);
        Route::delete('sibling-links/{id}', [SiblingLinkController::class, 'destroy']);
    });
});
