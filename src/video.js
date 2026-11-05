// Video checks with ffprobe: there must be a video stream and the length must fit the limit.
import { execFile } from 'node:child_process';

export const ALLOWED_EXT = ['mp4', 'mov', 'webm', 'm4v'];

export function probe(ffprobePath, file) {
  return new Promise((resolve) => {
    execFile(
      ffprobePath,
      ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', file],
      { timeout: 30000 },
      (err, stdout) => {
        if (err) return resolve({ ok: false, reason: 'Файл не распознан как видео.' });
        try {
          const j = JSON.parse(stdout);
          const hasVideo = (j.streams || []).some((s) => s.codec_type === 'video');
          const duration = Number(j.format?.duration);
          if (!hasVideo || !Number.isFinite(duration)) return resolve({ ok: false, reason: 'Файл не распознан как видео.' });
          resolve({ ok: true, duration });
        } catch {
          resolve({ ok: false, reason: 'Файл не распознан как видео.' });
        }
      },
    );
  });
}

export function checkDuration(duration, { maxSeconds, toleranceSeconds }) {
  if (duration <= maxSeconds + toleranceSeconds) return null;
  return `Видео длится ${Math.round(duration)} с, а можно не больше ${maxSeconds} с.`;
}

// Shown to the organiser next to every video under moderation.
export const VIDEO_REQUIREMENTS = [
  'Длительность не больше 60 секунд, тема «почему мы должны выиграть»',
  'Нет запуска пиротехники в помещении, с балкона или из окна',
  'Нет детей рядом с пиротехникой',
  'Нет опасных действий',
  'Нет чужой рекламы',
  'Нет музыки без прав на использование',
];
