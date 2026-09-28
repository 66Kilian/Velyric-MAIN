from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass

MIN_WORDS_FOR_LANGUAGE = 8
LANGUAGE_MARGIN = 1.3
CARD_MIN_DIGITS = 13
CARD_MAX_DIGITS = 19
TAJ_DIGITS = 9
LUHN_DOUBLE_LIMIT = 9
HEADING_SEPARATOR = " / "

_WORD = re.compile(r"\w+", re.UNICODE)
_SENTENCE_END = re.compile(r"(?<=[.!?…])\s+(?=[A-ZÁÉÍÓÖŐÚÜŰÄ0-9„\"(])")
_WHITESPACE = re.compile(r"[ \t\u00a0]+")
_BLANK_LINES = re.compile(r"\n{3,}")

_STOPWORDS: dict[str, frozenset[str]] = {
    "hu": frozenset(
        [
            "a",
            "az",
            "és",
            "hogy",
            "nem",
            "is",
            "egy",
            "van",
            "meg",
            "csak",
            "de",
            "ha",
            "már",
            "mint",
            "vagy",
            "kell",
            "lesz",
            "ez",
            "azt",
            "volt",
            "minden",
            "után",
            "között",
            "szerint",
        ]
    ),
    "de": frozenset(
        [
            "der",
            "die",
            "das",
            "und",
            "ist",
            "nicht",
            "ein",
            "eine",
            "zu",
            "den",
            "mit",
            "von",
            "sich",
            "auf",
            "für",
            "im",
            "dem",
            "des",
            "auch",
            "wird",
            "bei",
            "oder",
        ]
    ),
    "en": frozenset(
        [
            "the",
            "and",
            "is",
            "not",
            "a",
            "an",
            "to",
            "of",
            "in",
            "for",
            "on",
            "with",
            "that",
            "this",
            "are",
            "be",
            "by",
            "or",
            "from",
            "at",
            "as",
            "your",
        ]
    ),
}

_PHONE = (
    r"(?<!\d)(?:\+|00)(?:36|49|43|44|1)[\s/-]?\d{1,3}[\s/-]?\d{3}[\s/-]?\d{3,4}(?!\d)"
    r"|(?<!\d)06[\s/-]?\d{1,2}[\s/-]?\d{3}[\s/-]?\d{3,4}(?!\d)"
)
_PII_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("EMAIL", re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b")),
    ("PHONE", re.compile(_PHONE)),
    ("IBAN", re.compile(r"\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){3,7}(?:\s?[A-Z0-9]{1,4})?\b")),
    ("HU_TAX_NUMBER", re.compile(r"(?<!\d)\d{8}-[1-5]-\d{2}(?!\d)")),
)
_CARD = re.compile(r"(?<!\d)(?:\d[ -]?){13,19}(?!\d)")
_TAJ = re.compile(r"(?<!\d)\d{3}[ -]?\d{3}[ -]?\d{3}(?!\d)")


@dataclass(frozen=True)
class Section:
    heading_path: tuple[str, ...]
    text: str
    page: int | None = None


@dataclass(frozen=True)
class Chunk:
    index: int
    content: str
    token_count: int
    heading_path: tuple[str, ...]
    page: int | None


def normalize(text: str) -> str:
    cleaned = unicodedata.normalize("NFC", text).replace("\r\n", "\n").replace("\r", "\n")
    cleaned = "".join(
        char for char in cleaned if char in "\n\t" or unicodedata.category(char)[0] != "C"
    )
    lines = [_WHITESPACE.sub(" ", line).strip() for line in cleaned.split("\n")]
    return _BLANK_LINES.sub("\n\n", "\n".join(lines)).strip()


def estimate_tokens(text: str) -> int:
    words = len(_WORD.findall(text))
    return max(1, round(max(words * 1.6, len(text) / 3.8)))


def detect_language(text: str) -> str | None:
    words = [word.lower() for word in _WORD.findall(text[:20000])]
    if len(words) < MIN_WORDS_FOR_LANGUAGE:
        return None
    scores = {
        language: sum(1 for word in words if word in stopwords)
        for language, stopwords in _STOPWORDS.items()
    }
    best = max(scores, key=lambda language: scores[language])
    if scores[best] < max(3, len(words) // 50):
        return None
    ranked = sorted(scores.values(), reverse=True)
    if ranked[0] < ranked[1] * LANGUAGE_MARGIN:
        return None
    return best


def _luhn(digits: str) -> bool:
    total = 0
    for index, char in enumerate(reversed(digits)):
        value = int(char)
        if index % 2 == 1:
            value *= 2
            if value > LUHN_DOUBLE_LIMIT:
                value -= LUHN_DOUBLE_LIMIT
        total += value
    return total % 10 == 0


def _taj_valid(digits: str) -> bool:
    weights = (3, 7)
    checksum = sum(int(digit) * weights[index % 2] for index, digit in enumerate(digits[:8])) % 10
    return checksum == int(digits[8])


def detect_pii(text: str) -> tuple[str, ...]:
    found = {name for name, pattern in _PII_PATTERNS if pattern.search(text)}
    for match in _CARD.finditer(text):
        digits = re.sub(r"\D", "", match.group(0))
        if CARD_MIN_DIGITS <= len(digits) <= CARD_MAX_DIGITS and _luhn(digits):
            found.add("PAYMENT_CARD")
            break
    for match in _TAJ.finditer(text):
        digits = re.sub(r"\D", "", match.group(0))
        if len(digits) == TAJ_DIGITS and _taj_valid(digits):
            found.add("HU_SOCIAL_SECURITY_NUMBER")
            break
    return tuple(sorted(found))


def split_sentences(paragraph: str) -> list[str]:
    return [sentence.strip() for sentence in _SENTENCE_END.split(paragraph) if sentence.strip()]


def _hard_split(sentence: str, max_chars: int) -> list[str]:
    pieces: list[str] = []
    remaining = sentence
    while len(remaining) > max_chars:
        cut = remaining.rfind(" ", 0, max_chars)
        cut = cut if cut > max_chars // 2 else max_chars
        pieces.append(remaining[:cut].strip())
        remaining = remaining[cut:].strip()
    if remaining:
        pieces.append(remaining)
    return pieces


def _units(text: str, target_tokens: int, max_chars: int) -> list[str]:
    units: list[str] = []
    for raw in text.split("\n\n"):
        paragraph = raw.strip()
        if not paragraph:
            continue
        if estimate_tokens(paragraph) <= target_tokens and len(paragraph) <= max_chars:
            units.append(paragraph)
            continue
        for sentence in split_sentences(paragraph):
            units.extend(_hard_split(sentence, max_chars))
    return units


def _overlap(parts: list[str], overlap_tokens: int) -> list[str]:
    carried: list[str] = []
    carried_tokens = 0
    for previous in reversed(parts):
        previous_tokens = estimate_tokens(previous)
        if carried_tokens + previous_tokens > overlap_tokens:
            break
        carried.insert(0, previous)
        carried_tokens += previous_tokens
    return carried


def _compose(heading: str, parts: list[str], max_chars: int) -> str:
    body = "\n".join(parts).strip()
    content = f"{heading}\n{body}" if heading and not body.startswith(heading) else body
    return content[:max_chars]


def chunk_sections(
    sections: list[Section],
    *,
    target_tokens: int = 350,
    overlap_tokens: int = 60,
    max_chars: int = 4000,
) -> list[Chunk]:
    chunks: list[Chunk] = []
    for section in sections:
        heading = HEADING_SEPARATOR.join(section.heading_path)
        groups: list[list[str]] = []
        current: list[str] = []
        for unit in _units(section.text, target_tokens, max_chars - len(heading) - 1):
            projected = sum(estimate_tokens(part) for part in current) + estimate_tokens(unit)
            too_long = len("\n".join([*current, unit])) > max_chars - len(heading) - 1
            if current and (projected > target_tokens or too_long):
                groups.append(current)
                current = _overlap(current, overlap_tokens)
            current.append(unit)
        if current:
            groups.append(current)
        for group in groups:
            content = _compose(heading, group, max_chars)
            if content:
                chunks.append(
                    Chunk(
                        index=len(chunks),
                        content=content,
                        token_count=estimate_tokens(content),
                        heading_path=section.heading_path,
                        page=section.page,
                    )
                )
    return chunks
