from __future__ import annotations

import json

from velyric_document_worker.structured_facts import location_facts, structured_facts_section


def test_extracts_restaurant_facts_from_schema_org_json_ld() -> None:
    payload = json.dumps(
        {
            "@context": "https://schema.org",
            "@type": "Restaurant",
            "name": "Hubertus Étterem",
            "telephone": "+36301234567",
            "priceRange": "$$",
            "address": {
                "streetAddress": "Fő utca 1",
                "addressLocality": "Budapest",
                "postalCode": "1052",
                "addressCountry": "HU",
            },
            "openingHoursSpecification": [
                {"dayOfWeek": ["Monday", "Tuesday"], "opens": "10:00", "closes": "22:00"},
                {"dayOfWeek": "Sunday", "opens": "12:00", "closes": "18:00"},
            ],
            "hasMenu": {
                "hasMenuSection": [
                    {
                        "hasMenuItem": [
                            {
                                "name": "Gulyásleves",
                                "description": "Hagyományos marhagulyás",
                                "offers": {"price": "2400"},
                            }
                        ]
                    }
                ]
            },
        }
    )
    section = structured_facts_section([payload])
    assert section is not None
    assert section.heading_path == ("Structured business data",)
    assert "Type: Restaurant" in section.text
    assert "Name: Hubertus Étterem" in section.text
    assert "Phone: +36301234567" in section.text
    assert "Address: Fő utca 1, Budapest, 1052, HU" in section.text
    assert "Mon, Tue: 10:00-22:00" in section.text
    assert "Sun: 12:00-18:00" in section.text
    assert "Gulyásleves (2400) - Hagyományos marhagulyás" in section.text


def test_handles_graph_wrapped_and_array_payloads() -> None:
    graph_payload = json.dumps(
        {"@graph": [{"@type": "LocalBusiness", "name": "A"}, {"@type": "WebSite", "name": "B"}]}
    )
    section = structured_facts_section([graph_payload])
    assert section is not None
    assert "Name: A" in section.text
    assert "Name: B" in section.text


def test_returns_none_for_empty_or_unparseable_payloads() -> None:
    assert structured_facts_section([]) is None
    assert structured_facts_section(["not json"]) is None
    assert structured_facts_section([json.dumps({"@type": "Thing"})]) is not None
    assert structured_facts_section([json.dumps("just a string")]) is None


def test_deduplicates_repeated_facts_across_payloads() -> None:
    payload = json.dumps({"@type": "Restaurant", "name": "Same"})
    section = structured_facts_section([payload, payload])
    assert section is not None
    assert section.text.count("Name: Same") == 1


def test_location_facts_extracts_address_and_business_hours() -> None:
    payload = json.dumps(
        {
            "@type": "Restaurant",
            "address": {
                "streetAddress": "Fő utca 1",
                "addressLocality": "Budapest",
                "postalCode": "1052",
                "addressRegion": "Pest",
            },
            "openingHoursSpecification": [
                {"dayOfWeek": ["Monday", "Tuesday"], "opens": "10:00", "closes": "22:00"},
                {"dayOfWeek": "Sunday", "opens": "12:00:00", "closes": "18:00:00"},
            ],
        }
    )
    facts = location_facts([payload])
    assert facts == {
        "address": {
            "line1": "Fő utca 1",
            "city": "Budapest",
            "postal_code": "1052",
            "region": "Pest",
        },
        "business_hours": [
            {"iso_weekday": 1, "opens": "10:00", "closes": "22:00"},
            {"iso_weekday": 2, "opens": "10:00", "closes": "22:00"},
            {"iso_weekday": 7, "opens": "12:00", "closes": "18:00"},
        ],
    }


def test_location_facts_drops_incomplete_address_and_invalid_hours() -> None:
    incomplete_address = json.dumps(
        {"@type": "Restaurant", "address": {"streetAddress": "Fő utca 1"}}
    )
    assert location_facts([incomplete_address]) is None

    backwards_hours = json.dumps(
        {
            "@type": "Restaurant",
            "openingHoursSpecification": [
                {"dayOfWeek": "Monday", "opens": "22:00", "closes": "07:00"}
            ],
        }
    )
    assert location_facts([backwards_hours]) is None

    unparseable = "not json"
    assert location_facts([unparseable]) is None
    assert location_facts([]) is None
