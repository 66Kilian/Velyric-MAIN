from __future__ import annotations

import io
import json

import docx
import pytest

from velyric_document_worker.parsers import ParseError, discover_links, parse_document


def build_pdf(pages: list[str]) -> bytes:
    objects: list[bytes] = []
    page_ids = [3 + index * 2 for index in range(len(pages))]
    font_id = 3 + len(pages) * 2
    objects.append(b"<< /Type /Catalog /Pages 2 0 R >>")
    kids = " ".join(f"{page_id} 0 R" for page_id in page_ids)
    objects.append(f"<< /Type /Pages /Kids [{kids}] /Count {len(pages)} >>".encode())
    for index, text in enumerate(pages):
        content_id = page_ids[index] + 1
        objects.append(
            f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents {content_id} 0 R "
            f"/Resources << /Font << /F1 {font_id} 0 R >> >> >>".encode()
        )
        escaped = text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
        stream = f"BT /F1 12 Tf 72 720 Td ({escaped}) Tj ET".encode("latin-1")
        objects.append(
            b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream"
        )
    objects.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
    output = io.BytesIO()
    output.write(b"%PDF-1.4\n")
    offsets = []
    for number, body in enumerate(objects, start=1):
        offsets.append(output.tell())
        output.write(f"{number} 0 obj\n".encode() + body + b"\nendobj\n")
    xref = output.tell()
    output.write(f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode())
    for offset in offsets:
        output.write(f"{offset:010d} 00000 n \n".encode())
    output.write(
        f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    )
    return output.getvalue()


def test_pdf_pages_become_sections_with_page_numbers() -> None:
    body = build_pdf(["Opening hours are Monday to Friday.", "Parking in the yard is free."])
    parsed = parse_document("FILE_PDF", body, "application/pdf", ocr_enabled=False)
    assert parsed.parser == "pdfplumber"
    assert [(section.page, section.text) for section in parsed.sections] == [
        (1, "Opening hours are Monday to Friday."),
        (2, "Parking in the yard is free."),
    ]


def test_declared_pdf_that_is_not_a_pdf_is_rejected() -> None:
    with pytest.raises(ParseError) as raised:
        parse_document("FILE_PDF", b"just text pretending", "application/pdf", ocr_enabled=False)
    assert raised.value.code == "content_type_mismatch"


def test_docx_headings_and_tables_are_preserved() -> None:
    document = docx.Document()
    document.add_heading("Árak", level=1)
    document.add_paragraph("Első konzultáció díja 25 000 Ft.")
    document.add_heading("Kontroll", level=2)
    document.add_paragraph("Kontroll vizsgálat 15 000 Ft.")
    table = document.add_table(rows=1, cols=2)
    table.rows[0].cells[0].text = "Ultrahang"
    table.rows[0].cells[1].text = "18 000 Ft"
    buffer = io.BytesIO()
    document.save(buffer)
    parsed = parse_document(
        "FILE_DOCX",
        buffer.getvalue(),
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ocr_enabled=False,
    )
    assert [(section.heading_path, section.text) for section in parsed.sections] == [
        (("Árak",), "Első konzultáció díja 25 000 Ft."),
        (("Árak", "Kontroll"), "Kontroll vizsgálat 15 000 Ft.\n\nUltrahang | 18 000 Ft"),
    ]


def test_html_drops_scripts_and_navigation_and_tracks_headings() -> None:
    html = b"""<html><head><title>Rendelo</title><script>alert('x')</script></head>
    <body><nav>Menu Home About</nav><h1>Szolgaltatasok</h1><p>Fogorvosi kezeles.</p>
    <h2>Arak</h2><ul><li>Tomes: 20 000 Ft</li><li>Huzas: 15 000 Ft</li></ul><footer>Copyright</footer></body></html>"""
    parsed = parse_document("URL", html, "text/html", ocr_enabled=False)
    assert [(section.heading_path, section.text) for section in parsed.sections] == [
        (("Szolgaltatasok",), "Fogorvosi kezeles."),
        (("Szolgaltatasok", "Arak"), "Tomes: 20 000 Ft\nHuzas: 15 000 Ft"),
    ]
    assert "alert" not in "".join(section.text for section in parsed.sections)


def test_html_drops_header_chrome_and_modal_popups() -> None:
    html = b"""<html><body>
    <header id="site-header"><div class="menu">Etterem Bemutatkozas Kapcsolat hu de en</div></header>
    <div class="modal fade" id="welcome">
      <div class="modal-dialog"><div class="modal-content">
        <div class="modal-body"><p>Kedves Vendegeink! Nyitvatartas mindennap.</p></div>
      </div></div>
    </div>
    <h1>Kapcsolat</h1><p>Cim: 9400 Sopron, Fo utca 1.</p>
    </body></html>"""
    parsed = parse_document("URL", html, "text/html", ocr_enabled=False)
    text = " ".join(section.text for section in parsed.sections)
    assert "Kapcsolat" in [section.heading_path[-1] for section in parsed.sections]
    assert "Cim: 9400 Sopron, Fo utca 1." in text
    assert "Bemutatkozas" not in text
    assert "Kedves Vendegeink" not in text


def test_markdown_csv_and_faq_documents() -> None:
    markdown = parse_document(
        "FILE_MARKDOWN",
        "# Nyitvatartás\n\nHétfő 8-16\n\n## Szombat\n\nZárva".encode(),
        "text/markdown",
        ocr_enabled=False,
    )
    assert [(section.heading_path, section.text) for section in markdown.sections] == [
        (("Nyitvatartás",), "Hétfő 8-16"),
        (("Nyitvatartás", "Szombat"), "Zárva"),
    ]

    csv_doc = parse_document(
        "FILE_CSV",
        "szolgáltatás;ár\nTömés;20000\nHúzás;15000\n".encode(),
        "text/csv",
        ocr_enabled=False,
    )
    assert (
        csv_doc.sections[0].text
        == "szolgáltatás: Tömés; ár: 20000\n\nszolgáltatás: Húzás; ár: 15000"
    )

    faq = json.dumps(
        {
            "format": "velyric.faq.v1",
            "language": "hu",
            "entries": [{"question": "Van parkoló?", "answer": "Igen, az udvarban."}],
        }
    ).encode()
    parsed = parse_document("FAQ", faq, "application/json", ocr_enabled=False)
    assert [(section.heading_path, section.text) for section in parsed.sections] == [
        (("Van parkoló?",), "Kérdés: Van parkoló?\n\nVálasz: Igen, az udvarban.")
    ]
    with pytest.raises(ParseError) as raised:
        parse_document(
            "FAQ",
            b'{"format": "velyric.faq.v1", "language": null, "entries": [], "extra": 1}',
            "application/json",
            ocr_enabled=False,
        )
    assert raised.value.code == "faq_invalid"


def test_html_extracts_links_and_json_ld_structured_data() -> None:
    html = b"""<html><head>
    <script type="application/ld+json">
    {"@context": "https://schema.org", "@type": "Restaurant", "name": "Hubertus",
     "telephone": "+36301234567",
     "address": {"streetAddress": "Fo utca 1", "addressLocality": "Budapest"},
     "openingHoursSpecification": [{"dayOfWeek": "Monday", "opens": "10:00", "closes": "22:00"}]}
    </script>
    <script>alert('ignored, not ld+json')</script>
    </head><body>
    <nav><a href="/rolunk">Rolunk</a><a href="https://other-domain.test/x">External</a></nav>
    <p>Szia</p>
    <a href="/etlap.pdf">Etlap PDF</a>
    <a href="mailto:info@hubertus.hu">Email</a>
    <a href="/kapcsolat">Kapcsolat</a>
    </body></html>"""
    parsed = parse_document("URL", html, "text/html", ocr_enabled=False)
    assert parsed.links == (
        "/rolunk",
        "https://other-domain.test/x",
        "/etlap.pdf",
        "mailto:info@hubertus.hu",
        "/kapcsolat",
    )
    assert len(parsed.json_ld) == 1
    payload = json.loads(parsed.json_ld[0])
    assert payload["name"] == "Hubertus"
    assert payload["telephone"] == "+36301234567"
    assert "alert" not in "".join(section.text for section in parsed.sections)

    links = discover_links(html)
    assert links == parsed.links


def test_binary_content_is_not_accepted_as_text() -> None:
    png = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64
    with pytest.raises(ParseError) as raised:
        parse_document("FILE_TXT", png, "text/plain", ocr_enabled=False)
    assert raised.value.code == "content_type_mismatch"
