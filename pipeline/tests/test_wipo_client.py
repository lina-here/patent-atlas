import http.client
import io
import urllib.error
import urllib.request

import pytest

from pipeline.wipo_client import API_BASE, RETRY_BACKOFF_S, WipoClient, WipoError


class FakeOpener:
    def __init__(self, *bodies):
        self.bodies = list(bodies)
        self.requests = []

    def __call__(self, request: urllib.request.Request) -> bytes:
        self.requests.append(request)
        body = self.bodies.pop(0)
        if isinstance(body, Exception):
            raise body
        return body


def make_client(*bodies, sleeps=None):
    opener = FakeOpener(*bodies)
    sleeps = sleeps if sleeps is not None else []
    client = WipoClient(opener=opener, delay_s=1.0, sleep=sleeps.append)
    return client, opener


def test_sends_headers():
    client, opener = make_client(b'{"ok": 1}')
    assert client.get_json("ips-search/table-result", {}) == {"ok": 1}
    request = opener.requests[0]
    headers = {k.lower(): v for k, v in request.header_items()}
    assert headers["accept"] == "application/json"
    assert headers["accept-language"] == "en"
    assert headers["referer"] == "https://www3.wipo.int/"
    assert headers["user-agent"] == "PatentAtlas/0.1 (+https://github.com/lina-here/patent-atlas)"
    assert request.get_method() == "GET"


def test_get_text_accepts_plain():
    client, opener = make_client(b"Last updated: May 2026")
    assert client.get_text("ips-search/en/last-updated") == "Last updated: May 2026"
    headers = {k.lower(): v for k, v in opener.requests[0].header_items()}
    assert headers["accept"] == "text/plain"
    assert opener.requests[0].full_url == f"{API_BASE}/ips-search/en/last-updated"


def test_builds_query():
    client, opener = make_client(b"{}")
    client.get_json(
        "ips-search/table-result",
        {"indicator": "10", "ipsOriSelValues": "CH,US", "ipsTechSelValues": "910,911"},
    )
    url = opener.requests[0].full_url
    assert url == (
        f"{API_BASE}/ips-search/table-result"
        "?indicator=10&ipsOriSelValues=CH,US&ipsTechSelValues=910,911"
    )


def test_query_escapes_spaces_and_ampersands():
    client, opener = make_client(b"{}")
    client.get_json("x", {"a": "b c&d"})
    assert opener.requests[0].full_url.endswith("/x?a=b%20c%26d")


def test_html_body_raises_wipo_error():
    client, _ = make_client(b"<!DOCTYPE html><html><body>Error</body></html>")
    with pytest.raises(WipoError, match="HTML"):
        client.get_json("x", {})


def test_non_json_body_raises():
    client, _ = make_client(b"not json at all")
    with pytest.raises(WipoError, match="JSON"):
        client.get_json("x", {})


def test_json_non_object_raises():
    client, _ = make_client(b"[1, 2]")
    with pytest.raises(WipoError, match="object"):
        client.get_json("x", {})


def test_text_html_body_raises():
    client, _ = make_client(b"<html>oops</html>")
    with pytest.raises(WipoError, match="HTML"):
        client.get_text("x")


def http_error(code):
    return urllib.error.HTTPError("u", code, "error", {}, io.BytesIO(b""))


def test_http_error_raises_after_retries():
    sleeps = []
    client, opener = make_client(http_error(500), http_error(502), http_error(503), sleeps=sleeps)
    with pytest.raises(WipoError, match="503"):
        client.get_json("x", {})
    assert len(opener.requests) == 3 and sleeps == list(RETRY_BACKOFF_S) == [2.0, 6.0]


def test_http_4xx_not_retried():
    sleeps = []
    client, opener = make_client(http_error(404), sleeps=sleeps)
    with pytest.raises(WipoError, match="404"):
        client.get_json("x", {})
    assert len(opener.requests) == 1 and sleeps == []


def test_retry_then_success():
    sleeps = []
    client, opener = make_client(TimeoutError("timed out"), http_error(500), b"{}", sleeps=sleeps)
    assert client.get_json("x", {}) == {}
    assert len(opener.requests) == 3 and sleeps == [2.0, 6.0]


def test_url_error_raises():
    client, _ = make_client(*[urllib.error.URLError("no route")] * 3)
    with pytest.raises(WipoError, match="no route"):
        client.get_text("x")


def test_delay_between_calls():
    sleeps = []
    client, _ = make_client(b"{}", b"{}", b"{}", sleeps=sleeps)
    client.get_json("a", {})
    assert sleeps == []
    client.get_json("b", {})
    client.get_json("c", {})
    assert sleeps == [1.0, 1.0]


def test_release_string_ips_and_pmh():
    client, opener = make_client(
        b"Source: WIPO statistics database. Last updated: May 2026",
        b"Last updated: October 2026\n",
    )
    assert client.release_string("ips") == "Last updated: May 2026"
    assert client.release_string("pmh") == "Last updated: October 2026"
    assert opener.requests[0].full_url.endswith("/ips-search/en/last-updated")
    assert opener.requests[1].full_url.endswith("/pmh-search/en/last-updated")


def test_release_string_rejects_unknown_tab():
    client, _ = make_client()
    with pytest.raises(ValueError):
        client.release_string("trademark")  # type: ignore[arg-type]


def test_release_string_missing_marker_raises():
    client, _ = make_client(b"something else")
    with pytest.raises(WipoError, match="Last updated"):
        client.release_string("ips")


@pytest.mark.parametrize(
    "error",
    [TimeoutError("timed out"), ConnectionResetError("reset"), http.client.IncompleteRead(b"ab")],
)
def test_other_network_failures_raise_wipo_error(error):
    client, _ = make_client(error, error, error)
    with pytest.raises(WipoError, match="request failed"):
        client.get_json("x", {})


@pytest.mark.parametrize(
    "text", [b"Last updated: soon", b"Last updated: May", b"Last updated: 2026", b"Last updated:"]
)
def test_release_string_strict_format(text):
    client, _ = make_client(text)
    with pytest.raises(WipoError, match="Last updated"):
        client.release_string("ips")


class FakeResponse:
    def __init__(self, status, body=b"{}"):
        self.status = status
        self._body = body

    def read(self):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def test_default_opener_non_200_raises(monkeypatch):
    monkeypatch.setattr(urllib.request, "urlopen", lambda request, timeout: FakeResponse(204))
    client = WipoClient(sleep=lambda _: None)
    with pytest.raises(WipoError, match="204"):
        client.get_json("x", {})


def test_default_opener_200_returns_body(monkeypatch):
    monkeypatch.setattr(urllib.request, "urlopen", lambda request, timeout: FakeResponse(200, b'{"a": 1}'))
    client = WipoClient(sleep=lambda _: None)
    assert client.get_json("x", {}) == {"a": 1}
