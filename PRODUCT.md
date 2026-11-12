# Product

<!-- impeccable:product-schema 1 -->

> Every fact below is inferred from the project conversation and the two YouTube
> screenshots the owner shared. No interview round was run; correct anything that is wrong.

## Platform

web

## Stack

A Node server (`server.ts`) that resolves streams with `yt-dlp` and proxies them,
plus native HTML/CSS/TypeScript browser modules in `public/`. There is no frontend
framework. A strict TypeScript build emits JavaScript and source maps into `dist/`;
Python helpers handle browser-cookie export and recommendation iteration.

## Users

One person: the owner, on their own Mac, signed in to nothing. They subscribe to several
hundred YouTube channels (Valorant and esports, Korean creators, K-pop and dance studios,
software engineering) and have used the vidIQ extension for a long time.

## Product Purpose

A personal YouTube front end that runs locally. It plays the same videos through its own
player, without ads, at up to 4K, and fixes the small frustrations of youtube.com. The first
named frustration: expanding the subscriptions list in the sidebar means scrolling past every
channel for 10 to 15 seconds to reach "Show less".

Success: the owner can use it instead of youtube.com for everyday watching without losing a
feature they rely on.

## Positioning

It is built for one person's own subscriptions rather than for an audience, so it can put
the channels they chose ahead of the recommendation feed and never has to sell ads.

## Operating Context

- Desktop browser on macOS, local only (`http://localhost:3000`, bound to 127.0.0.1).
- The owner's current YouTube setup is the dark theme with the vidIQ toolbar and sidebar tools.

## Capabilities and Constraints

- Playback: `yt-dlp` resolves separate video and audio streams; the server proxies them and the
  page keeps a `<video>` and an `<audio>` element in sync. SDR only, up to 2160p60.
- Available without an account: video metadata, formats, chapters, most-replayed heatmap,
  top comments (read only), search, a channel's recent uploads.
- Not available yet: the owner's real subscriptions, home recommendations, history, playlists,
  watch later and likes. These need either Google OAuth or the browser's YouTube cookies.
  Undecided which.
- Writing back to YouTube (subscribe, like, comment, save) is not built and is undecided.
- This use breaks YouTube's Terms of Service. It stays personal and local.
- Must cover the features YouTube has today, and should include vidIQ-style statistics.

- The app is Cue. Its layout began as the Ledger prototype, chosen for its familiar YouTube layout. It lives in `public/app/`.
- Extensions: an Extensions page with on/off switches, everything off by default per profile. Built in: Video insights (vidIQ-style) and AI captions. Others are added by module URL (an example is in `public/extensions/examples/`).
- Captions: uploaded captions first; otherwise AI captions (whisper.cpp large-v3-turbo, run locally) when that extension is on; YouTube's auto-generated track last.
- YouTube account: a profile can connect its own YouTube login (copied from a browser, YouTube/Google cookies only, kept in data/accounts/<profile>/). Connected profiles show real subscriptions, the subscriptions feed, recommendations, history, Watch later and Liked. Likes and saves stay local; nothing is written back to YouTube.
- Settings: theme, playback, captions, data. Accounts are local profiles with their own history, saved videos, pins, settings and extensions; they share one subscriptions list until a YouTube account is connected.

## Evidence on Hand

- Two screenshots of the owner's YouTube (home feed, all-subscriptions page) with real channel
  names. No export of the full subscription list.
- The owner chose Cue with the amber Next Loop mark, integrated as the C in the wordmark. Production SVG assets live in `public/brand/`; exploration boards remain in `branding/concepts/`.

## Product Principles

1. The channels the owner chose come before anything an algorithm chose.
2. Nothing the owner does often should need scrolling to reach or undo.
3. Parity first: a YouTube feature the owner uses must have a home here.
4. Show a video's numbers where the owner is already looking.
