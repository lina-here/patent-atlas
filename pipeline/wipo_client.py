"""Polite client for WIPO IP Statistics Data Center public JSON API (undocumented).

Raw responses are returned to the caller in memory only; never write them to the repo.

Opener contract: `opener(request) -> bytes` returns the body of a 200 response. On HTTP
errors it raises `urllib.error.HTTPError` (status in `.code`); on network errors
`urllib.error.URLError`, `OSError` (timeouts, resets) or `http.client.HTTPException`
(IncompleteRead). The client converts all to `WipoError`. Default opener = urlopen; a
non-200 status (e.g. 204, 3xx) raises `WipoError` directly.
"""
from __future__ import annotations

import http.client
import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Callable, Literal

API_BASE = "https://api.ipstatsdc.deda.prd.web1.wipo.int/api/v1/public"
USER_AGENT = "PatentAtlas/0.1 (+https://github.com/lina-here/patent-atlas)"
REQUEST_TIMEOUT_S = 30
LAST_UPDATED_PATHS = {
    "ips": "ips-search/en/last-updated",
    "pmh": "pmh-search/en/last-updated",
}


_LAST_UPDATED_PATTERN = re.compile(r"Last updated:\s*[A-Za-z]+ \d{4}")


# Waits before retry 1 and 2 on a network error, timeout or HTTP 5xx; 4xx and bad bodies never retried.
RETRY_BACKOFF_S = (2.0, 6.0)


class WipoError(Exception):
    """Request failed, or response was not the expected JSON/text."""


def _retryable(error: Exception) -> bool:
    if isinstance(error, urllib.error.HTTPError):
        return error.code >= 500
    return isinstance(error, (urllib.error.URLError, OSError, http.client.HTTPException))


def open_with_retry(opener: Callable[[urllib.request.Request], bytes], request: urllib.request.Request,
                    sleep: Callable[[float], None]) -> bytes:
    """opener(request), retried after RETRY_BACKOFF_S waits on retryable errors; last error re-raised."""
    for backoff in (*RETRY_BACKOFF_S, None):
        try:
            return opener(request)
        except Exception as error:
            if backoff is None or not _retryable(error):
                raise
        sleep(backoff)
    raise AssertionError("unreachable")


class PoliteOpener:
    """Sequential polite requests: `delay_s` between requests, retries, transport errors -> `error_type`."""

    def __init__(self, opener: Callable[[urllib.request.Request], bytes], delay_s: float,
                 sleep: Callable[[float], None], error_type: type[Exception]) -> None:
        self._opener, self._delay_s, self._sleep, self._error_type = opener, delay_s, sleep, error_type
        self._request_count = 0

    def open(self, request: urllib.request.Request, what: str) -> bytes:
        if self._request_count > 0:
            self._sleep(self._delay_s)
        self._request_count += 1
        try:
            return open_with_retry(self._opener, request, self._sleep)
        except urllib.error.HTTPError as error:
            raise self._error_type(f"HTTP {error.code} for {what}") from error
        except urllib.error.URLError as error:
            raise self._error_type(f"request failed for {what}: {error.reason}") from error
        except (OSError, http.client.HTTPException) as error:
            # TimeoutError/socket.timeout, connection resets, IncompleteRead
            raise self._error_type(f"request failed for {what}: {error!r}") from error


def _default_opener(request: urllib.request.Request) -> bytes:
    with urllib.request.urlopen(request, timeout=REQUEST_TIMEOUT_S) as response:
        if response.status != 200:
            raise WipoError(f"HTTP {response.status} for {request.full_url}")
        return response.read()


def _looks_like_html(text: str) -> bool:
    return text.lstrip().startswith("<")


class WipoClient:
    def __init__(
        self,
        opener: Callable[[urllib.request.Request], bytes] | None = None,
        delay_s: float = 1.0,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self._polite = PoliteOpener(opener or _default_opener, delay_s, sleep, WipoError)

    def _fetch(self, path: str, params: dict[str, str] | None, accept: str) -> str:
        url = f"{API_BASE}/{path}"
        if params:
            # commas stay literal: WIPO list params are comma-separated
            url += "?" + urllib.parse.urlencode(params, safe=",", quote_via=urllib.parse.quote)
        request = urllib.request.Request(
            url,
            headers={
                "Accept": accept,
                "Accept-Language": "en",
                "Referer": "https://www3.wipo.int/",
                "User-Agent": USER_AGENT,
            },
            method="GET",
        )
        body = self._polite.open(request, path)
        try:
            text = body.decode("utf-8")
        except UnicodeDecodeError as error:
            raise WipoError(f"response for {path} is not UTF-8") from error
        if _looks_like_html(text):
            raise WipoError(f"HTML body (not data) for {path}")
        return text

    def get_json(self, path: str, params: dict[str, str]) -> dict:
        text = self._fetch(path, params, "application/json")
        try:
            data = json.loads(text)
        except json.JSONDecodeError as error:
            raise WipoError(f"response for {path} is not JSON") from error
        if not isinstance(data, dict):
            raise WipoError(f"JSON for {path} is not an object")
        return data

    def get_text(self, path: str) -> str:
        return self._fetch(path, None, "text/plain")

    def release_string(self, tab: Literal["ips", "pmh"]) -> str:
        if tab not in LAST_UPDATED_PATHS:
            raise ValueError(f"unknown tab: {tab!r}")
        text = self.get_text(LAST_UPDATED_PATHS[tab])
        # live text: "Source: WIPO statistics database. Last updated: October 2026"
        match = _LAST_UPDATED_PATTERN.search(text)
        if match is None:
            raise WipoError(f"no 'Last updated' in release text for {tab}")
        return match.group(0).strip()
