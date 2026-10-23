"""Cloudflare Workers entrypoint for 语音工坊.

This file bridges Cloudflare's Python Workers runtime and the existing FastAPI
app in ../server. It does exactly two things:

1. Mount the FastAPI app through Cloudflare's asgi shim (the same pattern as the
   official python-workers-examples/fastapi template).
2. Inject the R2 bucket binding into server.storage so voice-clone enrollment
   audio can be uploaded and served from a public bucket.

It does NOT reimplement the /ws/* endpoints; those still need the WebSocket
rewrite described in docs/部署到 Cloudflare.md before the realtime / asr / tts
tabs can work on Workers.
"""

from workers import WorkerEntrypoint

from server.main import app
import server.storage as storage


class Default(WorkerEntrypoint):
    async def fetch(self, request):
        # Make the R2 bucket binding available to storage.put() for the duration
        # of this request. The binding name must match wrangler.toml's
        # r2_buckets[].binding.
        try:
            storage.set_r2_bucket(self.env.SPEECH_MEDIA)
        except AttributeError:
            # No binding configured (local dev / template mismatch): storage._put_r2
            # reports a precise message on use, so staying quiet here is fine.
            storage.set_r2_bucket(None)

        import asgi

        return await asgi.fetch(app, request.js_object, self.env)
