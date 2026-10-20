"""HTTP errors that can carry a scrubbed diagnostic payload.

The browser-facing `detail` is deliberately short: an operator who just wanted
to clone a voice should not have to read a JSON error envelope. The `debug`
field is the opposite -- it exists so the log console can show what upstream
actually said, without putting credentials or the full traceback in front of
every user.
"""

from fastapi import HTTPException


class DebugHTTPException(HTTPException):
    """An HTTPException with an extra, already-scrubbed `debug` object."""

    def __init__(
        self,
        status_code: int,
        detail: str,
        *,
        debug: dict | None = None,
        headers: dict | None = None,
    ) -> None:
        super().__init__(status_code=status_code, detail=detail, headers=headers)
        self.debug = debug or {}
