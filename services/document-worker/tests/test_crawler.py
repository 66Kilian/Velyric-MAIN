from __future__ import annotations

import hashlib
from dataclasses import dataclass, field

from velyric_document_worker.crawler import discover_pages, normalize_url
from velyric_document_worker.fetcher import FetchedDocument, FetchError


def _doc(body: bytes, content_type: str = "text/html") -> FetchedDocument:
    return FetchedDocument(
        body=body, content_type=content_type, sha256=hashlib.sha256(body).hexdigest(), final_url=""
    )


@dataclass
class FakeFetcher:
    pages: dict[str, FetchedDocument] = field(default_factory=dict)
    requested: list[str] = field(default_factory=list)

    async def fetch(self, url: str, max_bytes: int) -> FetchedDocument:
        self.requested.append(url)
        assert max_bytes > 0
        if url not in self.pages:
            raise FetchError("fetch_http_404", "not found", retryable=False)
        return self.pages[url]


def test_normalize_url_strips_fragments_and_trailing_slashes() -> None:
    assert normalize_url("https://site.test/a/", "b/") == "https://site.test/a/b"
    assert normalize_url("https://site.test", "/about#team") == "https://site.test/about"
    assert normalize_url("https://site.test", "mailto:info@site.test") is None
    # PDFs are kept - many sites publish a menu or price list only as a PDF,
    # and the pipeline can already parse remote PDFs once fetched.
    assert normalize_url("https://site.test", "/menu.pdf") == "https://site.test/menu.pdf"
    assert normalize_url("https://site.test", "/photo.jpg") is None
    assert normalize_url("https://site.test", "/style.css") is None


async def test_sitemap_is_preferred_when_available() -> None:
    sitemap = (
        b'<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
        b"<url><loc>https://site.test/about</loc></url>"
        b"<url><loc>https://site.test/menu</loc></url>"
        b"<url><loc>https://other.test/should-be-skipped</loc></url>"
        b"</urlset>"
    )
    fetcher = FakeFetcher(
        pages={
            "https://site.test/sitemap.xml": _doc(sitemap, "text/xml"),
            "https://site.test/about": _doc(b"<html><body>About</body></html>"),
            "https://site.test/menu": _doc(b"<html><body>Menu</body></html>"),
        }
    )
    pages = await discover_pages(fetcher, "https://site.test/", ())
    assert {page.url for page in pages} == {"https://site.test/about", "https://site.test/menu"}


async def test_falls_back_to_link_bfs_when_no_sitemap() -> None:
    fetcher = FakeFetcher(
        pages={
            "https://site.test/about": _doc(
                b'<html><body><a href="/team">Team</a><a href="/menu">Menu</a></body></html>'
            ),
            "https://site.test/team": _doc(b"<html><body>Team page</body></html>"),
            "https://site.test/menu": _doc(b"<html><body>Menu page</body></html>"),
        }
    )
    pages = await discover_pages(fetcher, "https://site.test/", ("/about",), max_depth=2)
    urls = {page.url for page in pages}
    assert urls == {"https://site.test/about", "https://site.test/team", "https://site.test/menu"}
    # sitemap.xml was tried first and failed (404), then the seed link plus its
    # own discovered links were fetched - never anything off-site or duplicated.
    assert fetcher.requested.count("https://site.test/about") == 1


async def test_respects_max_pages_and_max_depth() -> None:
    fetcher = FakeFetcher(
        pages={
            "https://site.test/a": _doc(b'<html><body><a href="/b">B</a></body></html>'),
            "https://site.test/b": _doc(b'<html><body><a href="/c">C</a></body></html>'),
            "https://site.test/c": _doc(b"<html><body>C</body></html>"),
        }
    )
    pages = await discover_pages(fetcher, "https://site.test/", ("/a",), max_depth=1)
    assert {page.url for page in pages} == {"https://site.test/a"}

    fetcher = FakeFetcher(
        pages={
            "https://site.test/a": _doc(b'<html><body><a href="/b">B</a></body></html>'),
            "https://site.test/b": _doc(b'<html><body><a href="/c">C</a></body></html>'),
            "https://site.test/c": _doc(b"<html><body>C</body></html>"),
        }
    )
    pages = await discover_pages(fetcher, "https://site.test/", ("/a",), max_pages=1, max_depth=3)
    assert len(pages) == 1


async def test_recurses_into_sitemap_index_children() -> None:
    index = (
        b'<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
        b"<sitemap><loc>https://site.test/sitemap/pages.xml</loc></sitemap>"
        b"<sitemap><loc>https://site.test/sitemap/empty.xml</loc></sitemap>"
        b"</sitemapindex>"
    )
    pages_sitemap = (
        b'<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
        b"<url><loc>https://site.test/about</loc></url>"
        b"</urlset>"
    )
    empty_sitemap = (
        b'<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
        b"</urlset>"
    )
    fetcher = FakeFetcher(
        pages={
            "https://site.test/sitemap.xml": _doc(index, "text/xml"),
            "https://site.test/sitemap/pages.xml": _doc(pages_sitemap, "text/xml"),
            "https://site.test/sitemap/empty.xml": _doc(empty_sitemap, "text/xml"),
            "https://site.test/about": _doc(b"<html><body>About</body></html>"),
        }
    )
    pages = await discover_pages(fetcher, "https://site.test/", ())
    assert {page.url for page in pages} == {"https://site.test/about"}


async def test_falls_back_to_bfs_when_sitemap_index_children_are_broken() -> None:
    # Mirrors a real site where /sitemap.xml is a sitemapindex but every child
    # sitemap is empty or returns a broken (non-XML) error page - the crawler
    # must not silently give up, it must still discover pages via link BFS.
    index = (
        b'<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
        b"<sitemap><loc>https://site.test/sitemap/broken.xml</loc></sitemap>"
        b"</sitemapindex>"
    )
    fetcher = FakeFetcher(
        pages={
            "https://site.test/sitemap.xml": _doc(index, "text/xml"),
            "https://site.test/sitemap/broken.xml": _doc(b"<!doctype html><p>500</p>", "text/html"),
            "https://site.test/about": _doc(b'<html><body><a href="/menu">Menu</a></body></html>'),
            "https://site.test/menu": _doc(b"<html><body>Menu</body></html>"),
        }
    )
    pages = await discover_pages(fetcher, "https://site.test/", ("/about",))
    assert {page.url for page in pages} == {"https://site.test/about", "https://site.test/menu"}


async def test_prioritizes_urls_under_the_seed_path_over_sibling_sections() -> None:
    # A multi-brand domain (e.g. a restaurant group site) can list hundreds of
    # unrelated pages in its sitemap. Pages under the seed's own path prefix
    # (its specific location) must be fetched before unrelated sibling pages.
    sitemap = (
        b'<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
        b"<url><loc>https://site.test/hu/other-brand/menu</loc></url>"
        b"<url><loc>https://site.test/hu/hubertus/kapcsolat</loc></url>"
        b"</urlset>"
    )
    fetcher = FakeFetcher(
        pages={
            "https://site.test/sitemap.xml": _doc(sitemap, "text/xml"),
            "https://site.test/hu/other-brand/menu": _doc(b"<html><body>Other</body></html>"),
            "https://site.test/hu/hubertus/kapcsolat": _doc(b"<html><body>Contact</body></html>"),
        }
    )
    pages = await discover_pages(fetcher, "https://site.test/hu/hubertus", (), max_pages=1)
    assert {page.url for page in pages} == {"https://site.test/hu/hubertus/kapcsolat"}


async def test_ignores_off_site_links_and_non_html_content() -> None:
    fetcher = FakeFetcher(
        pages={
            "https://site.test/a": _doc(
                b'<html><body><a href="https://evil.test/">Evil</a>'
                b'<a href="/report">Report</a></body></html>'
            ),
            "https://site.test/report": _doc(b"binary content", content_type="application/pdf"),
        }
    )
    pages = await discover_pages(fetcher, "https://site.test/", ("/a",))
    assert {page.url for page in pages} == {"https://site.test/a"}
    assert "https://evil.test/" not in fetcher.requested
