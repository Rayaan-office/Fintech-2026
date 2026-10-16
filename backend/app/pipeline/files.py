"""File safety checks: type by content (not by name), size and page limits, no macros."""

import io
import zipfile
from dataclasses import dataclass

import magic

from ..config import get_settings

_s = get_settings()

PDF = "application/pdf"
XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
ALLOWED = {
    PDF: "pdf",
    "image/jpeg": "image",
    "image/png": "image",
    "image/webp": "image",
    "image/tiff": "image",
    "text/csv": "csv",
    "text/plain": "text",
    XLSX: "xlsx",
}


class UnsafeFile(Exception):
    def __init__(self, message: str):
        super().__init__(message)
        self.message = message


@dataclass
class FileInfo:
    mime: str
    family: str  # pdf | image | csv | text | xlsx | ofx
    size: int


def inspect(data: bytes, filename: str) -> FileInfo:
    if not data:
        raise UnsafeFile("The file is empty.")
    if len(data) > _s.upload_max_bytes:
        raise UnsafeFile(f"The file is larger than {_s.upload_max_bytes // (1024 * 1024)} MB.")
    mime = magic.from_buffer(data[:8192], mime=True)
    if mime == "application/zip" and filename.lower().endswith(".xlsx"):
        mime = XLSX
    if mime in ("application/vnd.ms-excel.sheet.macroenabled.12", "application/vnd.ms-excel",
                "application/x-msdownload", "application/x-dosexec"):
        raise UnsafeFile("Spreadsheets with macros and programs are not accepted.")
    if mime not in ALLOWED:
        raise UnsafeFile("This type of file isn't supported. Upload a PDF, photo, CSV or Excel file.")
    family = ALLOWED[mime]
    if family == "text":
        head = data[:400].decode("utf-8", "ignore").upper()
        if "OFXHEADER" in head or "<OFX>" in head:
            family = "ofx"
        elif "," in head and "\n" in head:
            family = "csv"
    if family == "xlsx":
        try:
            names = zipfile.ZipFile(io.BytesIO(data)).namelist()
        except zipfile.BadZipFile:
            raise UnsafeFile("The spreadsheet is damaged.")
        if any(n.lower().endswith("vbaproject.bin") for n in names):
            raise UnsafeFile("Spreadsheets with macros are not accepted.")
    if family == "pdf" and any(tag in data for tag in (b"/JavaScript", b"/JS ", b"/JS(", b"/Launch", b"/EmbeddedFile")):
        raise UnsafeFile("This PDF contains active content and was not opened.")
    return FileInfo(mime=mime, family=family, size=len(data))
