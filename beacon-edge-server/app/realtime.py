"""실시간 SSE 브로커 — 새 비콘 로그 들어오면 모든 구독자에게 즉시 push"""
import asyncio
import json
from typing import Set, Dict, Any


class EventBroker:
    def __init__(self) -> None:
        self._subscribers: Set[asyncio.Queue] = set()
        self._lock = asyncio.Lock()

    async def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=100)
        async with self._lock:
            self._subscribers.add(q)
        return q

    async def unsubscribe(self, q: asyncio.Queue) -> None:
        async with self._lock:
            self._subscribers.discard(q)

    async def publish(self, event: Dict[str, Any]) -> None:
        """동시 구독자 모두에게 비동기 전달 (큐 full이면 그 구독자만 skip)"""
        data = json.dumps(event, ensure_ascii=False, default=str)
        async with self._lock:
            subs = list(self._subscribers)
        for q in subs:
            try:
                q.put_nowait(data)
            except asyncio.QueueFull:
                # 느린 구독자는 1건 버림 — 서버 영향 X
                pass

    @property
    def subscriber_count(self) -> int:
        return len(self._subscribers)


broker = EventBroker()
