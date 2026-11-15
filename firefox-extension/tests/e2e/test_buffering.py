"""Exercise short-sentence transitions with the real installed Firefox extension."""

import json
import threading

from harness import Reader, activate_reader, observe_playback, preparation_gaps, tone


def test_read_ahead_hides_generation_after_a_short_sentence(
    configured, server, tmp_path
):
    """A slow third response should use time available during the first sentence."""
    driver = configured
    server.queue(body=tone(4))
    server.queue(body=tone(0.3))
    gate = server.queue(body=tone(2), delayed=True)
    driver.get(f"http://reader.test:{server.port}/article")
    activate_reader(driver)
    reader = Reader(driver)
    observe_playback(driver)
    reader.click("play")
    reader.wait_state("playing")
    reader.wait.until(lambda _: len(server.requests) == 3)
    # Simulate a model request that takes longer than the short second sentence.
    timer = threading.Timer(1.2, gate.set)
    timer.start()
    try:
        reader.wait.until(lambda _: reader.highlight() == "Another paragraph.")
    finally:
        gate.set()
        timer.join(timeout=2)
    transitions = driver.execute_script("return window.readerTransitions")
    (tmp_path / "transitions.json").write_text(json.dumps(transitions, indent=2))
    reader.click("stop")
    gaps = preparation_gaps(transitions)
    assert max(gaps, default=0) < 250, f"Sentence preparation gaps (ms): {gaps}"
    starts = [item for item in transitions if item["state"] == "playing"]
    assert [item["sentence"] for item in starts] == ["1", "2", "3"]
    # Check playback cadence too, so merely hiding Preparing cannot pass this test.
    excess = [
        starts[index + 1]["time"] - starts[index]["time"] - duration
        for index, duration in enumerate([4000, 300])
    ]
    assert max(excess) < 250, f"Transitions beyond clip durations (ms): {excess}"
    print(f"Short-sentence transitions beyond clip durations (ms): {excess}")
    assert [request["input"] for request in server.requests] == [
        "Fixture article",
        "Kokoro reads this first paragraph.",
        "Another paragraph.",
    ]


def test_bad_prefetched_wav_retries_when_its_sentence_is_needed(configured, server):
    driver = configured
    server.queue(body=tone(3))
    server.queue(body=b"invalid prefetched WAV")
    server.queue(body=tone(2))
    server.queue(body=tone(2))
    driver.get(f"http://reader.test:{server.port}/article")
    activate_reader(driver)
    reader = Reader(driver)
    reader.click("play")
    reader.wait_state("playing")
    reader.wait.until(lambda _: len(server.requests) == 2)
    reader.remains("playing", 0.3)
    assert reader.highlight() == "Fixture article"
    reader.wait.until(
        lambda _: reader.highlight() == "Kokoro reads this first paragraph."
    )
    reader.wait.until(lambda _: len(server.requests) == 4)
    assert [request["input"] for request in server.requests] == [
        "Fixture article",
        "Kokoro reads this first paragraph.",
        "Kokoro reads this first paragraph.",
        "Another paragraph.",
    ]
    reader.click("stop")
    reader.remains("ready", 2.2)
    assert reader.highlight() == ""
