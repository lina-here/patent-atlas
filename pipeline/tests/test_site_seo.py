"""Search and link-preview tags in the static HTML: absolute URLs follow
site/config.json baseUrl, so moving the site fails here until every page, the sitemap and robots.txt follow."""
import json
import re
import struct
import xml.etree.ElementTree as ElementTree
from datetime import date
from html.parser import HTMLParser
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SITE = ROOT / "site"
BASE_URL = json.loads((SITE / "config.json").read_text("utf-8"))["baseUrl"]
PAGES = sorted(SITE.glob("*.html"))
OG_IMAGE = SITE / "og" / "patent-atlas.png"
OG_IMAGE_SIZE = (1200, 630)  # the large-card size link previews expect
OG_IMAGE_MAX_BYTES = 300_000
SITEMAP_NAMESPACE = "{http://www.sitemaps.org/schemas/sitemap/0.9}"


class HeadTags(HTMLParser):
    """<title>, <meta name|property>, <link rel> of one page."""

    def __init__(self):
        super().__init__()
        self.meta: dict[str, str] = {}
        self.links: dict[str, str] = {}
        self.title = ""
        self._in_title = False

    def handle_starttag(self, tag, attrs):
        values = dict(attrs)
        if tag == "meta" and (values.get("name") or values.get("property")):
            self.meta[values.get("name") or values.get("property")] = values.get("content") or ""
        elif tag == "link" and values.get("rel"):
            self.links[values["rel"]] = values.get("href") or ""
        elif tag == "title":
            self._in_title = True

    def handle_endtag(self, tag):
        if tag == "title":
            self._in_title = False

    def handle_data(self, data):
        if self._in_title:
            self.title += data


def head(page: Path) -> HeadTags:
    parser = HeadTags()
    parser.feed(page.read_text("utf-8"))
    return parser


def page_url(page: Path) -> str:
    """index.html is the folder URL, as the site is linked and as the sitemap lists it."""
    return BASE_URL if page.name == "index.html" else BASE_URL + page.name


def indexable() -> list[Path]:
    return [page for page in PAGES if "noindex" not in head(page).meta.get("robots", "")]


def test_base_url_is_an_absolute_https_folder():
    assert re.fullmatch(r"https://[^/\s]+/(?:[^\s]*/)?", BASE_URL), BASE_URL


def test_only_the_embed_page_is_kept_out_of_search():
    assert {page.name for page in PAGES} - {page.name for page in indexable()} == {"embed.html"}
    embed = head(SITE / "embed.html")
    assert "canonical" not in embed.links


def test_titles_and_descriptions_are_unique_and_sized_for_results():
    pages = indexable()
    titles = [head(page).title.strip() for page in pages]
    descriptions = [head(page).meta.get("description", "") for page in pages]
    for page, title, description in zip(pages, titles, descriptions):
        assert 30 <= len(title) <= 60, (page.name, len(title))
        assert 120 <= len(description) <= 160, (page.name, len(description))
        assert not re.search(r"\d", description), (page.name, "no figures in a description: they go stale")
    assert len(set(titles)) == len(titles)
    assert len(set(descriptions)) == len(descriptions)


def test_canonical_and_link_preview_tags_follow_the_base_url():
    for page in indexable():
        tags = head(page)
        url = page_url(page)
        assert tags.links.get("canonical") == url, page.name
        assert tags.meta.get("og:url") == url, page.name
        assert tags.meta.get("og:title") == tags.title.strip(), page.name
        assert tags.meta.get("og:description") == tags.meta.get("description"), page.name
        assert tags.meta.get("og:type") == "website", page.name
        assert tags.meta.get("og:image") == BASE_URL + "og/patent-atlas.png", page.name
        assert (tags.meta.get("og:image:width"), tags.meta.get("og:image:height")) == tuple(map(str, OG_IMAGE_SIZE))
        assert tags.meta.get("og:image:alt"), page.name
        assert tags.meta.get("twitter:card") == "summary_large_image", page.name


def test_link_preview_image_is_a_small_png_of_the_expected_size():
    data = OG_IMAGE.read_bytes()
    assert data[:8] == b"\x89PNG\r\n\x1a\n"
    assert struct.unpack(">II", data[16:24]) == OG_IMAGE_SIZE
    assert len(data) < OG_IMAGE_MAX_BYTES


def test_sitemap_lists_exactly_the_indexable_pages():
    root = ElementTree.parse(SITE / "sitemap.xml").getroot()
    assert root.tag == f"{SITEMAP_NAMESPACE}urlset"
    entries = root.findall(f"{SITEMAP_NAMESPACE}url")
    locations = [entry.findtext(f"{SITEMAP_NAMESPACE}loc") for entry in entries]
    assert sorted(locations) == sorted(page_url(page) for page in indexable())
    for entry in entries:
        date.fromisoformat(entry.findtext(f"{SITEMAP_NAMESPACE}lastmod"))


def test_robots_allows_all_and_names_the_sitemap():
    lines = [line.strip() for line in (SITE / "robots.txt").read_text("utf-8").splitlines() if line.strip()]
    assert "User-agent: *" in lines
    assert not any(line.lower().startswith("disallow:") and line.split(":", 1)[1].strip() for line in lines)
    assert f"Sitemap: {BASE_URL}sitemap.xml" in lines
