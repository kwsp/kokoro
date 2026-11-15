"""Read user selections made after opening the bar on document/chat layouts."""

import pytest
from harness import Reader, activate_reader, tone
from selenium.webdriver import ActionChains
from selenium.webdriver.common.by import By


def drag_select(driver, identifier):
    """Select real rendered text with the mouse, before focusing the reader."""
    bounds = driver.execute_script(
        """const element = document.getElementById(arguments[0]);
        const range = document.createRange(); range.selectNodeContents(element);
        const rect = range.getBoundingClientRect();
        return {left: Math.floor(rect.left), right: Math.ceil(rect.right),
                y: Math.round(rect.top + rect.height / 2), text: element.textContent};""",
        identifier,
    )
    actions = ActionChains(driver)
    actions.w3c_actions.pointer_action.move_to_location(bounds["left"], bounds["y"])
    actions.click_and_hold()
    actions.w3c_actions.pointer_action.move_to_location(bounds["right"], bounds["y"])
    actions.release().perform()
    assert driver.execute_script("return getSelection().toString()") == bounds["text"]
    return bounds["text"]


@pytest.mark.parametrize("identifier", ["response", "document-text"])
def test_select_after_opening_bar_then_press_play(
    configured, server, tmp_path, identifier
):
    driver = configured
    driver.get(f"http://reader.test:{server.port}/web-app")
    activate_reader(driver)
    reader = Reader(driver)
    text = drag_select(driver, identifier)
    reader.wait.until(
        lambda _: reader.host.shadow_root.find_element(By.ID, "play").text
        == "Read selection"
    )
    assert (
        "Selected text is ready"
        in reader.host.shadow_root.find_element(By.CSS_SELECTOR, "[role=status]").text
    )
    assert server.requests == []
    driver.save_screenshot(str(tmp_path / "selection-ready.png"))
    reader.click("play")
    reader.wait_state("playing")
    assert reader.highlight() == text
    driver.save_screenshot(str(tmp_path / "selection-speaking.png"))
    reader.wait_state("finished")
    assert [request["input"] for request in server.requests] == [text]


def test_selection_recovers_from_extraction_error_without_reactivation(
    configured, server
):
    driver = configured
    driver.get(f"http://reader.test:{server.port}/ambiguous")
    activate_reader(driver)
    reader = Reader(driver)
    reader.wait_state("error")
    text = drag_select(driver, "chosen")
    reader.wait.until(
        lambda _: reader.host.shadow_root.find_element(By.ID, "play").text
        == "Read selection"
    )
    assert (
        "Select a passage"
        not in reader.host.shadow_root.find_element(
            By.CSS_SELECTOR, "[role=status]"
        ).text
    )
    reader.click("play")
    reader.wait_state("playing")
    assert reader.highlight() == text
    reader.wait_state("finished")
    assert [request["input"] for request in server.requests] == [text]


def test_selection_during_playback_waits_for_explicit_read(configured, server):
    driver = configured
    driver.get(f"http://reader.test:{server.port}/web-app")
    server.queue(body=tone(5))
    activate_reader(driver)
    reader = Reader(driver)
    reader.click("play")
    reader.wait_state("playing")
    text = drag_select(driver, "document-text")
    assert reader.highlight() == "Read this conversation response."
    assert all(request["input"] != text for request in server.requests)
    reader.click("play")
    reader.wait.until(lambda _: reader.highlight() == text)
    reader.wait_state("finished")
    assert server.requests[-1]["input"] == text


def test_editor_selection_before_toolbar_activation(configured, server):
    driver = configured
    driver.get(f"http://reader.test:{server.port}/web-app")
    text = drag_select(driver, "document-text")
    activate_reader(driver)
    reader = Reader(driver)
    reader.click("play")
    reader.wait_state("playing")
    assert reader.highlight() == text
    reader.wait_state("finished")
    assert [request["input"] for request in server.requests] == [text]


def test_click_mode_can_target_explicitly_selected_sidebar(configured, server):
    driver = configured
    driver.get(f"http://reader.test:{server.port}/web-app")
    activate_reader(driver)
    reader = Reader(driver)
    text = drag_select(driver, "sidebar-note")
    reader.click("play")
    reader.wait_state("playing")
    reader.click("play")
    reader.wait_state("paused")
    reader.click("click-mode")
    target = driver.find_element(By.ID, "sidebar-note")
    ActionChains(driver).move_to_element(target).perform()
    reader.wait.until(lambda _: reader.highlight("kokoro-hover") == text)
    target.click()
    reader.wait_state("playing")
    assert reader.highlight() == text
    reader.click("stop")


def test_editor_clears_native_selection_on_blur(configured, server):
    driver = configured
    driver.get(f"http://reader.test:{server.port}/web-app")
    activate_reader(driver)
    reader = Reader(driver)
    driver.execute_script(
        "document.getElementById('editor').addEventListener('blur', () => getSelection().removeAllRanges())"
    )
    text = drag_select(driver, "document-text")
    reader.click("play")
    reader.wait_state("playing")
    assert driver.execute_script("return getSelection().toString()") == ""
    assert reader.highlight() == text
    reader.click("play")
    reader.wait_state("paused")
    reader.click("play")
    reader.wait_state("playing")
    assert reader.highlight() == text
    assert [request["input"] for request in server.requests] == [text]
    driver.execute_script(
        "document.getElementById('document-text').firstChild.data = 'Edited while reading.'"
    )
    reader.wait_state("error")
    assert (
        "Page changed"
        in reader.host.shadow_root.find_element(By.CSS_SELECTOR, "[role=status]").text
    )
    assert reader.highlight() == ""


def test_new_selection_replaces_existing_scope_on_play(configured, server):
    driver = configured
    driver.get(f"http://reader.test:{server.port}/mouse")
    activate_reader(driver)
    reader = Reader(driver)
    text = drag_select(driver, "last-words")
    reader.click("play")
    reader.wait_state("playing")
    assert reader.highlight() == text
    reader.wait_state("finished")
    assert [request["input"] for request in server.requests] == [text]


def test_conversation_landmark_reads_turns_without_composer(configured, server):
    driver = configured
    driver.get(f"http://reader.test:{server.port}/web-app")
    activate_reader(driver)
    reader = Reader(driver)
    reader.click("play")
    reader.wait_state("playing")
    assert reader.highlight() == "Read this conversation response."
    reader.wait_state("finished")
    assert [request["input"] for request in server.requests] == [
        "Read this conversation response.",
        "Read the next conversation reply.",
    ]
