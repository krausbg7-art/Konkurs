import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';

import { registerSessions } from './session.js';
import { buildProviders } from './auth/providers.js';
import { buildCaptcha } from './captcha.js';
import { Transcoder } from './transcode.js';
import { layout, simpleBody } from './views/layout.js';
import authRoutes from './routes/auth.js';
import publicRoutes from './routes/public.js';
import captainRoutes from './routes/captain.js';
import voteRoutes from './routes/vote.js';
import adminRoutes from './routes/admin.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * @param {object} deps
 * @param {object} deps.cfg     loadConfig() result
 * @param {import('pg').Pool} deps.pool
 * @param {() => Date} [deps.now]  clock; tests pass a fixed one
 */
export async function buildApp({ cfg, pool, now = () => new Date(), logger = true }) {
  const app = Fastify({ logger, trustProxy: cfg.trustProxy, bodyLimit: 64 * 1024 });

  await mkdir(path.join(cfg.videoDir, 'tmp'), { recursive: true });

  await app.register(cookie);
  await app.register(formbody);
  await app.register(multipart, { limits: { fileSize: cfg.video.maxMegabytes * 1024 * 1024, files: 1, fields: 5 } });
  // Landing page files from the repo root; nothing else from there is exposed.
  await app.register(fastifyStatic, { root: path.join(root, 'assets'), prefix: '/assets/' });

  const ctx = {
    cfg,
    pool,
    now,
    providers: buildProviders(cfg),
    transcoder: new Transcoder({ cfg, pool, log: app.log }),
    captcha: buildCaptcha(cfg),
    // Wraps a page body in the shared layout.
    page(req, reply, { title, body, status, admin = false, head = '' }) {
      if (status) reply.code(status);
      reply.type('text/html; charset=utf-8');
      return layout({
        title, body, admin, head,
        contestTitle: cfg.contest.title,
        csrf: req.session?.csrf,
        account: req.session?.account_id,
      }).toString();
    },
  };

  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'strict-origin-when-cross-origin');
    reply.header('x-frame-options', 'DENY');
    return payload;
  });

  app.decorate('transcoder', ctx.transcoder);
  app.addHook('onClose', () => ctx.transcoder.stop());

  registerSessions(app, { pool, cfg });

  for (const file of ['index.html', 'konkurs.css', 'konkurs.js']) {
    app.get(file === 'index.html' ? '/' : `/${file}`, (req, reply) => reply.sendFile(file, root));
  }

  await app.register(authRoutes, { ctx });
  await app.register(publicRoutes, { ctx });
  await app.register(captainRoutes, { ctx });
  await app.register(voteRoutes, { ctx });
  await app.register(adminRoutes, { ctx, prefix: '/admin' });

  app.setNotFoundHandler((req, reply) =>
    ctx.page(req, reply, { status: 404, title: 'Страница не найдена', body: notFoundBody() }));

  app.setErrorHandler((err, req, reply) => {
    if (err.code === 'FST_REQ_FILE_TOO_LARGE') {
      return ctx.page(req, reply, { status: 413, title: 'Файл слишком большой', body: simpleBody('Файл слишком большой', `Максимальный размер видео — ${cfg.video.maxMegabytes} МБ.`, '/my') });
    }
    req.log.error(err);
    const status = err.statusCode && err.statusCode < 500 ? err.statusCode : 500;
    return ctx.page(req, reply, { status, title: 'Ошибка', body: simpleBody('Что-то пошло не так', 'Попробуйте ещё раз чуть позже.', '/') });
  });

  return app;
}

const notFoundBody = () => simpleBody('Страница не найдена', 'Проверьте ссылку или откройте список участников.', '/companies');
