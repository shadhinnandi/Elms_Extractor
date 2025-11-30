'use strict';

const state = {
    token: null,
    courses: [],
    linksByCourse: new Map()
};

const elements = {
    loginSection: document.getElementById('login-section'),
    dashboard: document.getElementById('dashboard'),
    loginForm: document.getElementById('login-form'),
    loginButton: document.getElementById('login-button'),
    loginError: document.getElementById('login-error'),
    statusMessage: document.getElementById('status-message'),
    coursesContainer: document.getElementById('courses-container'),
    refreshCourses: document.getElementById('refresh-courses'),
    extractAll: document.getElementById('extract-all'),
    logoutButton: document.getElementById('logout-button'),
    usernameField: document.getElementById('username'),
    busyOverlay: document.getElementById('busy-overlay'),
    busyMessage: document.getElementById('busy-message'),
    busyTimer: document.getElementById('busy-timer'),
    modal: document.getElementById('download-modal'),
    modalTitle: document.getElementById('modal-title'),
    modalBody: document.getElementById('modal-body'),
    modalClose: document.getElementById('modal-close'),
    footerNote: document.getElementById('footer-note')
};

let lastFocusElement = null;
let busyTimerInterval = null;
let busyCountdownRemaining = 0;
let busyElapsedSeconds = 0;

if (elements.loginButton) {
    elements.loginButton.dataset.defaultLabel = elements.loginButton.textContent;
}
if (elements.extractAll) {
    elements.extractAll.dataset.defaultLabel = elements.extractAll.textContent;
}

const apiBaseUrl = (window.ELMS_CONFIG && window.ELMS_CONFIG.apiBaseUrl) || '';

function setStatus(message, type = 'info') {
    if (!elements.statusMessage) {
        return;
    }
    elements.statusMessage.textContent = message;
    if (message) {
        elements.statusMessage.dataset.type = type;
    } else {
        delete elements.statusMessage.dataset.type;
    }
}

function clearStatus() {
    setStatus('');
}

function setLoginBusy(isBusy) {
    if (!elements.loginButton) {
        return;
    }
    elements.loginButton.disabled = isBusy;
    const defaultLabel = elements.loginButton.dataset.defaultLabel || 'Sign in';
    elements.loginButton.textContent = isBusy ? 'Signing in...' : defaultLabel;
}

function setToolbarDisabled(disabled, labelWhenDisabled) {
    if (elements.refreshCourses) {
        elements.refreshCourses.disabled = disabled;
    }
    if (elements.extractAll) {
        elements.extractAll.disabled = disabled;
        const defaultLabel = elements.extractAll.dataset.defaultLabel || 'Download all courses';
        if (disabled && labelWhenDisabled) {
            elements.extractAll.textContent = labelWhenDisabled;
        } else if (!disabled) {
            elements.extractAll.textContent = defaultLabel;
        }
    }
}

function formatDuration(totalSeconds) {
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function updateBusyTimerText() {
    if (!elements.busyTimer) {
        return;
    }
    if (busyCountdownRemaining > 0) {
        elements.busyTimer.textContent = `Estimated time remaining: ${formatDuration(busyCountdownRemaining)}`;
        elements.busyTimer.classList.remove('hidden');
    } else if (busyElapsedSeconds > 0) {
        elements.busyTimer.textContent = `Taking a bit longer... working for ${formatDuration(busyElapsedSeconds)}`;
        elements.busyTimer.classList.remove('hidden');
    } else {
        elements.busyTimer.textContent = '';
        elements.busyTimer.classList.add('hidden');
    }
}

function stopBusyTimer() {
    if (busyTimerInterval) {
        window.clearInterval(busyTimerInterval);
        busyTimerInterval = null;
    }
    busyCountdownRemaining = 0;
    busyElapsedSeconds = 0;
    updateBusyTimerText();
}

function showBusy(message, options = {}) {
    if (!elements.busyOverlay || !elements.busyMessage) {
        return;
    }
    const { countdown = false, duration = 45 } = options;
    elements.busyMessage.textContent = message;
    if (countdown && elements.busyTimer) {
        stopBusyTimer();
        busyCountdownRemaining = Math.max(0, duration);
        busyElapsedSeconds = 0;
        updateBusyTimerText();
        busyTimerInterval = window.setInterval(() => {
            if (busyCountdownRemaining > 0) {
                busyCountdownRemaining -= 1;
            } else {
                busyElapsedSeconds += 1;
            }
            updateBusyTimerText();
        }, 1000);
    } else {
        stopBusyTimer();
    }
    elements.busyOverlay.classList.remove('hidden');
    document.body.classList.add('busy');
}

function hideBusy() {
    if (!elements.busyOverlay) {
        return;
    }
    stopBusyTimer();
    elements.busyOverlay.classList.add('hidden');
    document.body.classList.remove('busy');
}

function base64ToBlob(base64, mime) {
    const binary = window.atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
        bytes[i] = binary.charCodeAt(i);
    }
    return new Blob([bytes], { type: mime });
}

function createDownloadItem(filename, base64, mime, label) {
    return {
        filename,
        mime,
        label: label || filename,
        blob: base64ToBlob(base64, mime),
        objectUrl: null
    };
}

function ensureObjectUrl(item) {
    if (!item.objectUrl) {
        item.objectUrl = URL.createObjectURL(item.blob);
    }
    return item.objectUrl;
}

function releaseDownloadItem(item) {
    if (item.objectUrl) {
        URL.revokeObjectURL(item.objectUrl);
        item.objectUrl = null;
    }
    item.blob = null;
}

function releaseDownloads(downloads) {
    downloads.forEach(releaseDownloadItem);
}

function buildDownloadAnchor(item, className) {
    const anchor = document.createElement('a');
    if (className) {
        anchor.className = className;
    }
    anchor.href = ensureObjectUrl(item);
    anchor.download = item.filename;
    anchor.textContent = item.label;
    anchor.title = `Download ${item.filename}`;
    return anchor;
}

function renderCourses() {
    if (!elements.coursesContainer) {
        return;
    }

    elements.coursesContainer.innerHTML = '';
    if (!state.courses.length) {
        const empty = document.createElement('p');
        empty.textContent = 'No courses found.';
        elements.coursesContainer.appendChild(empty);
        return;
    }

    const fragment = document.createDocumentFragment();
    state.courses.forEach(({ id, name }) => {
        const courseCard = document.createElement('article');
        courseCard.className = 'course-card';

        const heading = document.createElement('h3');
        heading.textContent = name;
        courseCard.appendChild(heading);

        const meta = document.createElement('div');
        meta.className = 'course-meta';
        meta.textContent = `ID: ${id}`;
        courseCard.appendChild(meta);

        const actions = document.createElement('div');
        actions.className = 'actions';

        const extractButton = document.createElement('button');
        extractButton.textContent = 'Extract';
        extractButton.className = 'primary';
        extractButton.addEventListener('click', () => handleExtractCourse(id, name, extractButton));
        actions.appendChild(extractButton);

        const downloadsWrapper = document.createElement('div');
        downloadsWrapper.className = 'download-links';
        downloadsWrapper.setAttribute('aria-live', 'polite');

        const savedDownloads = state.linksByCourse.get(id);
        if (savedDownloads && savedDownloads.length) {
            const caption = document.createElement('span');
            caption.className = 'download-caption';
            caption.textContent = 'Latest downloads ready:';
            downloadsWrapper.appendChild(caption);
            savedDownloads.forEach((item) => {
                const anchor = buildDownloadAnchor(item);
                downloadsWrapper.appendChild(anchor);
            });
        }

        courseCard.append(actions, downloadsWrapper);
        fragment.appendChild(courseCard);
    });

    elements.coursesContainer.appendChild(fragment);
}

async function apiFetch(path, options = {}) {
    const headers = new Headers(options.headers || {});
    headers.set('Content-Type', 'application/json');
    if (state.token) {
        headers.set('Authorization', `Bearer ${state.token}`);
    }

    const response = await fetch(`${apiBaseUrl}${path}`, {
        ...options,
        headers
    });

    if (!response.ok) {
        const detail = await response.json().catch(() => ({}));
        const error = new Error(detail.detail || response.statusText);
        error.status = response.status;
        throw error;
    }
    return response.json();
}

async function handleLogin(event) {
    event.preventDefault();
    clearStatus();
    if (elements.loginError) {
        elements.loginError.textContent = '';
    }

    if (!apiBaseUrl) {
        if (elements.loginError) {
            elements.loginError.textContent = 'Backend URL missing. Update docs/config.js.';
        }
        return;
    }

    const data = new FormData(elements.loginForm);
    const payload = {
        username: data.get('username'),
        password: data.get('password')
    };

    setLoginBusy(true);
    showBusy('Signing you in...');
    try {
        const response = await apiFetch('/api/login', {
            method: 'POST',
            body: JSON.stringify(payload)
        });
        state.token = response.token;
        state.courses = response.courses;
        state.linksByCourse.clear();
        elements.loginSection.classList.add('hidden');
        elements.dashboard.classList.remove('hidden');
        if (elements.footerNote) {
            elements.footerNote.classList.add('hidden');
        }
        renderCourses();
        setStatus('Select a course to generate download files.', 'info');
        if (elements.refreshCourses) {
            elements.refreshCourses.focus();
        }
    } catch (error) {
        if (elements.loginError) {
            elements.loginError.textContent = error.message || 'Login failed.';
        }
    } finally {
        setLoginBusy(false);
        hideBusy();
    }
}

async function refreshCourses() {
    clearStatus();
    setStatus('Refreshing courses...', 'info');
    setToolbarDisabled(true, 'Refreshing...');
    try {
        const response = await apiFetch('/api/courses');
        state.courses = response;
        renderCourses();
        setStatus('Course list refreshed.', 'success');
    } catch (error) {
        setStatus(error.message || 'Unable to refresh courses.', 'error');
    } finally {
        setToolbarDisabled(false);
    }
}

async function handleExtractCourse(courseId, courseName, button) {
    button.disabled = true;
    setStatus(`Preparing files for ${courseName}...`, 'info');
    setToolbarDisabled(true, 'Preparing...');
    showBusy(`Generating files for ${courseName}...`, { countdown: true, duration: 45 });
    try {
        const response = await apiFetch(`/api/courses/${courseId}/extract`, {
            method: 'POST'
        });

        const downloads = [
            createDownloadItem(response.csv_filename, response.csv_base64, 'text/csv', 'Roster (CSV)'),
            createDownloadItem(response.email_list_filename, response.email_list_base64, 'text/plain', 'Email list (TXT)')
        ];

        const existingDownloads = state.linksByCourse.get(courseId);
        if (existingDownloads) {
            releaseDownloads(existingDownloads);
        }
        state.linksByCourse.set(courseId, downloads);
        renderCourses();
        const participantInfo = typeof response.participant_count === 'number'
            ? ` (${response.participant_count} participants)`
            : '';
        setStatus(`Files for ${response.course_name} are ready${participantInfo}.`, 'success');
        showModal(`Downloads ready for ${response.course_name}`, downloads);
    } catch (error) {
        setStatus(error.message || 'Extraction failed.', 'error');
    } finally {
        button.disabled = false;
        setToolbarDisabled(false);
        hideBusy();
    }
}

async function handleExtractAll() {
    clearStatus();
    setStatus('Collecting every course into a single archive...', 'info');
    setToolbarDisabled(true, 'Creating archive...');
    showBusy('Preparing an archive for every course...', { countdown: true, duration: 75 });
    try {
        const response = await apiFetch('/api/courses/extract-all', {
            method: 'POST'
        });
        const downloads = [
            createDownloadItem(response.filename, response.base64, 'application/zip', 'All courses (ZIP)')
        ];
        const courseTotal = typeof response.courseCount === 'number'
            ? ` (${response.courseCount} courses)`
            : '';
        setStatus(`Archive ready to download${courseTotal}.`, 'success');
        showModal('All courses packaged', downloads);
    } catch (error) {
        setStatus(error.message || 'Failed to extract all courses.', 'error');
    } finally {
        setToolbarDisabled(false);
        hideBusy();
    }
}

function handleLogout() {
    hideModal();
    hideBusy();
    state.linksByCourse.forEach(releaseDownloads);
    state.linksByCourse.clear();
    state.token = null;
    state.courses = [];
    elements.loginSection.classList.remove('hidden');
    elements.dashboard.classList.add('hidden');
    clearStatus();
    elements.loginForm.reset();
    if (elements.loginError) {
        elements.loginError.textContent = '';
    }
    if (elements.footerNote) {
        elements.footerNote.classList.remove('hidden');
    }
    if (elements.usernameField) {
        elements.usernameField.focus();
    }
}

function showModal(title, downloads) {
    if (!elements.modal || !elements.modalBody || !elements.modalTitle) {
        return;
    }

    elements.modalTitle.textContent = title;
    elements.modalBody.innerHTML = '';

    const instructions = document.createElement('p');
    if (downloads.length) {
        instructions.textContent = downloads.length === 1
            ? 'Your file is ready. Choose the link to start the download. It will remain available from the course card.'
            : 'Your files are ready. Choose a link to start each download. They will remain available from the course card.';
    } else {
        instructions.textContent = 'Files are not available for download at this moment.';
    }
    elements.modalBody.appendChild(instructions);

    if (downloads.length) {
        const list = document.createElement('div');
        list.className = 'modal-list';
        downloads.forEach((item) => {
            const anchor = buildDownloadAnchor(item, 'modal-link');
            list.appendChild(anchor);
        });
        elements.modalBody.appendChild(list);
    }

    lastFocusElement = document.activeElement;
    elements.modal.classList.remove('hidden');
    document.body.classList.add('modal-open');
    if (elements.modalClose) {
        elements.modalClose.focus();
    }
}

function hideModal() {
    if (!elements.modal) {
        return;
    }
    elements.modal.classList.add('hidden');
    document.body.classList.remove('modal-open');
    if (lastFocusElement && typeof lastFocusElement.focus === 'function') {
        lastFocusElement.focus();
    }
    lastFocusElement = null;
}

function handleKeyDown(event) {
    if (event.key === 'Escape' && elements.modal && !elements.modal.classList.contains('hidden')) {
        event.preventDefault();
        hideModal();
    }
}

if (elements.loginForm) {
    elements.loginForm.addEventListener('submit', handleLogin);
}

if (elements.refreshCourses) {
    elements.refreshCourses.addEventListener('click', refreshCourses);
}

if (elements.extractAll) {
    elements.extractAll.addEventListener('click', handleExtractAll);
}

if (elements.logoutButton) {
    elements.logoutButton.addEventListener('click', handleLogout);
}

if (elements.modalClose) {
    elements.modalClose.addEventListener('click', hideModal);
}

if (elements.modal) {
    elements.modal.addEventListener('click', (event) => {
        if (event.target === elements.modal) {
            hideModal();
        }
    });
}

if (elements.usernameField && !state.token) {
    elements.usernameField.focus();
}

document.addEventListener('keydown', handleKeyDown);

(() => {
    const decode = (sequence) => {
        let output = '';
        for (let i = 0; i < sequence.length; i += 1) {
            output += String.fromCharCode(sequence[i]);
        }
        return output;
    };
    const allow = [
        decode([115,104,97,100,104,105,110,110,97,110,100,105,46,103,105,116,104,117,98,46,105,111]),
        decode([108,111,99,97,108,104,111,115,116]),
        decode([49,50,55,46,48,46,48,46,49]),
        decode([48,46,48,46,48,46,48]),
        decode([58,58,49])
    ];
    const host = (window.location.hostname || '').toLowerCase();
    if (!host) {
        return;
    }
    if (allow.some((token) => host === token || host.endsWith(`.${token}`))) {
        return;
    }
    const doc = document;
    if (!doc || !doc.body) {
        return;
    }
    const badge = doc.createElement('div');
    badge.style.cssText = 'position:fixed;bottom:18px;right:18px;z-index:2147483647;padding:10px 16px;border-radius:999px;background:rgba(9,15,29,0.88);color:#fff;font:600 13px/1.4 system-ui,sans-serif;box-shadow:0 10px 30px rgba(0,0,0,0.32);';
    const link = doc.createElement('a');
    link.href = decode([104,116,116,112,115,58,47,47,103,105,116,104,117,98,46,99,111,109,47,115,104,97,100,104,105,110,110,97,110,100,105]);
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = decode([79,114,105,103,105,110,97,108,32,67,114,101,97,116,111,114,58,32,64,115,104,97,100,104,105,110,110,97,110,100,105]);
    link.style.cssText = 'color:inherit;text-decoration:none;';
    badge.appendChild(link);
    setTimeout(() => {
        if (!doc.body.contains(badge)) {
            doc.body.appendChild(badge);
        }
    }, 1600);
})();
