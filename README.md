# ELMS Extractor

Extract participant names and email addresses from your UIU ELMS courses. The project now ships with both the original Python CLI tool and a web-friendly API plus static front-end that you can publish on GitHub Pages.

## Project layout

```
elms_extractor.py       # Reusable extraction utilities + CLI entrypoint
backend/app.py          # FastAPI backend exposing the extractor to the web UI
backend/requirements.txt
docs/                   # Static front-end (HTML/CSS/JS) for GitHub Pages
```

## Features
- Login once and reuse the authenticated ELMS session while it is valid.
- List all enrolled courses with human-friendly names.
- Download per-course CSV rosters and plain-text email lists.
- Bulk export every course in a single ZIP archive.
- Host the UI on GitHub Pages (static assets) while running the API anywhere you choose.

## 1. Run the CLI locally (optional)

```bash
python -m venv .venv
. .venv/Scripts/activate  # PowerShell: .venv\Scripts\Activate.ps1
pip install -r backend/requirements.txt
python elms_extractor.py
```

Follow the interactive prompts to export course files into the current directory.

## 2. Host the API backend

1. Create and activate a virtual environment.
2. Install dependencies:

   ```bash
   pip install -r backend/requirements.txt
   ```

3. Start the FastAPI server:

   ```bash
   uvicorn backend.app:app --reload --host 0.0.0.0 --port 8000
   ```

4. (Optional) Restrict the browser origins that may call your API by setting `ALLOWED_ORIGINS` before launching the server, for example:

   ```bash
   $env:ALLOWED_ORIGINS = "https://your-github-username.github.io"
   uvicorn backend.app:app --host 0.0.0.0 --port 8000
   ```

You can deploy the same app to any Python-friendly hosting provider (Render, Railway, Fly.io, Azure, etc.). Keep the service behind HTTPS because you will post credentials to it.

### API endpoints
- `POST /api/login` – authenticate, receive a short-lived session token, and the initial course list.
- `GET /api/courses` – refresh the course list.
- `POST /api/courses/{course_id}/extract` – generate download-ready CSV + TXT files.
- `POST /api/courses/extract-all` – generate a ZIP containing every course.

## 3. Publish the front-end on GitHub Pages

1. Edit `docs/config.js` and set `apiBaseUrl` to the public URL of the backend you host.
2. Commit and push the repository.
3. Enable GitHub Pages with the **docs/** folder as the source.
4. Visit the published URL, log in, and start exporting.

The front-end never stores your credentials; they are sent directly to your own backend over HTTPS. Downloads are generated in-browser from the API responses.

### Screenshots

![Login screen with crafted-by footer](docs/assets/login-screen.png)
![Course dashboard view](docs/assets/dashboard-screen.png)

> Replace the placeholder images in `docs/assets/` with fresh screenshots that match your deployment.

## Security considerations
- Always serve the backend over HTTPS to protect credentials.
- Rotate the backend session token by logging out from the UI when you finish.
- Avoid hosting the backend where you do not control TLS certificates or logs.

## License

This project is for educational purposes. Use it responsibly and in accordance with UIU policies.

