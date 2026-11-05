// Tiny HTML templating: every interpolated value is escaped unless wrapped in raw().

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

class Raw {
  constructor(s) { this.s = s; }
  toString() { return this.s; }
}

export const raw = (s) => new Raw(String(s));
export const escape = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);

function render(v) {
  if (v === null || v === undefined || v === false) return '';
  if (v instanceof Raw) return v.s;
  if (Array.isArray(v)) return v.map(render).join('');
  return escape(v);
}

export function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += render(values[i]) + strings[i + 1];
  return new Raw(out);
}

// Moscow time formatting for pages.
const TZ = 'Europe/Moscow';
const fmtDate = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', timeZone: TZ });
const fmtDateTime = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: TZ });
const fmtFull = new Intl.DateTimeFormat('ru-RU', {
  day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: TZ,
});

export const date = (d) => (d ? fmtDate.format(new Date(d)) : '');
export const dateTime = (d) => (d ? fmtDateTime.format(new Date(d)) : '');
// Exact time with milliseconds — for the organiser (votes, tie-breaks).
export function exactTime(d) {
  if (!d) return '';
  const x = new Date(d);
  return `${fmtFull.format(x)}.${String(x.getMilliseconds()).padStart(3, '0')}`;
}

export const plural = (n, one, few, many) => {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
};
