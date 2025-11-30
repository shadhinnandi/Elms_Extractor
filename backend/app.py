"""FastAPI backend exposing ELMS extraction functionality for the web UI."""

from __future__ import annotations

import base64
import os
import threading
import time
from typing import Dict, List, Tuple
from uuid import uuid4

from fastapi import Depends, FastAPI, Header, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from elms_extractor import (
    CourseExtractionError,
    ElmsLoginError,
    extract_course_data,
    get_all_course_ids,
    get_courses_with_names,
    login,
    serialize_course_files,
)
from requests import Session

SESSION_TTL_SECONDS = 30 * 60  # 30 minutes
CLEANUP_INTERVAL_SECONDS = 60


class SessionState:
    """In-memory session cache for authenticated ELMS sessions."""

    def __init__(self) -> None:
        self._store: Dict[str, Tuple[float, Tuple[Session, str]]] = {}
        self._lock = threading.Lock()

    def create(self, session: Session, session_key: str) -> str:
        token = uuid4().hex
        expires_at = time.time() + SESSION_TTL_SECONDS
        with self._lock:
            self._store[token] = (expires_at, (session, session_key))
        return token

    def get(self, token: str) -> Tuple[Session, str]:
        with self._lock:
            entry = self._store.get(token)
            if not entry:
                raise ElmsLoginError("Invalid session token.")
            expires_at, session_data = entry
            if time.time() > expires_at:
                del self._store[token]
                raise ElmsLoginError("Session expired. Please login again.")
            return session_data

    def touch(self, token: str) -> None:
        with self._lock:
            if token in self._store:
                session = self._store[token][1]
                self._store[token] = (time.time() + SESSION_TTL_SECONDS, session)

    def remove(self, token: str) -> None:
        with self._lock:
            self._store.pop(token, None)

    def cleanup(self) -> None:
        now = time.time()
        with self._lock:
            expired = [token for token, (expires_at, _) in self._store.items() if expires_at < now]
            for token in expired:
                del self._store[token]


session_cache = SessionState()
app = FastAPI(title="ELMS Extractor API", version="1.0.0")


allowed_origins = os.getenv("ALLOWED_ORIGINS", "*")
if allowed_origins == "*":
    origins_list = ["*"]
else:
    origins_list = [origin.strip() for origin in allowed_origins.split(",") if origin.strip()]

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class LoginRequest(BaseModel):
    username: str
    password: str


class CourseSummary(BaseModel):
    id: int
    name: str


class LoginResponse(BaseModel):
    token: str
    expires_in: int
    courses: List[CourseSummary]


class ExtractResponse(BaseModel):
    course_id: str
    course_name: str
    course_code: str
    participant_count: int
    csv_filename: str
    csv_base64: str
    email_list_filename: str
    email_list_base64: str


def _background_cleanup() -> None:
    while True:
        time.sleep(CLEANUP_INTERVAL_SECONDS)
        session_cache.cleanup()


cleanup_thread = threading.Thread(target=_background_cleanup, daemon=True)
cleanup_thread.start()


def _get_session_from_header(authorization: str = Header(...)) -> Tuple[str, Session, str]:
    if not authorization.startswith("Bearer "):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing Bearer token.")
    token = authorization.split(" ", 1)[1].strip()
    try:
        session, session_key = session_cache.get(token)
    except ElmsLoginError as error:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=str(error)) from error
    session_cache.touch(token)
    return token, session, session_key


@app.get("/api/health")
def healthcheck() -> Dict[str, str]:
    return {"status": "ok"}


@app.post("/api/login", response_model=LoginResponse)
def api_login(payload: LoginRequest) -> LoginResponse:
    try:
        session, session_key = login(payload.username, payload.password)
    except ElmsLoginError as error:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=str(error)) from error

    token = session_cache.create(session, session_key)

    try:
        courses_map = get_courses_with_names(session, session_key)
    except Exception as error:  # noqa: BLE001 - broad to ensure logout
        session_cache.remove(token)
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(error)) from error

    courses = [CourseSummary(id=course_id, name=name) for name, course_id in sorted(courses_map.items())]
    return LoginResponse(token=token, expires_in=SESSION_TTL_SECONDS, courses=courses)


@app.get("/api/courses", response_model=List[CourseSummary])
def api_courses(session_data: Tuple[str, Session, str] = Depends(_get_session_from_header)) -> List[CourseSummary]:
    token, session, session_key = session_data
    try:
        courses_map = get_courses_with_names(session, session_key)
    except Exception as error:  # noqa: BLE001
        session_cache.remove(token)
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(error)) from error

    return [CourseSummary(id=course_id, name=name) for name, course_id in sorted(courses_map.items())]


@app.post("/api/courses/{course_id}/extract", response_model=ExtractResponse)
def api_extract_course(course_id: str, session_data: Tuple[str, Session, str] = Depends(_get_session_from_header)) -> ExtractResponse:
    token, session, _ = session_data
    try:
        course = extract_course_data(session, course_id)
    except CourseExtractionError as error:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(error)) from error
    except Exception as error:  # noqa: BLE001
        session_cache.remove(token)
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(error)) from error

    serialized = serialize_course_files(course)

    return ExtractResponse(
        course_id=course.course_id,
        course_name=course.course_name,
        course_code=course.course_code,
        participant_count=len(course.users),
        csv_filename=f"{course.course_code}_users.csv",
        csv_base64=serialized["csv"],
        email_list_filename=f"{course.course_code}_emails.txt",
        email_list_base64=serialized["emails"],
    )


@app.post("/api/courses/extract-all")
def api_extract_all(session_data: Tuple[str, Session, str] = Depends(_get_session_from_header)) -> Dict[str, str]:
    token, session, session_key = session_data
    try:
        course_ids = get_all_course_ids(session, session_key)
    except Exception as error:  # noqa: BLE001
        session_cache.remove(token)
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(error)) from error

    from io import BytesIO
    from zipfile import ZipFile

    zip_buffer = BytesIO()
    with ZipFile(zip_buffer, "w") as archive:
        for course_id in course_ids:
            try:
                course = extract_course_data(session, str(course_id))
            except CourseExtractionError:
                continue
            serialized = serialize_course_files(course)
            archive.writestr(f"{course.course_code}_users.csv", base64.b64decode(serialized['csv']))
            archive.writestr(f"{course.course_code}_emails.txt", base64.b64decode(serialized['emails']))

    zip_buffer.seek(0)
    return {
        "filename": "elms_courses_export.zip",
        "base64": base64.b64encode(zip_buffer.read()).decode("ascii"),
        "courseCount": len(course_ids),
    }
