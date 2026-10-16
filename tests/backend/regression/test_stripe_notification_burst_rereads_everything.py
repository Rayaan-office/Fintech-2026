"""Every Stripe notification started a full re-read of the Stripe account.

Seeding the demo sends well over a hundred notifications in a minute, which meant over a
hundred overlapping full syncs. Now a burst leads to at most one more read after the current one.
"""

import threading
import time

from app.connectors.common import run_once_at_a_time


def test_a_burst_of_notifications_leads_to_at_most_two_reads():
    runs = []
    started = threading.Event()

    def read():
        runs.append(1)
        started.set()
        time.sleep(0.2)

    first = threading.Thread(target=run_once_at_a_time, args=("stripe:x", read))
    first.start()
    started.wait(2)
    others = [threading.Thread(target=run_once_at_a_time, args=("stripe:x", read)) for _ in range(20)]
    for t in others:
        t.start()
    for t in [first, *others]:
        t.join(5)
    assert len(runs) == 2


def test_a_failed_read_does_not_block_the_next_one():
    def boom():
        raise RuntimeError("down")

    try:
        run_once_at_a_time("stripe:y", boom)
    except RuntimeError:
        pass
    runs = []
    run_once_at_a_time("stripe:y", lambda: runs.append(1))
    assert runs == [1]
