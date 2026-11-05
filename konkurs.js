/* Лендинг конкурса «Корпоративная история».
   Статическая страница: показывает этап, сроки и кнопки входа.
   Регистрация, карточки и голосование — на отдельном сервисе (см. CONFIG.endpoints). */

const METRIKA_ID = 20920177;

/* Всё, что нужно менять перед запуском, — здесь. Даты — по московскому времени (UTC+3). */
const CONFIG = {
  registrationStart: '2026-11-11T00:00:00+03:00',
  registrationEnd:   '2026-11-25T23:59:59+03:00',
  votingStart:       '2026-11-26T00:00:00+03:00',
  votingEnd:         '2026-12-05T23:59:59+03:00',
  resultsDate:       '2026-12-09T12:00:00+03:00',
  prizesBy:          '2026-12-25T23:59:59+03:00',

  /* Адреса сервиса регистрации и голосования. Пока пусто — кнопки неактивны. */
  endpoints: {
    loginVk:   '',   // например https://vote.example.ru/auth/vk
    loginSber: '',   // например https://vote.example.ru/auth/sber
    rules:     ''    // ссылка на опубликованное Положение (если отдельным документом)
  },

  /* Показать формулировку лимита голосов, когда решение принято. */
  voteLimitText: ''
};

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);

/* Для проверки этапов без ожидания дат: ?now=2026-11-27T12:00:00+03:00 */
const now = params.get('now') ? new Date(params.get('now')) : new Date();
const t = (s) => new Date(s);

const fmt = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', timeZone: 'Europe/Moscow' });
const fmtTime = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' });

function phase() {
  if (now < t(CONFIG.registrationStart)) return 'soon';
  if (now <= t(CONFIG.registrationEnd))  return 'register';
  if (now < t(CONFIG.votingStart))       return 'pause';
  if (now <= t(CONFIG.votingEnd))        return 'vote';
  if (now < t(CONFIG.resultsDate))       return 'count';
  return 'done';
}

const PHASES = {
  soon:     { label: 'Скоро старт',           date: () => `Регистрация откроется ${fmt.format(t(CONFIG.registrationStart))}` },
  register: { label: 'Идёт регистрация',       date: () => `До ${fmtTime.format(t(CONFIG.registrationEnd))}` },
  pause:    { label: 'Регистрация закрыта',    date: () => `Голосование начнётся ${fmt.format(t(CONFIG.votingStart))}` },
  vote:     { label: 'Идёт голосование',       date: () => `До ${fmtTime.format(t(CONFIG.votingEnd))}` },
  count:    { label: 'Подводим итоги',         date: () => `Результаты ${fmt.format(t(CONFIG.resultsDate))}` },
  done:     { label: 'Конкурс завершён',       date: () => 'Спасибо всем участникам' }
};

const REGISTER_LEAD = {
  soon:     () => `Регистрация откроется ${fmt.format(t(CONFIG.registrationStart))}. Подготовьте название компании, короткий рассказ и видео до 60 секунд.`,
  register: () => `Войдите через VK ID или Сбер ID и заполните анкету. Регистрация открыта до ${fmtTime.format(t(CONFIG.registrationEnd))}.`,
  pause:    () => 'Регистрация закрыта. Голосование начнётся в назначенный день.',
  vote:     () => 'Регистрация закрыта. Чтобы проголосовать, откройте ссылку на карточку компании, которой поделился её капитан.',
  count:    () => 'Голосование завершено. Проверяем голоса и подводим итоги.',
  done:     () => 'Конкурс завершён.'
};

/* ---------- метрика ---------- */
function initMetrika() {
  if (window.ym) return;
  (function (m, e, tag, r, i, k, a) {
    m[i] = m[i] || function () { (m[i].a = m[i].a || []).push(arguments); };
    m[i].l = 1 * new Date();
    k = e.createElement(tag); a = e.getElementsByTagName(tag)[0];
    k.async = 1; k.src = r; a.parentNode.insertBefore(k, a);
  })(window, document, 'script', 'https://mc.yandex.ru/metrika/tag.js', 'ym');
  window.ym(METRIKA_ID, 'init', { clickmap: true, trackLinks: true, accurateTrackBounce: true, webvisor: true });
}
const goal = (name, payload) => { if (window.ym) window.ym(METRIKA_ID, 'reachGoal', name, payload); };

/* ---------- рендер ---------- */
function renderStatus(p) {
  const el = $('status');
  el.dataset.phase = p;
  $('statusLabel').textContent = PHASES[p].label;
  $('statusDate').textContent = PHASES[p].date();
}

function renderTimeline(p) {
  const rows = [
    ['Регистрация и загрузка видео', `${fmt.format(t(CONFIG.registrationStart))} – ${fmt.format(t(CONFIG.registrationEnd))}`, 'register'],
    ['Голосование',                  `${fmt.format(t(CONFIG.votingStart))} – ${fmt.format(t(CONFIG.votingEnd))}`,             'vote'],
    ['Объявление итогов',            fmt.format(t(CONFIG.resultsDate)),                                                         'count'],
    ['Вручение призов',              `до ${fmt.format(t(CONFIG.prizesBy))}`,                                                    'done']
  ];
  const order = ['soon', 'register', 'pause', 'vote', 'count', 'done'];
  const idx = (x) => order.indexOf(x);

  $('timeline').innerHTML = rows.map(([title, when, key]) => {
    let state = 'future';
    if (key === p || (key === 'register' && p === 'register') || (key === 'vote' && p === 'vote')) state = 'now';
    else if (idx(p) > idx(key)) state = 'past';
    return `<li data-state="${state}"><span>${title}</span><span>${when}</span></li>`;
  }).join('');
}

function setupButtons(p) {
  const { loginVk, loginSber, rules } = CONFIG.endpoints;
  const canRegister = p === 'register';

  [['loginVk', loginVk], ['loginSber', loginSber]].forEach(([id, url]) => {
    const a = $(id);
    if (canRegister && url) {
      a.href = url;
      a.removeAttribute('aria-disabled');
    } else {
      a.href = '#register';
      a.setAttribute('aria-disabled', 'true');
    }
  });

  const main = $('ctaMain');
  if (!canRegister) {
    main.textContent = p === 'soon' ? 'Узнать условия' : 'Как это работает';
    main.setAttribute('href', '#how');
  }

  if (rules) $('rulesLink').href = rules;
  if (CONFIG.voteLimitText) $('voteLimit').textContent = CONFIG.voteLimitText;
}

function init() {
  const p = phase();
  renderStatus(p);
  renderTimeline(p);
  $('registerLead').textContent = REGISTER_LEAD[p]();
  setupButtons(p);

  document.addEventListener('click', (e) => {
    const a = e.target.closest('[data-track]');
    if (a) goal('konkurs_click', { id: a.dataset.track });
  });

  initMetrika();
}

init();
