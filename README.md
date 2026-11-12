# Cue

<img src="public/brand/cue-wordmark.svg" width="228" alt="Cue — the amber playback loop forms the C">

A personal, locally hosted video front end built around a better YouTube experience: an organised subscription sidebar, a continuous recommendation feed, search suggestions and a custom player.

## Run locally

Tested on macOS with Node.js 24, Python 3, `yt-dlp` and FFmpeg. The application has no npm dependencies. Account connection and recommendation streaming use the Python environment bundled with `yt-dlp`; the current setup supports a Homebrew installation.

```sh
brew install node yt-dlp ffmpeg
npm start
```

Open **http://localhost:3000**. The server binds to `127.0.0.1`. Use `PORT=3001 npm start` to choose another local port.

Without an account, Cue shows a bundled sample dataset. To use your subscriptions and recommendations, sign in to YouTube in your browser, then open **Settings → YouTube account** in Cue and connect that browser. macOS may request browser or Keychain access.

## Features

- A bounded subscription panel with channel search, pins and remembered collapsed groups.
- Signed-in recommendations that load as you scroll, with duplicate removal and retry controls.
- Automatic topic chips based on available video titles, hashtags, tags and categories.
- Search predictions with keyboard navigation and a dropdown that remains visible while typing.
- Search filters for Shorts, videos, live streams, upload date, duration, popularity, HD, 4K and captions.
- Watched/unwatched filtering using this profile's local history and the recent YouTube history available to the app.
- Real creator images and thumbnail fallbacks for videos without a high-resolution image.
- A custom video player, quality selection, captions, chapters, resume points and keyboard controls.
- Shorts from followed channels, local profiles, themes and an extension interface.

Likes, watch-later saves and other local library actions stay in Cue. They do not write back to YouTube. Signing out of Cue removes its saved login; it does not sign you out of youtube.com in your browser.

## Local data

Runtime files live in `data/`, including copied login cookies, account caches, downloaded media and optional speech models. This directory is ignored by Git. Browser-local profile settings and library data remain in the browser.

The repository does **not** include login cookies, account caches, browser profile files, downloaded media or speech models. Connect your own browser after cloning; an existing checkout retains its current local data.

## Optional AI captions

The AI captions extension is off by default. It uses a locally installed `whisper-cli` and model files under `data/models/`. Transcription expects `ggml-large-v3-turbo-q5_0.bin`; translation expects `ggml-large-v3-q5_0.bin`. Without these optional components, the extension reports that local transcription is unavailable. Uploaded and available YouTube captions do not require these models.

## Tests

```sh
npm test
```

Tests use Node's built-in test runner and Python's standard-library `unittest`. They cover feed continuation, deduplication, topic matching, creator images, search filters, thumbnails and the recommendation worker. They do not need a real account or network access.

## Project layout

| Path | Purpose |
| --- | --- |
| `server.js` | Local HTTP server, playback resolution, media and image proxying |
| `server/` | Account management, recommendations, discovery and search helpers |
| `public/app/` | Application interface, storage, search, feeds and extensions |
| `public/player.js` | Custom player |
| `public/brand/` | Cue Next Loop mark and integrated wordmark |
| `scripts/` | Browser-cookie export, recommendation worker and sample-data builder |
| `tests/` | Offline regression tests |
| `branding/concepts/` | Original logo explorations and their generation prompts |

## Known limits

This is an independent personal project, not affiliated with YouTube or Google. It depends on public YouTube responses and `yt-dlp`, which can stop working when YouTube changes. Topic labels approximate subjects from available metadata; they do not reproduce YouTube's private recommendation algorithm. Signed-in history may be partial, and the Shorts list is built from followed channels rather than YouTube's personalised Shorts feed.

The current account-export and local speech setup is tailored to macOS. Keep the server local; it has not been designed or hardened for public hosting.
