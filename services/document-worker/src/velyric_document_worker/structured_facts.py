from __future__ import annotations

import json
import re

from velyric_document_worker.text import Section, normalize

MAX_FACT_VALUE_CHARS = 500
MAX_FACTS = 60
_HHMM_RE = re.compile(r"^([01]\d|2[0-3]):[0-5]\d")
_ISO_WEEKDAYS: dict[str, int] = {
    "Monday": 1,
    "Tuesday": 2,
    "Wednesday": 3,
    "Thursday": 4,
    "Friday": 5,
    "Saturday": 6,
    "Sunday": 7,
}

_LABELS: dict[str, str] = {
    "name": "Name",
    "legalName": "Legal name",
    "alternateName": "Also known as",
    "description": "Description",
    "telephone": "Phone",
    "email": "Email",
    "priceRange": "Price range",
    "servesCuisine": "Cuisine",
    "acceptsReservations": "Accepts reservations",
    "paymentAccepted": "Accepted payment",
    "smokingAllowed": "Smoking allowed",
    "url": "Website",
}
_ADDRESS_LABELS: dict[str, str] = {
    "streetAddress": "Street",
    "addressLocality": "City",
    "addressRegion": "Region",
    "postalCode": "Postal code",
    "addressCountry": "Country",
}
_DAY_ABBREVIATIONS: dict[str, str] = {
    "Monday": "Mon",
    "Tuesday": "Tue",
    "Wednesday": "Wed",
    "Thursday": "Thu",
    "Friday": "Fri",
    "Saturday": "Sat",
    "Sunday": "Sun",
}


def _text(value: object) -> str | None:
    if isinstance(value, str):
        cleaned = value.strip()
        return cleaned[:MAX_FACT_VALUE_CHARS] if cleaned else None
    if isinstance(value, (int, float, bool)):
        return str(value)
    return None


def _day_label(value: str) -> str:
    short = value.rsplit("/", maxsplit=1)[-1]
    return _DAY_ABBREVIATIONS.get(short, short)


def _opening_hours(value: object) -> list[str]:
    entries = value if isinstance(value, list) else [value]
    lines: list[str] = []
    for entry in entries:
        if isinstance(entry, str):
            lines.append(entry.strip())
            continue
        if not isinstance(entry, dict):
            continue
        days = entry.get("dayOfWeek")
        day_list = days if isinstance(days, list) else [days] if days else []
        day_text = ", ".join(_day_label(day) for day in day_list if isinstance(day, str))
        opens = _text(entry.get("opens"))
        closes = _text(entry.get("closes"))
        if day_text and opens and closes:
            lines.append(f"{day_text}: {opens}-{closes}")
    return lines


def _address(value: object) -> str | None:
    if isinstance(value, str):
        return _text(value)
    if not isinstance(value, dict):
        return None
    parts = [
        text
        for key, label in _ADDRESS_LABELS.items()
        if (text := _text(value.get(key))) is not None
    ]
    return ", ".join(parts) if parts else None


def _structured_address(value: object) -> dict[str, str] | None:
    if not isinstance(value, dict):
        return None
    line1 = _text(value.get("streetAddress"))
    city = _text(value.get("addressLocality"))
    postal_code = _text(value.get("postalCode"))
    if line1 is None or city is None or postal_code is None:
        return None
    address = {"line1": line1[:200], "city": city[:100], "postal_code": postal_code[:16]}
    region = _text(value.get("addressRegion"))
    if region is not None:
        address["region"] = region[:100]
    return address


def _hhmm(value: object) -> str | None:
    text = _text(value)
    if text is None:
        return None
    match = _HHMM_RE.match(text)
    return match.group(0) if match else None


def _structured_hours(value: object) -> list[dict[str, object]]:
    entries = value if isinstance(value, list) else [value]
    hours: list[dict[str, object]] = []
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        opens = _hhmm(entry.get("opens"))
        closes = _hhmm(entry.get("closes"))
        if opens is None or closes is None or opens >= closes:
            continue
        days = entry.get("dayOfWeek")
        day_list = days if isinstance(days, list) else [days] if days else []
        for day in day_list:
            if not isinstance(day, str):
                continue
            short = day.rsplit("/", maxsplit=1)[-1]
            iso_weekday = _ISO_WEEKDAYS.get(short)
            if iso_weekday is not None:
                hours.append({"iso_weekday": iso_weekday, "opens": opens, "closes": closes})
    return hours


def location_facts(json_ld_payloads: list[str]) -> dict[str, object] | None:
    """Extract a structured address/business-hours pair from schema.org JSON-LD.

    Unlike structured_facts_section (a human-readable summary for retrieval), this
    returns data shaped exactly like the control-api locations API so it can be
    applied directly to the tenant's location record.
    """
    address: dict[str, str] | None = None
    hours: list[dict[str, object]] = []
    for payload in json_ld_payloads:
        try:
            parsed = json.loads(payload)
        except (json.JSONDecodeError, ValueError):
            continue
        for entity in _iter_entities(parsed):
            if address is None:
                address = _structured_address(entity.get("address"))
            if not hours:
                hours = _structured_hours(
                    entity.get("openingHoursSpecification") or entity.get("openingHours")
                )
    facts: dict[str, object] = {}
    if address is not None:
        facts["address"] = address
    if hours:
        facts["business_hours"] = hours
    return facts if facts else None


def _geo(value: object) -> str | None:
    if not isinstance(value, dict):
        return None
    latitude = _text(value.get("latitude"))
    longitude = _text(value.get("longitude"))
    return f"{latitude}, {longitude}" if latitude and longitude else None


MAX_MENU_DEPTH = 5


def _menu_item_line(item: dict[str, object]) -> str | None:
    name = _text(item.get("name"))
    if name is None:
        return None
    description = _text(item.get("description"))
    price = item.get("offers", {})
    price_text = _text(price.get("price")) if isinstance(price, dict) else None
    bits = [name]
    if price_text:
        bits.append(f"({price_text})")
    if description:
        bits.append(f"- {description}")
    return " ".join(bits)


def _walk_menu(node: object, lines: list[str], depth: int) -> None:
    if depth > MAX_MENU_DEPTH or len(lines) >= MAX_FACTS:
        return
    entries = node if isinstance(node, list) else [node]
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        for item in entry.get("hasMenuItem") or []:
            if isinstance(item, dict):
                line = _menu_item_line(item)
                if line is not None:
                    lines.append(line)
        sections = entry.get("hasMenuSection")
        if sections:
            _walk_menu(sections, lines, depth + 1)


def _menu_items(value: object) -> list[str]:
    lines: list[str] = []
    _walk_menu(value, lines, 0)
    return lines[:MAX_FACTS]


def _facts_from_object(entity: dict[str, object]) -> list[str]:
    facts: list[str] = []
    entity_type = entity.get("@type")
    type_text = ", ".join(entity_type) if isinstance(entity_type, list) else _text(entity_type)
    if type_text:
        facts.append(f"Type: {type_text}")
    for key, label in _LABELS.items():
        text = _text(entity.get(key))
        if text is not None:
            facts.append(f"{label}: {text}")
    address = _address(entity.get("address"))
    if address is not None:
        facts.append(f"Address: {address}")
    geo = _geo(entity.get("geo"))
    if geo is not None:
        facts.append(f"Coordinates: {geo}")
    hours = _opening_hours(entity.get("openingHoursSpecification") or entity.get("openingHours"))
    if hours:
        facts.append("Opening hours: " + "; ".join(hours))
    menu = _menu_items(entity.get("hasMenu") or entity.get("menu"))
    if menu:
        facts.append("Menu: " + "; ".join(menu))
    return facts


def _iter_entities(payload: object) -> list[dict[str, object]]:
    if isinstance(payload, dict):
        graph = payload.get("@graph")
        if isinstance(graph, list):
            return [entry for entry in graph if isinstance(entry, dict)]
        return [payload]
    if isinstance(payload, list):
        return [entry for entry in payload if isinstance(entry, dict)]
    return []


def structured_facts_section(json_ld_payloads: list[str]) -> Section | None:
    """Flatten schema.org JSON-LD (LocalBusiness/Restaurant, etc.) into readable facts.

    Many business sites embed structured address/phone/hours/menu data as JSON-LD for
    search engines; this reuses that same data as a small, high-signal, always-relevant
    chunk instead of relying purely on similarity search over free-form page text.
    """
    facts: list[str] = []
    seen: set[str] = set()
    for payload in json_ld_payloads:
        try:
            parsed = json.loads(payload)
        except (json.JSONDecodeError, ValueError):
            continue
        for entity in _iter_entities(parsed):
            for fact in _facts_from_object(entity):
                if fact not in seen:
                    seen.add(fact)
                    facts.append(fact)
                if len(facts) >= MAX_FACTS:
                    break
            if len(facts) >= MAX_FACTS:
                break
        if len(facts) >= MAX_FACTS:
            break
    if not facts:
        return None
    text = normalize("\n".join(facts))
    if not text:
        return None
    return Section(heading_path=("Structured business data",), text=text)
