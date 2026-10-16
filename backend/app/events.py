"""Live updates to the browser (server-sent events).

Background work runs in threads; each browser tab subscribes with an asyncio queue.
Events carry IDs, stages and amounts only, never document text.
"""

import asyncio
import json
import threading
from collections import defaultdict
from uuid import UUID

_lock = threading.Lock()
_subs: dict[str, set[tuple[asyncio.AbstractEventLoop, asyncio.Queue]]] = defaultdict(set)


def subscribe(business_id: UUID | str) -> asyncio.Queue:
    q: asyncio.Queue = asyncio.Queue(maxsize=200)
    with _lock:
        _subs[str(business_id)].add((asyncio.get_running_loop(), q))
    return q


def unsubscribe(business_id: UUID | str, q: asyncio.Queue) -> None:
    with _lock:
        _subs[str(business_id)] = {(lp, qq) for lp, qq in _subs[str(business_id)] if qq is not q}


def _offer(q: asyncio.Queue, item: str) -> None:
    if not q.full():
        q.put_nowait(item)


def publish(business_id: UUID | str, event: str, data: dict) -> None:
    item = json.dumps({"event": event, **data}, default=str)
    with _lock:
        targets = list(_subs.get(str(business_id), ()))
    for loop, q in targets:
        try:
            loop.call_soon_threadsafe(_offer, q, item)
        except RuntimeError:  # loop closed
            pass
