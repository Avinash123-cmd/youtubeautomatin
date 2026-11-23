"""Exercise waiting/disconnect handling over a real Uvicorn TCP connection."""
import asyncio
import socket
import threading
import unittest

import httpx
import uvicorn
from fastapi import FastAPI, Request
from pydantic import BaseModel

from services.work_limits import WorkLimiter


class Payload(BaseModel):
    value: str


class TCPConcurrencyTests(unittest.IsolatedAsyncioTestCase):
    async def test_disconnected_queued_client_does_not_start_later(self):
        disconnected = asyncio.Event()

        class TrackingLimiter(WorkLimiter):
            async def _wait_for_disconnect(self, request):
                await super()._wait_for_disconnect(request)
                disconnected.set()

        limiter = TrackingLimiter(1, 'tcp-test')
        first_started = threading.Event()
        release = threading.Event()
        second_started = threading.Event()
        app = FastAPI()

        def work(value):
            if value == 'first':
                first_started.set()
                if not release.wait(10):
                    raise RuntimeError('test did not release work')
            else:
                second_started.set()
            return value

        @app.post('/work')
        async def endpoint(payload: Payload, request: Request):
            return {'value': await limiter.run(request, work, payload.value)}

        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.bind(('127.0.0.1', 0))
        sock.listen(128)
        port = sock.getsockname()[1]
        server = uvicorn.Server(uvicorn.Config(app, log_level='critical', lifespan='off'))
        server_task = asyncio.create_task(server.serve(sockets=[sock]))
        tasks = []
        try:
            async def wait_until_started():
                while not server.started:
                    if server_task.done():
                        await server_task
                        raise RuntimeError('server exited before listening')
                    await asyncio.sleep(0.01)
            await asyncio.wait_for(wait_until_started(), 5)
            async with httpx.AsyncClient(base_url=f'http://127.0.0.1:{port}', timeout=5) as client:
                first = asyncio.create_task(client.post('/work', json={'value': 'first'}))
                tasks.append(first)
                self.assertTrue(await asyncio.to_thread(first_started.wait, 3))
                second = asyncio.create_task(client.post('/work', json={'value': 'second'}))
                tasks.append(second)
                await asyncio.sleep(0.1)
                self.assertFalse(second_started.is_set())
                second.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await second
                await asyncio.wait_for(disconnected.wait(), 3)
                release.set()
                self.assertEqual((await first).json(), {'value': 'first'})
                await asyncio.sleep(0.1)
                self.assertFalse(second_started.is_set())
                self.assertEqual((await client.post('/work', json={'value': 'third'})).json(), {'value': 'third'})
        finally:
            release.set()
            if tasks:
                await asyncio.gather(*tasks, return_exceptions=True)
            server.should_exit = True
            await asyncio.wait_for(server_task, 5)
            sock.close()
            limiter.close()


if __name__ == '__main__':
    unittest.main()
