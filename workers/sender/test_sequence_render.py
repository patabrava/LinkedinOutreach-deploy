import pytest

from sequence_render import render


LEAD = {
    "first_name": "Sven",
    "last_name": "Müller",
    "company_name": "Acme GmbH",
}


def test_double_curly():
    assert render("Hi {{first_name}}", LEAD) == "Hi Sven"


def test_single_curly():
    assert render("Hi {first_name}", LEAD) == "Hi Sven"


def test_bracket():
    assert render("Hi [first_name]", LEAD) == "Hi Sven"


def test_full_name_derived():
    assert render("{{full_name}}", LEAD) == "Sven Müller"


def test_missing_field_renders_empty():
    assert render("Hi {{first_name}}", {"last_name": "X"}) == "Hi "


def test_unknown_token_left_untouched():
    assert render("Hi {{recent_post}}", LEAD) == "Hi {{recent_post}}"


def test_legacy_aliases_VORNAME_NACHNAME():
    assert render("Hallo {{VORNAME}} {{NACHNAME}}", LEAD) == "Hallo Sven Müller"


def test_company_name():
    assert render("at {{company_name}}", LEAD) == "at Acme GmbH"
