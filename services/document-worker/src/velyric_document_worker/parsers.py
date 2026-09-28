from __future__ import annotations

import csv
import io
import re
import shutil
import zipfile
from dataclasses import dataclass
from functools import partial
from html.parser import HTMLParser
from types import MappingProxyType
from typing import TYPE_CHECKING, Annotated, ClassVar, Literal

import docx
import filetype
import pdfplumber
from markdown_it import MarkdownIt
from pydantic import ConfigDict, Field, TypeAdapter, ValidationError

from velyric_document_worker.generated.enums import KnowledgeSourceType
from velyric_document_worker.text import Section, normalize

if TYPE_CHECKING:
    from collections.abc import Callable

MAX_PDF_PAGES = 500
MAX_CSV_ROWS = 5000
MAX_DOCX_UNCOMPRESSED_BYTES = 200 * 1024 * 1024
MAX_HEADING_LEVEL = 4
PDF_MIME = "application/pdf"
DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
HTML_MIMES = ("text/html", "application/xhtml+xml")
REMOTE_TYPES = (KnowledgeSourceType.URL, KnowledgeSourceType.WEBSITE)

_SKIP_TAGS = frozenset(
    {
        "script",
        "style",
        "noscript",
        "template",
        "svg",
        "nav",
        "header",
        "footer",
        "form",
        "iframe",
        "head",
    }
)
_MODAL_CLASS_RE = re.compile(r"(?:^|\s)modal(?:\s|$)")
_PARAGRAPH_TAGS = frozenset({"p", "div", "section", "article", "table"})
_LINE_TAGS = frozenset({"li", "tr", "br", "ul", "ol", "dd", "dt", "blockquote", "pre"})
_HEADING_TAGS = MappingProxyType({"h1": 1, "h2": 2, "h3": 3, "h4": 4})
_HEADING_STYLES = ("heading", "címsor", "überschrift", "title")


class ParseError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class ParsedDocument:
    parser: str
    sections: list[Section]
    ocr_used: bool
    links: tuple[str, ...] = ()
    json_ld: tuple[str, ...] = ()

    @property
    def text_length(self) -> int:
        return sum(len(section.text) for section in self.sections)


@dataclass(frozen=True)
class _FaqEntry:
    __pydantic_config__: ClassVar[ConfigDict] = ConfigDict(extra="forbid")
    question: Annotated[str, Field(min_length=1, max_length=1000)]
    answer: Annotated[str, Field(min_length=1, max_length=8000)]


@dataclass(frozen=True)
class _FaqDocument:
    __pydantic_config__: ClassVar[ConfigDict] = ConfigDict(extra="forbid")
    format: Literal["velyric.faq.v1"]
    language: str | None
    entries: Annotated[list[_FaqEntry], Field(min_length=1, max_length=1000)]


_faq_adapter: TypeAdapter[_FaqDocument] = TypeAdapter(_FaqDocument)


_MAX_LINKS = 500
_MAX_JSON_LD = 20
_MAX_JSON_LD_CHARS = 50_000


def _is_modal(attrs: list[tuple[str, str | None]]) -> bool:
    class_value = next((value for name, value in attrs if name == "class" and value), None)
    return class_value is not None and _MODAL_CLASS_RE.search(class_value) is not None


class _HtmlExtractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.sections: list[Section] = []
        self.links: list[str] = []
        self.json_ld: list[str] = []
        self._skip_depth = 0
        self._headings: list[str] = []
        self._heading_level: int | None = None
        self._heading_text: list[str] = []
        self._buffer: list[str] = []
        self._in_json_ld = False
        self._json_ld_buffer: list[str] = []
        self._modal_div_depth = 0

    def _flush(self) -> None:
        text = normalize("".join(self._buffer))
        if text:
            self.sections.append(Section(heading_path=tuple(self._headings), text=text))
        self._buffer = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag == "a" and len(self.links) < _MAX_LINKS:
            href = next((value for name, value in attrs if name == "href" and value), None)
            if href:
                self.links.append(href)
        if tag == "script":
            script_type = next((value for name, value in attrs if name == "type"), None)
            if script_type is not None and script_type.strip().lower() == "application/ld+json":
                if len(self.json_ld) < _MAX_JSON_LD:
                    self._in_json_ld = True
                    self._json_ld_buffer = []
                return
            self._skip_depth += 1
            return
        if tag in _SKIP_TAGS:
            self._skip_depth += 1
            return
        if self._modal_div_depth:
            if tag == "div":
                self._modal_div_depth += 1
            return
        if tag == "div" and _is_modal(attrs):
            self._skip_depth += 1
            self._modal_div_depth = 1
            return
        if self._skip_depth:
            return
        if tag in _HEADING_TAGS:
            self._flush()
            self._heading_level = _HEADING_TAGS[tag]
            self._heading_text = []
        elif tag in _PARAGRAPH_TAGS:
            self._buffer.append("\n\n")
        elif tag in _LINE_TAGS:
            self._buffer.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag == "script" and self._in_json_ld:
            content = "".join(self._json_ld_buffer)[:_MAX_JSON_LD_CHARS]
            if content.strip():
                self.json_ld.append(content)
            self._in_json_ld = False
            self._json_ld_buffer = []
            return
        if tag in _SKIP_TAGS:
            self._skip_depth = max(0, self._skip_depth - 1)
            return
        if self._modal_div_depth and tag == "div":
            self._modal_div_depth -= 1
            if self._modal_div_depth == 0:
                self._skip_depth = max(0, self._skip_depth - 1)
            return
        if self._skip_depth:
            return
        if tag in _HEADING_TAGS and self._heading_level is not None:
            heading = normalize(" ".join(self._heading_text))
            parents = self._headings[: self._heading_level - 1]
            self._headings = [*parents, heading] if heading else parents
            self._heading_level = None
        elif tag in _PARAGRAPH_TAGS:
            self._buffer.append("\n\n")

    def handle_data(self, data: str) -> None:
        if self._in_json_ld:
            self._json_ld_buffer.append(data)
            return
        if self._skip_depth:
            return
        if self._heading_level is not None:
            self._heading_text.append(data)
        else:
            self._buffer.append(data)

    def close(self) -> None:
        super().close()
        self._flush()


def _decode(body: bytes) -> str:
    for encoding in ("utf-8-sig", "utf-16"):
        try:
            return body.decode(encoding)
        except UnicodeDecodeError:
            continue
    return body.decode("cp1250", errors="replace")


def _ocr(page: pdfplumber.page.Page) -> str:
    import pytesseract  # noqa: PLC0415

    image = page.to_image(resolution=200).original
    return normalize(str(pytesseract.image_to_string(image, lang="hun+deu+eng")))


def _pdf_sections(pdf: pdfplumber.pdf.PDF, *, ocr_enabled: bool) -> tuple[list[Section], bool]:
    sections: list[Section] = []
    ocr_used = False
    can_ocr = ocr_enabled and shutil.which("tesseract") is not None
    for number, page in enumerate(pdf.pages, start=1):
        text = normalize(page.extract_text(layout=False) or "")
        if not text and can_ocr:
            text = _ocr(page)
            ocr_used = ocr_used or bool(text)
        if text:
            sections.append(Section(heading_path=(), text=text, page=number))
    return sections, ocr_used


def _parse_pdf(body: bytes, *, ocr_enabled: bool) -> ParsedDocument:
    try:
        pdf = pdfplumber.open(io.BytesIO(body))
    except Exception as error:
        raise ParseError(
            "pdf_unreadable", f"PDF could not be opened: {type(error).__name__}"
        ) from error
    with pdf:
        if len(pdf.pages) > MAX_PDF_PAGES:
            raise ParseError("pdf_too_many_pages", f"PDF has more than {MAX_PDF_PAGES} pages")
        try:
            sections, ocr_used = _pdf_sections(pdf, ocr_enabled=ocr_enabled)
        except Exception as error:
            message = f"PDF could not be parsed: {type(error).__name__}"
            raise ParseError("pdf_unreadable", message) from error
    return ParsedDocument(parser="pdfplumber", sections=sections, ocr_used=ocr_used)


def _docx_uncompressed_size(body: bytes) -> int:
    try:
        with zipfile.ZipFile(io.BytesIO(body)) as archive:
            return sum(info.file_size for info in archive.infolist())
    except zipfile.BadZipFile as error:
        raise ParseError("docx_unreadable", "DOCX is not a valid archive") from error


def _parse_docx(body: bytes) -> ParsedDocument:
    if _docx_uncompressed_size(body) > MAX_DOCX_UNCOMPRESSED_BYTES:
        raise ParseError("docx_decompression_limit", "DOCX expands beyond the safe size limit")
    try:
        document = docx.Document(io.BytesIO(body))
    except Exception as error:
        message = f"DOCX could not be parsed: {type(error).__name__}"
        raise ParseError("docx_unreadable", message) from error
    sections: list[Section] = []
    headings: list[str] = []
    buffer: list[str] = []

    def flush() -> None:
        text = normalize("\n\n".join(buffer))
        if text:
            sections.append(Section(heading_path=tuple(headings), text=text))
        buffer.clear()

    for paragraph in document.paragraphs:
        style = (paragraph.style.name if paragraph.style is not None else "") or ""
        text = paragraph.text.strip()
        if not text:
            continue
        if style.lower().startswith(_HEADING_STYLES):
            flush()
            digits = "".join(char for char in style if char.isdigit())
            level = max(1, min(MAX_HEADING_LEVEL, int(digits))) if digits else 1
            headings[:] = [*headings[: level - 1], text]
        else:
            buffer.append(text)
    for table in document.tables:
        for row in table.rows:
            cells = [cell.text.strip() for cell in row.cells if cell.text.strip()]
            if cells:
                buffer.append(" | ".join(dict.fromkeys(cells)))
    flush()
    return ParsedDocument(parser="python-docx", sections=sections, ocr_used=False)


def _parse_markdown(body: bytes) -> ParsedDocument:
    tokens = MarkdownIt("commonmark").parse(_decode(body))
    sections: list[Section] = []
    headings: list[str] = []
    buffer: list[str] = []
    level = 1
    for index, token in enumerate(tokens):
        if token.type == "heading_open":
            text = normalize("\n\n".join(buffer))
            if text:
                sections.append(Section(heading_path=tuple(headings), text=text))
            buffer = []
            level = int(token.tag[1:]) if token.tag[1:].isdigit() else 1
        elif token.type == "inline" and index > 0 and tokens[index - 1].type == "heading_open":
            headings = [*headings[: level - 1], token.content.strip()]
        elif token.type in ("inline", "fence", "code_block"):
            buffer.append(token.content)
    text = normalize("\n\n".join(buffer))
    if text:
        sections.append(Section(heading_path=tuple(headings), text=text))
    return ParsedDocument(parser="markdown-it", sections=sections, ocr_used=False)


def _column(header: list[str], index: int) -> str:
    if index < len(header) and header[index]:
        return header[index]
    return f"column_{index + 1}"


def _parse_csv(body: bytes) -> ParsedDocument:
    text = _decode(body)
    try:
        dialect: type[csv.Dialect] | csv.Dialect = csv.Sniffer().sniff(
            text[:4096], delimiters=",;\t"
        )
    except csv.Error:
        dialect = csv.excel
    rows = list(csv.reader(io.StringIO(text), dialect))
    if not rows:
        return ParsedDocument(parser="csv", sections=[], ocr_used=False)
    header = [cell.strip() for cell in rows[0]]
    lines: list[str] = []
    for row in rows[1 : MAX_CSV_ROWS + 1]:
        pairs = [
            f"{_column(header, index)}: {value.strip()}"
            for index, value in enumerate(row)
            if value.strip()
        ]
        if pairs:
            lines.append("; ".join(pairs))
    sections = [Section(heading_path=(), text="\n\n".join(lines))] if lines else []
    return ParsedDocument(parser="csv", sections=sections, ocr_used=False)


def _parse_faq(body: bytes) -> ParsedDocument:
    try:
        document = _faq_adapter.validate_json(body)
    except ValidationError as error:
        raise ParseError("faq_invalid", "FAQ document is malformed") from error
    sections = [
        Section(
            heading_path=(entry.question.strip(),),
            text=normalize(f"Kérdés: {entry.question}\n\nVálasz: {entry.answer}"),
        )
        for entry in document.entries
    ]
    return ParsedDocument(parser="velyric-faq", sections=sections, ocr_used=False)


def discover_links(body: bytes) -> tuple[str, ...]:
    extractor = _HtmlExtractor()
    extractor.feed(_decode(body))
    extractor.close()
    return tuple(extractor.links)


def _parse_html(body: bytes) -> ParsedDocument:
    extractor = _HtmlExtractor()
    extractor.feed(_decode(body))
    extractor.close()
    return ParsedDocument(
        parser="html",
        sections=extractor.sections,
        ocr_used=False,
        links=tuple(extractor.links),
        json_ld=tuple(extractor.json_ld),
    )


def _parse_text(body: bytes) -> ParsedDocument:
    text = normalize(_decode(body))
    sections = [Section(heading_path=(), text=text)] if text else []
    return ParsedDocument(parser="text", sections=sections, ocr_used=False)


def _require_sniffed(sniffed: str | None, allowed: tuple[str, ...], label: str) -> None:
    if sniffed not in allowed:
        raise ParseError("content_type_mismatch", f"document is not a {label}")


def _select(
    source_type: str,
    content_type: str,
    sniffed: str | None,
    pdf_parser: Callable[[bytes], ParsedDocument],
) -> Callable[[bytes], ParsedDocument]:
    remote = source_type in REMOTE_TYPES
    if source_type == KnowledgeSourceType.FILE_PDF or (remote and content_type == PDF_MIME):
        _require_sniffed(sniffed, (PDF_MIME,), "PDF")
        return pdf_parser
    if source_type == KnowledgeSourceType.FILE_DOCX or (remote and content_type == DOCX_MIME):
        _require_sniffed(sniffed, (DOCX_MIME, "application/zip"), "DOCX file")
        return _parse_docx
    if sniffed is not None and not sniffed.startswith("text/"):
        raise ParseError("content_type_mismatch", f"binary content ({sniffed}) is not allowed")
    if source_type == KnowledgeSourceType.FILE_MARKDOWN or content_type == "text/markdown":
        return _parse_markdown
    if source_type == KnowledgeSourceType.FILE_CSV or content_type == "text/csv":
        return _parse_csv
    if remote and content_type in HTML_MIMES:
        return _parse_html
    if source_type == KnowledgeSourceType.FILE_TXT or remote:
        return _parse_text
    raise ParseError("source_type_unsupported", f"source type {source_type} cannot be parsed")


def parse_document(
    source_type: str, body: bytes, content_type: str, *, ocr_enabled: bool
) -> ParsedDocument:
    if source_type in (KnowledgeSourceType.FAQ, KnowledgeSourceType.MANUAL_QA):
        return _parse_faq(body)
    kind = filetype.guess(body)
    sniffed = kind.mime if kind is not None else None
    parser = _select(
        source_type, content_type, sniffed, partial(_parse_pdf, ocr_enabled=ocr_enabled)
    )
    return parser(body)
