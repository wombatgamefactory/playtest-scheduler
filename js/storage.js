// Tiny localStorage wrapper. Every access is wrapped in try/catch so the app
// keeps working (in memory, for the current page load) when storage is
// unavailable - private browsing, a locked-down phone browser, quota errors.

export function loadJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return fallback;
    return JSON.parse(raw);
  } catch (e) {
    return fallback;
  }
}

export function saveJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (e) {
    return false;
  }
}

export function removeKey(key) {
  try {
    localStorage.removeItem(key);
  } catch (e) {
    // ignore
  }
}
