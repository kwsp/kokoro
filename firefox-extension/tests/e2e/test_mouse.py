"""Drive actual page pointers through the installed extension's click mode."""

from harness import Reader, activate_reader
from selenium.webdriver import ActionChains
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys

SECOND = "Second sentence crosses several inline pieces and wraps across more than one line in this narrow article."
LAST = "Last sentence starts here."


def open_reader(driver, server):
    driver.get(f"http://reader.test:{server.port}/mouse")
    activate_reader(driver)
    return Reader(driver)


def text_point(driver, identifier, *, last=False):
    """Read actual text rectangles, including the final wrapped line."""
    return driver.execute_script(
        """const range = document.createRange();
        range.selectNodeContents(document.getElementById(arguments[0]));
        const rects = Array.from(range.getClientRects()).filter(r => r.width && r.height);
        const rect = arguments[1] ? rects.at(-1) : rects[0];
        return {x: Math.round(rect.left + Math.min(8, rect.width / 2)),
                y: Math.round(rect.top + rect.height / 2), lines: rects.length};""",
        identifier,
        last,
    )


def move(driver, point):
    actions = ActionChains(driver)
    actions.w3c_actions.pointer_action.move_to_location(point["x"], point["y"])
    actions.perform()


def click_point(driver, point):
    actions = ActionChains(driver)
    actions.w3c_actions.pointer_action.move_to_location(point["x"], point["y"])
    actions.click().perform()


def test_wrapped_hover_click_seek_and_escape(configured, server, tmp_path):
    driver = configured
    reader = open_reader(driver, server)
    reader.click("click-mode")
    assert (
        reader.host.shadow_root.find_element(By.ID, "click-mode").get_attribute(
            "aria-pressed"
        )
        == "true"
    )
    wrapped = text_point(driver, "wrapped", last=True)
    assert wrapped["lines"] > 1
    move(driver, wrapped)
    reader.wait.until(lambda _: reader.highlight("kokoro-hover") == SECOND)
    assert server.requests == []
    driver.save_screenshot(str(tmp_path / "hover-preview.png"))
    click_point(driver, wrapped)
    reader.wait_state("playing")
    assert reader.highlight() == SECOND
    assert server.requests[0]["input"] == SECOND
    reader.click("play")
    reader.wait_state("paused")
    click_point(driver, text_point(driver, "last-words"))
    reader.wait_state("playing")
    assert reader.highlight() == LAST
    assert any(request["input"] == LAST for request in server.requests)
    ActionChains(driver).send_keys(Keys.ESCAPE).perform()
    assert (
        reader.host.shadow_root.find_element(By.ID, "click-mode").get_attribute(
            "aria-pressed"
        )
        == "false"
    )
    assert reader.highlight("kokoro-hover") == ""
    assert reader.state() == "playing"
    count = len(server.requests)
    click_point(driver, text_point(driver, "first-words"))
    reader.remains("playing", 0.4)
    assert len(server.requests) == count
    assert reader.highlight() == LAST
    reader.click("stop")


def test_seek_discards_delayed_old_sentence(configured, server):
    driver = configured
    reader = open_reader(driver, server)
    gate = server.queue(delayed=True)
    reader.click("play")
    reader.wait.until(lambda _: len(server.requests) == 1)
    assert reader.state() == "preparing"
    reader.click("click-mode")
    click_point(driver, text_point(driver, "last-words"))
    reader.wait_state("playing")
    assert reader.highlight() == LAST
    assert [request["input"] for request in server.requests] == ["Mouse reading", LAST]
    gate.set()
    reader.remains("playing", 0.5)
    assert reader.highlight() == LAST
    reader.wait_state("finished")
    assert reader.highlight() == ""
    assert [request["input"] for request in server.requests] == ["Mouse reading", LAST]


def test_click_mode_preserves_page_controls_links_and_typing(configured, server):
    driver = configured
    reader = open_reader(driver, server)
    reader.click("click-mode")
    button = driver.find_element(By.ID, "page-button")
    button.click()
    assert button.get_attribute("data-clicks") == "1"
    for identifier in ("page-input", "page-textarea"):
        field = driver.find_element(By.ID, identifier)
        field.click()
        field.send_keys("typing remains normal")
        assert field.get_attribute("value") == "typing remains normal"
    editor = driver.find_element(By.ID, "page-editor")
    editor.click()
    editor.send_keys(" added")
    assert "added" in editor.text
    driver.find_element(By.ID, "page-summary").click()
    assert driver.find_element(By.ID, "page-details").get_attribute("open") is not None
    driver.find_element(By.ID, "link").click()
    assert driver.current_url.endswith("#destination")
    assert server.requests == []


def test_whitespace_modifiers_drag_and_mode_off_do_not_seek(configured, server):
    driver = configured
    reader = open_reader(driver, server)
    first = text_point(driver, "first-words")
    click_point(driver, first)
    assert server.requests == []
    reader.click("click-mode")
    blank = driver.execute_script(
        'const r=document.getElementById("last").getBoundingClientRect();return {x:Math.round(r.right-2),y:Math.round(r.top+r.height/2)}'
    )
    click_point(driver, blank)
    assert server.requests == []
    move(driver, first)
    ActionChains(driver).key_down(Keys.SHIFT).click().key_up(Keys.SHIFT).perform()
    assert server.requests == []
    driver.execute_script("getSelection().removeAllRanges()")
    end = {**first, "x": first["x"] + 100}
    drag = ActionChains(driver)
    drag.w3c_actions.pointer_action.move_to_location(first["x"], first["y"])
    drag.click_and_hold()
    drag.w3c_actions.pointer_action.move_to_location(end["x"], end["y"])
    drag.release().perform()
    assert driver.execute_script("return getSelection().toString().length") > 0
    assert server.requests == []
    # A real right click still opens Firefox's native context menu.
    ActionChains(driver).context_click(
        driver.find_element(By.ID, "first-words")
    ).perform()
    with driver.context(driver.CONTEXT_CHROME):
        assert (
            driver.execute_script(
                'return document.getElementById("contentAreaContextMenu").state'
            )
            == "open"
        )
        driver.execute_script(
            'document.getElementById("contentAreaContextMenu").hidePopup()'
        )
        reader.wait.until(
            lambda d: d.execute_script(
                'return document.getElementById("contentAreaContextMenu").state === "closed"'
            )
        )
    assert server.requests == []
    reader.click("close")
    click_point(driver, first)
    assert driver.find_elements(By.ID, "kokoro-reader-controls") == []
    assert server.requests == []
