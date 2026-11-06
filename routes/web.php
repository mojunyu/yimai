<?php

use Illuminate\Support\Facades\Route;

Route::get('/', function () {
    return redirect('/app/');
});

/*
| Serve the static AC-4 frontend from /frontend (same origin as API).
| Sources of truth live under /frontend; public/app is a thin mirror for static hosting.
*/
Route::get('/app', function () {
    return redirect('/app/');
});

Route::get('/app/', function () {
    return response()->file(base_path('frontend/index.html'));
});

Route::get('/app/{path}', function (string $path) {
    $full = base_path('frontend/'.$path);
    $realBase = realpath(base_path('frontend'));
    $realFile = realpath($full);

    if ($realBase === false || $realFile === false || ! str_starts_with($realFile, $realBase) || ! is_file($realFile)) {
        abort(404);
    }

    $mime = match (strtolower(pathinfo($realFile, PATHINFO_EXTENSION))) {
        'js' => 'application/javascript; charset=UTF-8',
        'css' => 'text/css; charset=UTF-8',
        'svg' => 'image/svg+xml',
        'png' => 'image/png',
        'json' => 'application/json',
        'html' => 'text/html; charset=UTF-8',
        default => 'application/octet-stream',
    };

    return response()->file($realFile, ['Content-Type' => $mime]);
})->where('path', '.*');
