"""Copy ONLY the YouTube/Google login cookies from a browser into a private file.

Usage: export-cookies.py <browser> <out-file>
Runs inside yt-dlp's own Python environment. Cookies for every other site are discarded in memory
and never written to disk. Prints one line of JSON (never any cookie values).
"""
import json, os, sys, time
from yt_dlp.cookies import extract_cookies_from_browser, SUPPORTED_BROWSERS

KEEP = ("youtube.com", "google.com", "googlevideo.com", "ytimg.com", "youtube-nocookie.com", "googleusercontent.com")
LOGIN = {"SAPISID", "__Secure-3PSID", "SID", "__Secure-1PSID"}

browser, out = sys.argv[1], sys.argv[2]
if browser not in SUPPORTED_BROWSERS:
    print(json.dumps({"ok": False, "error": f"Unsupported browser: {browser}"})); sys.exit(0)

class Quiet:
    def debug(self, *a): pass
    info = warning = debug
    def error(self, m): self.last = m

log = Quiet()
try:
    jar = extract_cookies_from_browser(browser, None, log)
except Exception as e:  # keychain denied, browser not installed, profile locked...
    print(json.dumps({"ok": False, "error": str(e)[:300]})); sys.exit(0)

kept = [c for c in jar if any((c.domain or "").lstrip(".").endswith(d) for d in KEEP)]
names = {c.name for c in kept}
if not names & LOGIN:
    print(json.dumps({"ok": False, "error": f"No YouTube login found in {browser}. Sign in to YouTube there first.", "cookies": len(kept)})); sys.exit(0)

os.makedirs(os.path.dirname(out), exist_ok=True)
fd = os.open(out, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, "w") as f:
    f.write("# Netscape HTTP Cookie File\n")
    for c in kept:
        dom = c.domain or ""
        f.write("\t".join([dom, "TRUE" if dom.startswith(".") else "FALSE", c.path or "/", "TRUE" if c.secure else "FALSE", str(int(c.expires or 0)), c.name, c.value or ""]) + "\n")
os.chmod(out, 0o600)
print(json.dumps({"ok": True, "browser": browser, "cookies": len(kept), "exported": int(time.time())}))
