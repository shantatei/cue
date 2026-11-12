"""Read a signed-in recommendation iterator one page at a time over stdin/stdout.

The iterator retains YouTube's continuation state between requests. It uses a temporary
copy of the login, so this worker never rewrites the account's saved cookies.
"""
import itertools
import json
import sys
import yt_dlp


class Quiet:
    def debug(self, *args): pass
    warning = error = debug


def pages(ydl):
    entries = None
    for command in sys.stdin:
        if command.strip() != "next":
            break
        try:
            if entries is None:
                # process=True drains the playlist before returning, even with lazy_playlist.
                # Keep the extractor's actual generator so later pages fetch continuations.
                result = ydl.extract_info("https://www.youtube.com/feed/recommended", download=False, process=False)
                if "entries" not in result:
                    raise ValueError("YouTube did not return a recommendation feed")
                entries = iter(result["entries"])
            batch = list(itertools.islice(entries, 24))
            videos = []
            for e in batch:
                if not e or not e.get("id") or not e.get("title"):
                    continue
                videos.append({
                    "id": e["id"], "title": e["title"], "duration": e.get("duration"),
                    "views": e.get("view_count"), "timestamp": e.get("timestamp"),
                    "live": e.get("live_status") == "is_live",
                    "channel": e.get("channel") or e.get("uploader"), "channelId": e.get("channel_id"),
                    "tags": e.get("tags") or [], "categories": e.get("categories") or [],
                    "description": e.get("description"),
                    "thumbnail": e.get("thumbnail") or next(iter(sorted(e.get("thumbnails") or [], key=lambda t: t.get("width") or 0, reverse=True)), {}).get("url"),
                })
            print(json.dumps({"videos": videos, "hasMore": len(batch) == 24}), flush=True)
        except Exception:
            # Do not put cookies, extractor responses or signed URLs in the public error.
            print(json.dumps({"error": "Couldn't load recommendations from YouTube. Try again or reconnect in Settings."}), flush=True)
            break


if __name__ == "__main__":
    with yt_dlp.YoutubeDL({
        "cookiefile": sys.argv[1], "extract_flat": "in_playlist", "lazy_playlist": True,
        "quiet": True, "no_warnings": True, "logger": Quiet(), "socket_timeout": 20,
        "extractor_args": {"youtubetab": {"approximate_date": ["true"]}},
    }) as ydl:
        pages(ydl)
