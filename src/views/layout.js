import { html, raw } from '../html.js';

export function layout({ title, contestTitle, body, csrf, account, admin = false, head = '' }) {
  const fullTitle = title ? `${title} — ${contestTitle}` : contestTitle;
  return html`<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${fullTitle}</title>
<meta name="theme-color" content="#80166e">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Unbounded:wght@400;600;800&family=Golos+Text:wght@400;500;600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/assets/styles.css?v=6">
<link rel="stylesheet" href="/konkurs.css?v=2">
<link rel="stylesheet" href="/assets/app.css?v=1">
${raw(head)}
</head>
<body${admin ? raw(' class="admin"') : ''}>
<header class="top">
  <a class="top__brand" href="${admin ? '/admin' : '/'}">Феерия<span>.ру</span></a>
  <nav class="top__side app-nav">
    ${admin
      ? html`<a href="/admin/companies">Заявки</a><a href="/admin/videos">Видео</a><a href="/admin/votes">Голоса</a><a href="/admin/results">Итоги</a>
        <form method="post" action="/admin/logout"><input type="hidden" name="_csrf" value="${csrf}"><button class="linklike">Выйти</button></form>`
      : html`<a href="/companies">Участники</a><a href="/rating">Рейтинг</a>
        ${account
          ? html`<a href="/my">Кабинет</a><form method="post" action="/logout"><input type="hidden" name="_csrf" value="${csrf}"><button class="linklike">Выйти</button></form>`
          : ''}`}
  </nav>
</header>
<main class="app-main">
${body}
</main>
${admin ? '' : html`<footer class="foot">
  <p>Конкурс проводится ООО «ПОГНАЛИ ФЕЕРИТЬ». Реквизиты и Положение — в разделе «Правила конкурса» на <a href="/#rules">странице конкурса</a>.</p>
  <p>Имена и фото голосующих не публикуются.</p>
</footer>`}
</body>
</html>`;
}

export const notice = (text, kind = 'info') => html`<p class="notice notice--${kind}" role="status">${text}</p>`;

export const simpleBody = (title, text, back) => html`<section class="k-section">
  <h1 class="k-h2">${title}</h1>
  <p>${text}</p>
  ${back ? html`<p><a class="btn btn--ghost" href="${back}">Назад</a></p>` : ''}
</section>`;
