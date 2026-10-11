"""Per-IP throttling for the login endpoint.

Stdlib only, matching the rest of the auth code: no Redis, no session store.

Scope and limits, stated plainly:

* In-memory, so on Vercel — whose instances are not sticky — a determined
  attacker can spread attempts across instances. It reliably stops casual and
  automated guessing at one address, which is the realistic threat for a
  personal deployment. It is a speed bump, not a wall.
* Keyed on the client address that Vercel reports. See `client_key` for why
  that is only partially trustworthy.
"""

import threading
import time
from collections import OrderedDict

from . import config

# Bound the table so a spray of source addresses cannot grow it without limit.
MAX_TRACKED = 10_000


class LoginLimiter:
    """Count consecutive failures per key, then lock that key out for a while."""

    def __init__(self, limit: int, window: float, lockout: float) -> None:
        self.limit = max(1, limit)
        self.window = max(1.0, window)
        self.lockout = max(1.0, lockout)
        self._entries: "OrderedDict[str, list[float]]" = OrderedDict()
        self._locked_until: dict[str, float] = {}
        self._lock = threading.Lock()
        self._last_sweep = time.monotonic()

    def _sweep(self, now: float) -> None:
        """Drop keys whose failures are all older than the window."""
        if now - self._last_sweep < self.window:
            return
        self._last_sweep = now
        stale = [k for k, stamps in self._entries.items() if not stamps or now - stamps[-1] > self.window]
        for key in stale:
            self._entries.pop(key, None)
            self._locked_until.pop(key, None)

    def locked_for(self, key: str, now: float | None = None) -> float:
        """Seconds until the lockout expires; 0 when the key is free."""
        now = time.monotonic() if now is None else now
        with self._lock:
            self._sweep(now)
            until = self._locked_until.get(key)
            if until is None:
                return 0.0
            if until <= now:
                del self._locked_until[key]
                self._entries.pop(key, None)
                return 0.0
            return until - now

    def fail(self, key: str, now: float | None = None) -> int:
        """Record one failure. Returns consecutive failures within the window."""
        now = time.monotonic() if now is None else now
        with self._lock:
            self._sweep(now)
            stamps = [t for t in self._entries.get(key, []) if now - t <= self.window]
            stamps.append(now)
            self._entries[key] = stamps
            # Refresh recency so the sweep's LRU eviction keeps active keys.
            self._entries.move_to_end(key)
            while len(self._entries) > MAX_TRACKED:
                evicted, _ = self._entries.popitem(last=False)
                self._locked_until.pop(evicted, None)
            count = len(stamps)
            if count >= self.limit:
                self._locked_until[key] = now + self.lockout
            return count

    def reset(self, key: str) -> None:
        """A correct password clears the record for that key."""
        with self._lock:
            self._entries.pop(key, None)
            self._locked_until.pop(key, None)


def client_key(request) -> str:
    """Best available address for rate limiting.

    `x-real-ip` is set by Vercel and cannot be forged by the client, so it is
    preferred. `x-forwarded-for` is fallible — Vercel appends the true address
    to whatever the caller sent, so only the last entry is trustworthy. Direct
    connections (Render, Docker, localhost) skip both.
    """
    real = request.headers.get("x-real-ip", "").strip()
    if real:
        return real
    forwarded = request.headers.get("x-forwarded-for", "")
    if forwarded:
        parts = [p.strip() for p in forwarded.split(",") if p.strip()]
        if parts:
            return parts[-1]
    return request.client.host if request.client else "unknown"


# Module-level so all requests share one table.
LOGIN_LIMITER = LoginLimiter(
    limit=config.LOGIN_MAX_ATTEMPTS,
    window=config.LOGIN_WINDOW_SECONDS,
    lockout=config.LOGIN_LOCKOUT_SECONDS,
)
