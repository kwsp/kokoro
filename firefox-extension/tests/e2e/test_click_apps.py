"""Use click mode directly in focusable chat layouts and editable documents."""

from harness import Reader, activate_reader, tone
from selenium.webdriver import ActionChains
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from test_web_apps import drag_select


def hover(driver, identifier):
    element = driver.find_element(By.ID, identifier)
    ActionChains(driver).move_to_element(element).perform()
    return element


def test_click_focusable_chat_response_without_play(configured, server):
    driver = configured
    driver.get(f"http://reader.test:{server.port}/web-app")
    driver.execute_script("document.querySelector('[role=main]').tabIndex = 0")
    activate_reader(driver)
    reader = Reader(driver)
    reader.click("click-mode")
    target = hover(driver, "response")
    reader.wait.until(
        lambda _: reader.highlight("kokoro-hover") == "Read this conversation response."
    )
    assert server.requests == []
    target.click()
    reader.wait_state("playing")
    assert reader.highlight() == "Read this conversation response."
    reader.wait_state("finished")
    assert [request["input"] for request in server.requests] == [
        "Read this conversation response.",
        "Read the next conversation reply.",
    ]


def test_click_mode_adopts_pending_editor_selection(configured, server):
    driver = configured
    driver.get(f"http://reader.test:{server.port}/web-app")
    activate_reader(driver)
    reader = Reader(driver)
    selected = drag_select(driver, "document-text")
    reader.click("click-mode")
    target = hover(driver, "document-text")
    reader.wait.until(lambda _: reader.highlight("kokoro-hover") == selected)
    assert server.requests == []
    target.click()
    reader.wait_state("playing")
    assert reader.highlight() == selected
    reader.wait_state("finished")
    assert [request["input"] for request in server.requests] == [selected]


def test_click_editor_document_without_selection_and_restore_editing(
    configured, server, tmp_path
):
    driver = configured
    driver.get(f"http://reader.test:{server.port}/editable-document")
    original = driver.find_element(By.CSS_SELECTOR, '[role="document"]').get_attribute(
        "innerHTML"
    )
    activate_reader(driver)
    reader = Reader(driver)
    reader.click("click-mode")
    target = hover(driver, "second-line")
    reader.wait.until(
        lambda _: reader.highlight("kokoro-hover") == "Second editable paragraph."
    )
    assert server.requests == []
    driver.save_screenshot(str(tmp_path / "editor-hover.png"))
    target.click()
    reader.wait_state("playing")
    assert reader.highlight() == "Second editable paragraph."
    reader.wait.until(lambda _: reader.highlight() == "Continue through the document.")
    reader.wait_state("finished")
    assert [request["input"] for request in server.requests][:2] == [
        "Second editable paragraph.",
        "Continue through the document.",
    ]
    assert (
        driver.find_element(By.CSS_SELECTOR, '[role="document"]').get_attribute(
            "innerHTML"
        )
        == original
    )
    ActionChains(driver).send_keys(Keys.ESCAPE).perform()
    assert (
        reader.host.shadow_root.find_element(By.ID, "click-mode").get_attribute(
            "aria-pressed"
        )
        == "false"
    )
    count = len(server.requests)
    editor = driver.find_element(By.ID, "editor-first")
    editor.click()
    editor.send_keys(Keys.END, " Normal editing.")
    assert "Normal editing." in editor.text
    assert len(server.requests) == count


def test_editor_preview_is_passive_and_updates_after_mutation(configured, server):
    driver = configured
    driver.get(f"http://reader.test:{server.port}/web-app")
    server.queue(body=tone(5))
    activate_reader(driver)
    reader = Reader(driver)
    reader.click("play")
    reader.wait_state("playing")
    reader.click("click-mode")
    hover(driver, "document-text")
    reader.wait.until(
        lambda _: reader.highlight("kokoro-hover")
        == "Read this editable document passage."
    )
    assert reader.highlight() == "Read this conversation response."
    assert all(
        request["input"] != "Read this editable document passage."
        for request in server.requests
    )
    driver.execute_script(
        "document.getElementById('document-text').firstChild.data = 'Updated editable paragraph.'"
    )
    reader.wait.until(lambda _: reader.highlight("kokoro-hover") == "")
    target = hover(driver, "document-text")
    reader.wait.until(
        lambda _: reader.highlight("kokoro-hover") == "Updated editable paragraph."
    )
    target.click()
    reader.wait.until(lambda _: reader.highlight() == "Updated editable paragraph.")
    assert server.requests[-1]["input"] == "Updated editable paragraph."
    driver.execute_script(
        "document.getElementById('document-text').firstChild.data = 'Changed during playback.'"
    )
    reader.wait_state("error")
    assert reader.highlight() == ""
    target = hover(driver, "document-text")
    reader.wait.until(
        lambda _: reader.highlight("kokoro-hover") == "Changed during playback."
    )
    target.click()
    reader.wait.until(lambda _: reader.highlight() == "Changed during playback.")
    reader.click("stop")


def test_editor_mode_preserves_links_buttons_inputs_and_selection_drags(
    configured, server
):
    driver = configured
    driver.get(f"http://reader.test:{server.port}/editable-document")
    activate_reader(driver)
    reader = Reader(driver)
    reader.click("click-mode")
    assert (
        "Esc to exit"
        in reader.host.shadow_root.find_element(By.CSS_SELECTOR, "[role=status]").text
    )
    hover(driver, "second-line")
    reader.wait.until(
        lambda _: reader.highlight("kokoro-hover") == "Second editable paragraph."
    )
    driver.find_element(By.ID, "editor-button").click()
    assert (
        driver.find_element(By.ID, "editor-button").get_attribute("data-clicks") == "1"
    )
    field = driver.find_element(By.ID, "ordinary-input")
    field.click()
    field.send_keys("Ordinary input works")
    assert field.get_attribute("value") == "Ordinary input works"
    drag_select(driver, "first-line")
    assert server.requests == []
    # Firefox normally treats an editor's link click as editing. Verify that
    # the page receives its ordinary click rather than forcing navigation.
    driver.execute_script(
        "document.getElementById('editor-link').addEventListener('click', event => { event.currentTarget.dataset.clicked = 'yes'; event.currentTarget.dataset.prevented = String(event.defaultPrevented); })"
    )
    driver.find_element(By.ID, "editor-link").click()
    assert (
        driver.find_element(By.ID, "editor-link").get_attribute("data-clicked") == "yes"
    )
    assert (
        driver.find_element(By.ID, "editor-link").get_attribute("data-prevented")
        == "false"
    )
    assert server.requests == []


def test_click_mode_explains_out_of_scope_click(configured, server):
    driver = configured
    driver.get(f"http://reader.test:{server.port}/web-app")
    activate_reader(driver)
    reader = Reader(driver)
    drag_select(driver, "response")
    reader.click("click-mode")
    driver.find_element(By.ID, "sidebar-note").click()
    assert (
        "No readable sentence here"
        in reader.host.shadow_root.find_element(By.CSS_SELECTOR, "[role=status]").text
    )
    assert server.requests == []
    target = hover(driver, "response")
    reader.wait.until(
        lambda _: reader.highlight("kokoro-hover") == "Read this conversation response."
    )
    target.click()
    reader.wait_state("playing")
    reader.wait_state("finished")
    assert [request["input"] for request in server.requests] == [
        "Read this conversation response."
    ]
