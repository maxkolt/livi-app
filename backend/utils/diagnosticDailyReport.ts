import nodemailer from 'nodemailer';
import mongoose from 'mongoose';
import ReleaseDiagnostic, { ReleaseDiagnosticReport, type ReleaseDiagnosticRecord } from '../models/ReleaseDiagnostic';
import { diagnosticReportWindow } from './releaseDiagnostics';
import { logger } from './logger';

const RECIPIENT = '12345kolt@gmail.com';
const time = (date: Date) => date.toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', hour12: false });
const escapeHtml = (text: string) => text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function buildDiagnosticReport(
  start: Date, end: Date, rows: ReleaseDiagnosticRecord[], total: number, latestReceivedAt: Date | null,
): { subject: string; text: string; html: string } {
  const errors = rows.filter(row => row.level === 'error');
  const warnings = rows.filter(row => row.level === 'warning');
  const calls = rows.filter(row => row.event === 'call_outcome');
  const totals = new Map<string, number>();
  for (const row of rows) totals.set(row.event, (totals.get(row.event) || 0) + 1);
  const devices = [...new Set(rows.map(row => `${row.device.model} · Android ${row.device.os} · сборка ${row.device.build} · ${row.deviceKey.slice(0, 8)}`))];
  const failures = rows.filter(row => row.level !== 'info');
  const examples = failures.slice(-20).map(row => {
    const context = rows.filter(prev => prev.deviceKey === row.deviceKey && prev.at <= row.at &&
      (row.operation ? prev.operation === row.operation : prev.session === row.session))
      .slice(-5).map(prev => `    ${time(prev.at)} ${prev.event} ${JSON.stringify(prev.data)}`).join('\n');
    return `${time(row.at)} [${row.level}] ${row.event} (${row.device.model}, ${row.deviceKey.slice(0, 8)})\n${context}`;
  });
  const delayed = rows.filter(row => row.receivedAt.getTime() - row.at.getTime() > 3600_000).length;
  const messageQueued = rows.filter(row => row.event === 'message_queued').length;
  const messageAccepted = rows.filter(row => row.event === 'message_server_accepted');
  const subject = `[LiVi] Отчёт ${time(end).split(',')[0]}: ${errors.length} ошибок, ${warnings.length} предупреждений`;
  const text = [
    'LiVi — диагностика тестового релиза',
    `Период получения событий: ${time(start)} — ${time(end)} (МСК).`,
    `Получено событий: ${total}. В отчёте подробно: ${rows.length}.`,
    `Последние данные от телефона: ${latestReceivedAt ? time(latestReceivedAt) : 'ещё не получены'}.`,
    rows.length ? devices.join('\n') : 'Нет данных за период. Это не подтверждает отсутствие ошибок: проверьте установку сборки с диагностикой и доступ к сети.',
    total > rows.length ? 'Достигнут предел подробного отчёта (10 000 событий). Приведённые ниже счётчики относятся к включённой выборке.' : '',
    '',
    `Звонки с полученным итогом: ${calls.length}; соединились: ${calls.filter(row => row.data.outcome === 'connected').length}; ошибка соединения: ${calls.filter(row => row.data.outcome === 'connect_failed').length}; без ответа: ${calls.filter(row => row.data.outcome === 'not_answered').length}.`,
    '«Без ответа» и предупреждение о восстановлении связи сами по себе не являются дефектами.',
    `Сообщения: поставлено в очередь ${messageQueued}; приняты сервером ${messageAccepted.length}; из них подтверждена доставка ${messageAccepted.filter(row => row.data.delivered === true).length}; зарегистрировано отказов ${rows.filter(row => row.event === 'message_send_failed').length}.`,
    'Приём сервером и доставка получателю — разные этапы. Отсутствующий итог требует проверки и не считается успехом.',
    `Ошибки: ${errors.length}. Предупреждения: ${warnings.length}.`,
    `Поздно доставленные события (задержка более часа): ${delayed}.`,
    '', 'События:', ...[...totals].sort((a, b) => b[1] - a[1]).map(([event, count]) => `  ${event}: ${count}`),
    '', 'Последние проблемные случаи и контекст:', examples.join('\n\n') || 'В полученных данных ошибок и предупреждений нет.',
    '', 'Ограничения: учитываются только доставленные события включённых тестовых устройств. Наличие аудиотрафика не доказывает слышимость речи. Падения/ANR Android приходят после следующего запуска; если приложение не открывали, они могут отсутствовать. Текст переписки, медиа, пароли и полные стеки в этот отчёт не собираются.',
  ].filter(Boolean).join('\n');
  return { subject, text, html: `<pre style="white-space:pre-wrap;font-family:Arial,sans-serif">${escapeHtml(text)}</pre>` };
}

export function createDiagnosticMailer() {
  const password = String(process.env.SMTP_AUTH_PASSWORD || '').replace(/\s/g, '');
  const user = String(process.env.SMTP_AUTH_USERNAME || RECIPIENT).trim();
  if (!password) throw new Error('smtp_password_missing');
  const port = Number(process.env.SMTP_PORT || 587);
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com', port, secure: port === 465,
    requireTLS: true, auth: { user, pass: password },
    connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 30_000,
    logger: false, debug: false,
  });
}

export async function sendDiagnosticTestEmail(): Promise<void> {
  const mailer = createDiagnosticMailer();
  await mailer.sendMail({
    from: process.env.SMTP_AUTH_USERNAME || RECIPIENT, to: RECIPIENT,
    subject: '[LiVi] Проверка ежедневного отчёта',
    text: 'Проверка отправки почты LiVi прошла. Ежедневный отчёт настроен на 21:00 по Москве. Данные с телефона появятся после установки и запуска релиза с диагностикой. Это тестовое письмо, оно не содержит результатов тестирования приложения.',
  });
}

/** A persisted lease prevents overlapping jobs/restarts from intentionally resending a report. */
export async function sendDiagnosticReportIfDue(now = new Date()): Promise<boolean> {
  if (process.env.RELEASE_DIAGNOSTICS_ENABLED !== '1' || mongoose.connection.readyState !== 1) return false;
  const window = diagnosticReportWindow(now);
  const startAt = Date.parse(process.env.RELEASE_DIAGNOSTICS_START_AT || '');
  if (!Number.isFinite(startAt) || window.end.getTime() < startAt) return false;
  let claimed;
  try {
    claimed = await ReleaseDiagnosticReport.findOneAndUpdate({
      _id: window.key, status: { $ne: 'sent' },
      $or: [{ lockedUntil: { $lt: now } }, { lockedUntil: { $exists: false } }],
    }, { $set: { status: 'sending', lockedUntil: new Date(now.getTime() + 300_000), start: window.start, end: window.end },
      $inc: { attempts: 1 } }, { new: true, upsert: true }).lean();
  } catch (error) {
    if ((error as { code?: number }).code === 11000) return false;
    throw error;
  }
  if (!claimed) return false;
  try {
    const filter = { receivedAt: { $gte: window.start, $lt: window.end } };
    const [rows, total, latest] = await Promise.all([
      ReleaseDiagnostic.find(filter).sort({ receivedAt: -1 }).limit(10_000).lean(),
      ReleaseDiagnostic.countDocuments(filter),
      ReleaseDiagnostic.findOne({ receivedAt: { $lt: window.end } }).sort({ receivedAt: -1 }).select('receivedAt').lean(),
    ]);
    rows.sort((a, b) => a.at.getTime() - b.at.getTime());
    const report = buildDiagnosticReport(window.start, window.end, rows, total, latest?.receivedAt || null);
    const mailer = createDiagnosticMailer();
    await mailer.sendMail({
      from: process.env.SMTP_AUTH_USERNAME || RECIPIENT, to: RECIPIENT,
      ...report, messageId: `<livi-diagnostics-${window.key}@liviapp.com>`,
      attachments: [{ filename: `livi-diagnostics-${window.key}.json`,
        content: JSON.stringify({ window, total, events: rows.map(row => ({
          device: row.device, deviceKey: row.deviceKey, session: row.session, event: row.event,
          level: row.level, at: row.at, receivedAt: row.receivedAt, operation: row.operation, data: row.data,
        })) }), contentType: 'application/json' }],
    });
    await ReleaseDiagnosticReport.updateOne({ _id: window.key }, { $set: { status: 'sent', sentAt: new Date(), lockedUntil: new Date(0) }, $unset: { failureCode: 1 } });
    logger.info('[diagnostics] daily report accepted by SMTP', { day: window.key, events: total });
    return true;
  } catch (error) {
    const code = String((error as { code?: string }).code || 'report_failed').replace(/[^a-zA-Z0-9_]/g, '').slice(0, 60);
    await ReleaseDiagnosticReport.updateOne({ _id: window.key }, { $set: { status: 'failed', failureCode: code } });
    logger.warn('[diagnostics] daily report failed; retry in five minutes', { code, day: window.key });
    return false;
  }
}

export function startDiagnosticDailyReports(): void {
  if (process.env.RELEASE_DIAGNOSTICS_ENABLED !== '1') return;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await sendDiagnosticReportIfDue(); }
    catch { logger.warn('[diagnostics] report job unavailable'); }
    finally { running = false; }
  };
  const timer = setInterval(() => void tick(), 60_000);
  timer.unref();
  void tick();
}
