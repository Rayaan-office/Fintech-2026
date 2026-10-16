"""Read the words from a document on our own server. No AI is involved.

PDFs with a text layer are read directly; scans and photos go through Tesseract OCR.
Every word keeps its page and position, so the review screen can highlight where each
extracted value was found. Reading runs in a separate worker process with a time limit.
"""

import csv
import io
from concurrent.futures import ProcessPoolExecutor
from concurrent.futures import TimeoutError as FutureTimeout
from dataclasses import dataclass, field

from ..config import get_settings

_s = get_settings()
READ_TIMEOUT_SECONDS = 90
_pool: ProcessPoolExecutor | None = None


@dataclass
class Word:
    text: str
    page: int
    # position as fractions of the page (0..1), so the browser can scale it
    x0: float
    y0: float
    x1: float
    y1: float


@dataclass
class ReadResult:
    text: str
    pages: int
    method: str  # text_layer | ocr | table
    words: list[Word] = field(default_factory=list)
    rows: list[list[str]] | None = None  # for CSV / spreadsheets


class TooManyPages(Exception):
    pass


def _read_pdf(data: bytes, max_pages: int) -> ReadResult:
    import fitz

    doc = fitz.open(stream=data, filetype="pdf")
    if doc.page_count > max_pages:
        raise TooManyPages(doc.page_count)
    words: list[Word] = []
    lines: list[str] = []
    for pno, page in enumerate(doc):
        w, h = page.rect.width, page.rect.height
        page_words = page.get_text("words")  # x0, y0, x1, y1, word, block, line, word_no
        for x0, y0, x1, y1, t, *_ in page_words:
            words.append(Word(t, pno, x0 / w, y0 / h, x1 / w, y1 / h))
        lines.append(page.get_text("text"))
    text = "\n".join(lines).strip()
    if len(text) >= 40:
        return ReadResult(text=text, pages=doc.page_count, method="text_layer", words=words)
    # Scanned PDF: render each page and OCR it
    images = [page.get_pixmap(dpi=250).tobytes("png") for page in doc]
    return _ocr_images(images, doc.page_count)


def _ocr_images(images: list[bytes], pages: int) -> ReadResult:
    import pytesseract
    from PIL import Image, ImageOps

    words: list[Word] = []
    texts: list[str] = []
    for pno, raw in enumerate(images):
        img = ImageOps.exif_transpose(Image.open(io.BytesIO(raw))).convert("L")
        if max(img.size) < 1600:  # small photos read better enlarged
            scale = 1600 / max(img.size)
            img = img.resize((int(img.width * scale), int(img.height * scale)))
        data = pytesseract.image_to_data(img, lang="eng", config="--psm 6", output_type=pytesseract.Output.DICT)
        line_key, line, out_lines = None, [], []
        for i, t in enumerate(data["text"]):
            if not t.strip() or float(data["conf"][i]) < 30:
                continue
            x, y, w, h = data["left"][i], data["top"][i], data["width"][i], data["height"][i]
            words.append(Word(t, pno, x / img.width, y / img.height, (x + w) / img.width, (y + h) / img.height))
            key = (data["block_num"][i], data["par_num"][i], data["line_num"][i])
            if key != line_key and line:
                out_lines.append(" ".join(line))
                line = []
            line_key = key
            line.append(t)
        if line:
            out_lines.append(" ".join(line))
        texts.append("\n".join(out_lines))
    return ReadResult(text="\n".join(texts).strip(), pages=pages, method="ocr", words=words)


def _read_table(data: bytes, family: str) -> ReadResult:
    rows: list[list[str]] = []
    if family == "xlsx":
        from openpyxl import load_workbook

        wb = load_workbook(io.BytesIO(data), read_only=True, data_only=True)  # values only, formulas not run
        ws = wb.worksheets[0]
        for i, row in enumerate(ws.iter_rows(values_only=True)):
            if i >= 5000:
                break
            rows.append(["" if v is None else str(v) for v in row])
    else:
        text = data.decode("utf-8-sig", errors="replace")
        rows = [r for r in csv.reader(io.StringIO(text))][:5000]
    text = "\n".join(", ".join(r) for r in rows)
    return ReadResult(text=text, pages=1, method="table", rows=rows)


def _read(data: bytes, family: str, max_pages: int) -> ReadResult:
    if family == "pdf":
        return _read_pdf(data, max_pages)
    if family == "image":
        return _ocr_images([data], 1)
    if family in ("csv", "xlsx"):
        return _read_table(data, family)
    text = data.decode("utf-8", errors="replace")
    return ReadResult(text=text, pages=1, method="text_layer")


def read_document(data: bytes, family: str) -> ReadResult:
    """Read in a separate process; give up after the time limit."""
    global _pool
    if _pool is None:
        _pool = ProcessPoolExecutor(max_workers=2)
    future = _pool.submit(_read, data, family, _s.upload_max_pages)
    try:
        return future.result(timeout=READ_TIMEOUT_SECONDS)
    except FutureTimeout:
        _pool.shutdown(wait=False, cancel_futures=True)
        _pool = None
        raise TimeoutError("reading the document took too long")
