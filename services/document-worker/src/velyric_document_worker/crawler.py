from __future__ import annotations

import re
from dataclasses import dataclass
from typing import TYPE_CHECKING, Protocol
from urllib.parse import urldefrag, urljoin, urlsplit

import structlog
from defusedxml import ElementTree
from defusedxml.common import DefusedXmlException

from velyric_document_worker.fetcher import FetchedDocument, FetchError
from velyric_document_worker.parsers import discover_links

if TYPE_CHECKING:
    from collections.abc import Iterable
    from xml.etree.ElementTree import Element

log = structlog.get_logger("velyric.document_worker.crawler")

MAX_PAGES = 20
MAX_DEPTH = 2
MAX_SITEMAP_BYTES = 2 * 1024 * 1024
MAX_PAGE_BYTES = 3 * 1024 * 1024
MAX_SITEMAP_INDEX_CHILDREN = 25
_MIN_REGISTRABLE_LABELS = 2
_MIN_PREFIX_PATH_SEGMENTS = 2

_SKIP_EXTENSIONS = re.compile(
    r"\.(?:jpg|jpeg|png|gif|webp|svg|ico|css|js|mjs|json|xml|zip|rar|7z|mp3|mp4|mov|avi|"
    r"woff2?|ttf|eot|exe|dmg|apk)(?:[?#]|$)",
    re.IGNORECASE,
)
_SKIP_SCHEMES = ("mailto:", "tel:", "javascript:", "data:", "sms:", "whatsapp:")
_SITEMAP_LOC = re.compile(r"\{[^}]*\}loc$")


class PageFetcher(Protocol):
    async def fetch(self, url: str, max_bytes: int) -> FetchedDocument: ...


@dataclass(frozen=True)
class CrawledPage:
    url: str
    document: FetchedDocument


def _same_site(seed_host: str, candidate_host: str) -> bool:
    if candidate_host == seed_host:
        return True
    seed_labels = seed_host.split(".")
    candidate_labels = candidate_host.split(".")
    min_labels = _MIN_REGISTRABLE_LABELS
    if len(seed_labels) < min_labels or len(candidate_labels) < min_labels:
        return False
    return seed_labels[-min_labels:] == candidate_labels[-min_labels:]


def _accept_same_site_url(seed_host: str, url: str | None) -> str | None:
    if url is None:
        return None
    candidate_host = urlsplit(url).hostname
    if candidate_host is None or not _same_site(seed_host, candidate_host):
        return None
    return url


def normalize_url(base_url: str, href: str) -> str | None:
    if href.startswith(_SKIP_SCHEMES):
        return None
    joined = urljoin(base_url, href)
    joined, _fragment = urldefrag(joined)
    parts = urlsplit(joined)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        return None
    if _SKIP_EXTENSIONS.search(parts.path):
        return None
    path = parts.path.rstrip("/") or "/"
    query = f"?{parts.query}" if parts.query else ""
    return f"{parts.scheme}://{parts.hostname.lower()}{path}{query}"


def _path_prefix(seed_url: str) -> str:
    segments = [segment for segment in urlsplit(seed_url).path.split("/") if segment]
    if not segments:
        return ""
    depth = min(len(segments), _MIN_PREFIX_PATH_SEGMENTS)
    return "/" + "/".join(segments[:depth])


def _matches_prefix(url: str, prefix: str) -> bool:
    if not prefix:
        return True
    path = urlsplit(url).path.rstrip("/") or "/"
    return path == prefix or path.startswith(f"{prefix}/")


def _prioritize(urls: list[str], prefix: str, limit: int) -> list[str]:
    preferred = [url for url in urls if _matches_prefix(url, prefix)]
    rest = [url for url in urls if not _matches_prefix(url, prefix)]
    return (preferred + rest)[:limit]


async def _fetch_sitemap_xml(fetcher: PageFetcher, sitemap_url: str) -> Element | None:
    try:
        document = await fetcher.fetch(sitemap_url, MAX_SITEMAP_BYTES)
    except FetchError:
        return None
    try:
        root: Element = ElementTree.fromstring(document.body)
    except (ElementTree.ParseError, DefusedXmlException):
        return None
    return root


def _normalize_sitemap_loc(base_url: str, href: str) -> str | None:
    joined = urljoin(base_url, href)
    joined, _fragment = urldefrag(joined)
    parts = urlsplit(joined)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        return None
    path = parts.path.rstrip("/") or "/"
    query = f"?{parts.query}" if parts.query else ""
    return f"{parts.scheme}://{parts.hostname.lower()}{path}{query}"


def _locs(root: Element, seed_url: str, seed_host: str, *, is_sitemap: bool = False) -> list[str]:
    found: list[str] = []
    for element in root.iter():
        if not (_SITEMAP_LOC.search(element.tag) and element.text):
            continue
        raw = element.text.strip()
        normalized = (
            _normalize_sitemap_loc(seed_url, raw) if is_sitemap else normalize_url(seed_url, raw)
        )
        accepted = _accept_same_site_url(seed_host, normalized)
        if accepted is not None:
            found.append(accepted)
    return found


async def _sitemap_urls(fetcher: PageFetcher, seed_url: str, seed_host: str) -> list[str]:
    parts = urlsplit(seed_url)
    sitemap_url = f"{parts.scheme}://{parts.hostname}/sitemap.xml"
    root = await _fetch_sitemap_xml(fetcher, sitemap_url)
    if root is None:
        return []
    if root.tag.endswith("sitemapindex"):
        child_urls = _locs(root, seed_url, seed_host, is_sitemap=True)[:MAX_SITEMAP_INDEX_CHILDREN]
        found: list[str] = []
        for child_url in child_urls:
            child_root = await _fetch_sitemap_xml(fetcher, child_url)
            if child_root is None or child_root.tag.endswith("sitemapindex"):
                continue
            found.extend(_locs(child_root, seed_url, seed_host))
        return found
    return _locs(root, seed_url, seed_host)


def _queue_new_links(
    base_url: str,
    hrefs: Iterable[str],
    seed_host: str,
    seen: set[str],
    depth: int,
    prefix: str,
) -> tuple[list[tuple[str, int]], list[tuple[str, int]]]:
    preferred: list[tuple[str, int]] = []
    rest: list[tuple[str, int]] = []
    for href in hrefs:
        normalized = normalize_url(base_url, href)
        if normalized is None or normalized in seen:
            continue
        if _accept_same_site_url(seed_host, normalized) is None:
            continue
        seen.add(normalized)
        (preferred if _matches_prefix(normalized, prefix) else rest).append((normalized, depth))
    return preferred, rest


async def _fetch_html_page(fetcher: PageFetcher, url: str) -> FetchedDocument | None:
    try:
        document = await fetcher.fetch(url, MAX_PAGE_BYTES)
    except FetchError:
        return None
    if document.content_type not in ("text/html", "application/xhtml+xml"):
        return None
    return document


async def discover_pages(
    fetcher: PageFetcher,
    seed_url: str,
    seed_links: tuple[str, ...],
    *,
    max_pages: int = MAX_PAGES,
    max_depth: int = MAX_DEPTH,
) -> list[CrawledPage]:
    """Fetch up to max_pages same-site HTML pages reachable from the seed page.

    Prefers the site's sitemap.xml when available (fast, high-coverage, no guessing);
    otherwise falls back to a breadth-first crawl of same-site links discovered on
    each fetched page. Every fetch reuses the caller's already SSRF-safe fetcher.
    """
    seed_host = urlsplit(seed_url).hostname or ""
    prefix = _path_prefix(seed_url)
    seen: set[str] = {normalize_url(seed_url, seed_url) or seed_url}
    pages: list[CrawledPage] = []

    sitemap_urls = await _sitemap_urls(fetcher, seed_url, seed_host)
    if sitemap_urls:
        for url in _prioritize(sitemap_urls, prefix, max_pages * 4):
            if len(pages) >= max_pages or url in seen:
                continue
            seen.add(url)
            document = await _fetch_html_page(fetcher, url)
            if document is not None:
                pages.append(CrawledPage(url=url, document=document))
        if pages:
            return pages

    priority_queue, overflow_queue = _queue_new_links(
        seed_url, seed_links, seed_host, seen, 1, prefix
    )
    while (priority_queue or overflow_queue) and len(pages) < max_pages:
        url, depth = priority_queue.pop(0) if priority_queue else overflow_queue.pop(0)
        document = await _fetch_html_page(fetcher, url)
        if document is None:
            continue
        pages.append(CrawledPage(url=url, document=document))
        if depth >= max_depth:
            continue
        try:
            child_links = discover_links(document.body)
        except Exception:
            log.warning("crawl link discovery failed", url=url, exc_info=True)
            continue
        new_priority, new_overflow = _queue_new_links(
            url, child_links, seed_host, seen, depth + 1, prefix
        )
        priority_queue.extend(new_priority)
        overflow_queue.extend(new_overflow)

    return pages
