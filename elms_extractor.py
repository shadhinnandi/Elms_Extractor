"""Core data extraction utilities for the ELMS platform."""

from __future__ import annotations

import base64
import csv
import io
import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

import requests
from bs4 import BeautifulSoup


ELMS_LOGIN_URL = "https://elms.uiu.ac.bd/login/index.php"
ELMS_COURSE_API = (
    "https://elms.uiu.ac.bd/lib/ajax/service.php?sesskey={sesskey}"
    "&info=core_course_get_enrolled_courses_by_timeline_classification"
)
ELMS_USER_LIST_URL = (
    "https://elms.uiu.ac.bd/user/index.php?page=0&perpage=5000&contextid=0&id={course_id}&newcourse"
)


class ElmsLoginError(RuntimeError):
    """Raised when authentication with ELMS fails."""


class ElmsSessionExpired(RuntimeError):
    """Raised when a stored session is no longer valid."""


class CourseExtractionError(RuntimeError):
    """Raised when course data could not be extracted."""


@dataclass
class CourseData:
    """Container for extracted course data."""

    course_id: str
    course_name: str
    course_code: str
    users: Sequence[Dict[str, str]]

    @property
    def email_list(self) -> List[str]:
        return [user["email"] for user in self.users if user.get("email")]


def extract_csrf_token(html: str) -> Optional[str]:
    soup = BeautifulSoup(html, "html.parser")
    token_input = soup.find("input", {"name": "logintoken"})
    return token_input["value"] if token_input else None


def extract_session_key(html: str) -> Optional[str]:
    soup = BeautifulSoup(html, "html.parser")
    token_input = soup.find("input", {"name": "sesskey"})
    return token_input["value"] if token_input else None


def _derive_course_code(course_name: str) -> str:
    fallback = re.sub(r"[^A-Za-z0-9]+", "_", course_name).strip("_")
    match = re.search(r"(Spring|Fall|Summer)\s\d{2,4}\s([^:]+)", course_name)
    if not match:
        return fallback or "course"
    course_code = match.group(2).strip().replace(" ", "_")
    course_code = course_code.replace("/", "_")
    return course_code or fallback or "course"


def login(username: str, password: str) -> Tuple[requests.Session, str]:
    """Authenticate against ELMS and return an authenticated session and sesskey."""

    session = requests.Session()
    login_page = session.get(ELMS_LOGIN_URL, timeout=30)
    csrf_token = extract_csrf_token(login_page.text)

    if not csrf_token:
        raise ElmsLoginError("Unable to locate CSRF token on login page.")

    payload = {"username": username, "password": password, "logintoken": csrf_token}
    response = session.post(ELMS_LOGIN_URL, data=payload, timeout=30)

    if "Dashboard" not in response.text:
        raise ElmsLoginError("Login failed. Please verify your credentials.")

    session_key = extract_session_key(response.text)
    if not session_key:
        raise ElmsLoginError("Authenticated but failed to capture session key.")

    return session, session_key


def _course_payload() -> List[Dict[str, object]]:
    return [
        {
            "index": 0,
            "methodname": "core_course_get_enrolled_courses_by_timeline_classification",
            "args": {
                "offset": 0,
                "limit": 1000,
                "classification": "all",
                "sort": "fullname",
                "customfieldname": "",
                "customfieldvalue": "",
                "requiredfields": [
                    "id",
                    "fullname",
                    "shortname",
                    "showcoursecategory",
                    "showshortname",
                    "visible",
                    "enddate",
                ],
            },
        }
    ]


def get_all_course_ids(session: requests.Session, session_key: str) -> List[int]:
    course_url = ELMS_COURSE_API.format(sesskey=session_key)
    all_course = session.post(course_url, json=_course_payload(), timeout=30)
    json_data = json.loads(all_course.text)
    courses = json_data[0]["data"].get("courses", [])
    return [course["id"] for course in courses]


def get_courses_with_names(session: requests.Session, session_key: str) -> Dict[str, int]:
    course_url = ELMS_COURSE_API.format(sesskey=session_key)
    all_course = session.post(course_url, json=_course_payload(), timeout=30)
    json_data = json.loads(all_course.text)
    courses = json_data[0]["data"].get("courses", [])
    return {
        course["fullname"].split(":", 1)[-1].strip(): course["id"] for course in courses
    }


def extract_course_data(session: requests.Session, course_id: str) -> CourseData:
    full_list_url = ELMS_USER_LIST_URL.format(course_id=course_id)
    response = session.get(full_list_url, timeout=30)

    if response.status_code != 200:
        raise CourseExtractionError(f"Failed to load course roster ({response.status_code}).")

    soup = BeautifulSoup(response.text, "html.parser")
    coursename = soup.find("h1")

    if not coursename:
        raise CourseExtractionError("Course name not found on roster page.")

    course_name = coursename.text.strip()
    course_code = _derive_course_code(course_name)

    profile_links = {
        a["href"]
        for a in soup.find_all("a", class_="d-inline-block aabtn", href=True)
        if a["href"]
    }

    users: List[Dict[str, str]] = []

    for profile_url in profile_links:
        profile_page = session.get(profile_url, timeout=30)
        if profile_page.status_code != 200:
            continue
        profile_soup = BeautifulSoup(profile_page.text, "html.parser")
        profile_details = profile_soup.find("div", class_="card card-body card-profile")

        if not profile_details:
            continue

        name_tag = profile_details.find("h3")
        name = name_tag.text.strip() if name_tag else ""

        email_li = profile_soup.find("li", class_="contentnode")
        email_tag = email_li.find("a", href=True) if email_li else None
        email = email_tag.text.strip() if email_tag else ""

        if name and email:
            users.append({"name": name, "email": email})

    return CourseData(
        course_id=str(course_id),
        course_name=course_name,
        course_code=course_code,
        users=users,
    )


def _write_csv(users: Iterable[Dict[str, str]]) -> bytes:
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(["Name", "Email"])
    for user in users:
        writer.writerow([user.get("name", ""), user.get("email", "")])
    return buffer.getvalue().encode("utf-8")


def _write_email_list(emails: Iterable[str]) -> bytes:
    buffer = io.StringIO()
    for email in emails:
        buffer.write(f"{email}\n")
    return buffer.getvalue().encode("utf-8")


def serialize_course_files(course: CourseData) -> Dict[str, str]:
    """Return base64 representations of the CSV and email list for API responses."""

    csv_bytes = _write_csv(course.users)
    email_bytes = _write_email_list(course.email_list)

    return {
        "csv": base64.b64encode(csv_bytes).decode("ascii"),
        "emails": base64.b64encode(email_bytes).decode("ascii"),
    }


def save_course_files(course: CourseData, directory: str = ".") -> Tuple[str, str]:
    """Persist course CSV and email list to disk, returning the file paths."""

    target_dir = Path(directory)
    target_dir.mkdir(parents=True, exist_ok=True)
    csv_path = target_dir / f"{course.course_code}_users.csv"
    emails_path = target_dir / f"{course.course_code}_emails.txt"

    with open(csv_path, "wb") as file:
        file.write(_write_csv(course.users))

    with open(emails_path, "wb") as file:
        file.write(_write_email_list(course.email_list))

    return str(csv_path), str(emails_path)


def _prompt_credentials() -> Tuple[str, str]:
    username = input("Enter your username: ")
    password = input("Enter your password: ")
    return username, password


def main() -> None:
    username, password = _prompt_credentials()

    try:
        session, session_key = login(username, password)
    except ElmsLoginError as error:
        print(str(error))
        return

    print("Login successful!")

    option = """Choose your option:
    1. Extract all courses
    2. Extract Course By ID
    3. Show All Course ID with Name
    4. Exit"""

    while True:
        print(option)
        choice = input("Enter your choice: ")

        if choice == "1":
            print("Please wait. Extracting data...")
            try:
                course_ids = get_all_course_ids(session, session_key)
                for course_id in course_ids:
                    course_data = extract_course_data(session, str(course_id))
                    save_course_files(course_data)
                    print(f"Saved files for {course_data.course_name}")
            except (CourseExtractionError, json.JSONDecodeError) as error:
                print(f"Failed to extract courses: {error}")

        elif choice == "2":
            course_id = input("Enter Course ID: ")
            print("Please wait. Extracting data...")
            try:
                course_data = extract_course_data(session, course_id)
                save_course_files(course_data)
                print(f"Saved files for {course_data.course_name}")
            except CourseExtractionError as error:
                print(f"Failed to extract course: {error}")

        elif choice == "3":
            try:
                print(get_courses_with_names(session, session_key))
            except json.JSONDecodeError as error:
                print(f"Failed to load courses: {error}")

        elif choice == "4":
            break

        else:
            print("Invalid choice. Please try again.")

    print("Thank you for using our service.")
    session.close()


if __name__ == "__main__":
    main()