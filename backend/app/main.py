"""SME Finance Copilot API."""

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from . import handlers, scheduler  # noqa: F401  (handlers registers what approved actions do)
from .api import activity, advice, assistant, auth, connections, documents, inbox, insights, webhooks
from .api import learning as learning_api
from .config import get_settings
from .security.http import SecurityHeadersMiddleware

_s = get_settings()
log = logging.getLogger("copilot")


@asynccontextmanager
async def lifespan(_: FastAPI):
    scheduler.start()
    yield
    scheduler.stop()


app = FastAPI(
    title="SME Finance Copilot API",
    lifespan=lifespan,
    version="1",
    # The developer documentation page exists only in development
    docs_url="/api/docs" if _s.is_dev else None,
    redoc_url=None,
    openapi_url="/api/openapi.json" if _s.is_dev else None,
)
app.add_middleware(SecurityHeadersMiddleware)


@app.exception_handler(StarletteHTTPException)
async def http_error(_: Request, exc: StarletteHTTPException):
    return JSONResponse({"detail": exc.detail}, status_code=exc.status_code, headers=getattr(exc, "headers", None))


@app.exception_handler(RequestValidationError)
async def validation_error(_: Request, exc: RequestValidationError):
    fields = [".".join(str(x) for x in e.get("loc", [])[1:]) for e in exc.errors()]
    return JSONResponse({"detail": "Some details are missing or invalid.", "fields": fields}, status_code=422)


@app.exception_handler(Exception)
async def unexpected_error(_: Request, exc: Exception):
    # Never reveal internals to the browser
    log.exception("unhandled error: %s", type(exc).__name__)
    return JSONResponse({"detail": "Something went wrong on our side. Please try again."}, status_code=500)


@app.get("/api/health")
def health():
    return {"ok": True}


app.include_router(auth.router)
app.include_router(inbox.router)
app.include_router(documents.router)
app.include_router(activity.router)
app.include_router(connections.router)
app.include_router(insights.router)
app.include_router(advice.router)
app.include_router(assistant.router)
app.include_router(webhooks.router)
app.include_router(learning_api.router)
