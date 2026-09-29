// Small date/time/text formatting helpers shared by app.js.
// Pure, DOM-free, no imports (kept consistent with scheduler.js / meetup-import.js).

function pad(n) {
  return String(n).padStart(2, '0');
}

/** Today's date as "YYYY-MM-DD", for <input type="date"> defaults. */
export function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The current time as "HH:MM" (24h), for "Arrived now" / "Leaving now". */
export function nowHHMM() {
  const d = new Date();
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** "YYYY-MM-DD" -> "DD/MM/YYYY" (Dean's date convention), for display only. */
export function isoToDMY(iso) {
  if (!iso) return '';
  const parts = String(iso).split('-');
  if (parts.length !== 3) return iso;
  const [y, m, d] = parts;
  return `${d}/${m}/${y}`;
}

export function escapeHtml(value) {
  const s = value == null ? '' : String(value);
  return s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/**
 * The exact WhatsApp text format from the plan: session header, one line per
 * table (display name + allocated testers, no game names), a blank line
 * between sessions, watchers not listed.
 *
 *   Session 1 6:45 - 7:45
 *   - Francesco +1
 *   - Tari +1
 *
 *   Session 2 7:45 - 8:45
 *   - Dean +1
 */
export function formatWhatsApp(option, formatTime12) {
  const lines = [];
  option.sessions.forEach((s, i) => {
    if (i > 0) lines.push('');
    lines.push(`Session ${i + 1} ${formatTime12(s.start)} - ${formatTime12(s.end)}`);
    for (const t of s.tables) lines.push(`- ${t.name} +${t.testers}`);
  });
  return lines.join('\n');
}
