"""Read actual article DOM while refusing uncertain page scopes."""

import pytest
from harness import Reader, activate_reader, activate_selection_menu, select_contents
from selenium.webdriver.common.by import By


def test_readability_maps_original_visible_paragraphs(configured, server, tmp_path):
    driver = configured
    driver.get(f"http://reader.test:{server.port}/readability")
    original = driver.execute_script("return document.body.innerHTML")
    expected = driver.execute_script(
        'return Array.from(document.querySelectorAll(".article-body p:not(.hidden-story)"), p => p.textContent)'
    )
    activate_reader(driver)
    reader = Reader(driver)
    reader.click("play")
    for index, text in enumerate(expected):
        reader.wait.until(lambda _, text=text: reader.highlight() == text)
        assert server.requests[index]["input"] == text
        assert driver.execute_script("return document.body.innerHTML") == original
        if index == 0:
            driver.save_screenshot(str(tmp_path / "readability-speaking.png"))
    reader.wait_state("finished")
    assert driver.execute_script("return typeof window.Readability") == "undefined"
    assert [request["input"] for request in server.requests] == expected
    assert reader.highlight() == ""


def test_ambiguous_articles_offer_selection_reading(configured, server):
    driver = configured
    driver.get(f"http://reader.test:{server.port}/ambiguous")
    activate_reader(driver)
    reader = Reader(driver)
    reader.wait_state("error")
    assert (
        "Select a passage"
        in reader.host.shadow_root.find_element(By.CSS_SELECTOR, "[role=status]").text
    )
    assert server.requests == []
    select_contents(driver, "chosen")
    activate_selection_menu(driver, driver.find_element(By.ID, "chosen"))
    reader.click("play")
    reader.wait_state("playing")
    assert reader.highlight() == "First story."
    assert [request["input"] for request in server.requests] == ["First story."]
    reader.click("stop")


def test_empty_page_does_not_send_navigation_to_server(configured, server):
    driver = configured
    driver.get(f"http://reader.test:{server.port}/empty")
    activate_reader(driver)
    reader = Reader(driver)
    reader.wait_state("error")
    reader.click("play")
    reader.remains("error", 0.3)
    assert (
        "No readable article"
        in reader.host.shadow_root.find_element(By.CSS_SELECTOR, "[role=status]").text
    )
    assert server.requests == []
    assert reader.highlight() == ""


@pytest.mark.parametrize("firefox", [{"highlight_fallback": True}], indirect=True)
def test_outline_fallback_restores_style_and_preserves_selection(
    configured, server, tmp_path
):
    driver = configured
    driver.get(f"http://reader.test:{server.port}/selection")
    driver.execute_script(
        'document.getElementById("selection").style.cssText = "outline: 1px dotted blue; outline-offset: 1px"'
    )
    original = driver.execute_script(
        'return document.getElementById("selection").style.cssText'
    )
    select_contents(driver, "selected")
    selected = driver.execute_script("return getSelection().toString()")
    activate_reader(driver)
    reader = Reader(driver)
    reader.click("play")
    reader.wait_state("playing")
    assert (
        driver.execute_script(
            'return getComputedStyle(document.getElementById("selection")).outlineStyle'
        )
        == "solid"
    )
    assert (
        "Block highlight"
        in reader.host.shadow_root.find_element(By.CSS_SELECTOR, "[role=status]").text
    )
    assert driver.execute_script("return getSelection().toString()") == selected
    driver.save_screenshot(str(tmp_path / "outline-fallback.png"))
    reader.click("play")
    reader.wait_state("paused")
    assert (
        driver.execute_script(
            'return getComputedStyle(document.getElementById("selection")).outlineStyle'
        )
        == "dashed"
    )
    reader.click("stop")
    assert (
        driver.execute_script(
            'return document.getElementById("selection").style.cssText'
        )
        == original
    )
    assert driver.execute_script("return getSelection().toString()") == selected
