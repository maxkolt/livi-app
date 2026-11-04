const mockSendMail = jest.fn();
jest.mock('nodemailer', () => ({ __esModule: true, default: { createTransport: jest.fn(() => ({ sendMail: mockSendMail })) } }));
jest.mock('../models/ReleaseDiagnostic', () => ({
  __esModule: true,
  default: { find: jest.fn(), countDocuments: jest.fn(), findOne: jest.fn() },
  ReleaseDiagnosticReport: { findOneAndUpdate: jest.fn(), updateOne: jest.fn() },
}));
import mongoose from 'mongoose';
import nodemailer from 'nodemailer';
import Records, { ReleaseDiagnosticReport, type ReleaseDiagnosticRecord } from '../models/ReleaseDiagnostic';
import { buildDiagnosticReport, sendDiagnosticReportIfDue, sendDiagnosticTestEmail } from './diagnosticDailyReport';

const begin = new Date('2026-11-03T18:00:00Z'), end = new Date('2026-11-04T18:00:00Z');
const row: ReleaseDiagnosticRecord = {
  deviceKey: 'abc123', eventId: 'e1', session: 's1', event: 'call_outcome', level: 'info', at: begin,
  receivedAt: begin, device: { model: 'SM-S938B', os: '16', build: '209', version: '1.1.22', manufacturer: 'Samsung', packageName: 'com.kolt12max.livi' },
  data: { outcome: 'not_answered' },
};
const oldEnv = { ...process.env };
beforeEach(() => {
  jest.clearAllMocks();
  process.env.RELEASE_DIAGNOSTICS_ENABLED = '1';
  process.env.RELEASE_DIAGNOSTICS_START_AT = begin.toISOString();
  process.env.SMTP_AUTH_PASSWORD = 'mock app pass word';
  Object.defineProperty(mongoose.connection, 'readyState', { configurable: true, value: 1 });
  (ReleaseDiagnosticReport.findOneAndUpdate as jest.Mock).mockReturnValue({ lean: async () => ({ _id: '2026-11-04' }) });
  (ReleaseDiagnosticReport.updateOne as jest.Mock).mockResolvedValue({});
  (Records.find as jest.Mock).mockReturnValue({ sort: () => ({ limit: () => ({ lean: async () => [row] }) }) });
  (Records.countDocuments as jest.Mock).mockResolvedValue(1);
  (Records.findOne as jest.Mock).mockReturnValue({ sort: () => ({ select: () => ({ lean: async () => ({ receivedAt: begin }) }) }) });
  mockSendMail.mockResolvedValue({ accepted: ['12345kolt@gmail.com'] });
});
afterEach(() => { process.env = { ...oldEnv }; });

it('clearly distinguishes no data from a successful test day', () => {
  const report = buildDiagnosticReport(begin, end, [], 0, null);
  expect(report.text).toContain('Нет данных');
  expect(report.text).toContain('не подтверждает отсутствие ошибок');
});
it('includes device/build and call failures without treating unanswered calls as defects', () => {
  const report = buildDiagnosticReport(begin, end, [row, { ...row, eventId: 'e2', data: { outcome: 'connect_failed' } }], 2, begin);
  expect(report.text).toContain('SM-S938B');
  expect(report.text).toContain('сборка 209');
  expect(report.text).toContain('ошибка соединения: 1; без ответа: 1');
  expect(report.text).toContain('Звонки с полученным итогом: 2');
});
it('escapes HTML and discloses truncated coverage', () => {
  const report = buildDiagnosticReport(begin, end, [{ ...row, device: { ...row.device, model: '<img>' } }], 10001, begin);
  expect(report.html).not.toContain('<img>');
  expect(report.html).toContain('&lt;img&gt;');
  expect(report.text).toContain('Достигнут предел');
});
it('does not send a previous-day report before activation', async () => {
  process.env.RELEASE_DIAGNOSTICS_START_AT = '2026-11-04T12:00:00Z';
  expect(await sendDiagnosticReportIfDue(new Date('2026-11-04T17:59:59Z'))).toBe(false);
  expect(mockSendMail).not.toHaveBeenCalled();
});
it('sends the report at 21:00 Moscow with a stable daily Message-ID and marks it sent after SMTP acceptance', async () => {
  expect(await sendDiagnosticReportIfDue(end)).toBe(true);
  expect(mockSendMail).toHaveBeenCalledWith(expect.objectContaining({ to: '12345kolt@gmail.com', messageId: '<livi-diagnostics-2026-11-04@liviapp.com>' }));
  expect(ReleaseDiagnosticReport.updateOne).toHaveBeenCalledWith({ _id: '2026-11-04' }, expect.objectContaining({ $set: expect.objectContaining({ status: 'sent' }) }));
});
it('does not send if another job holds the lease or already sent that day', async () => {
  (ReleaseDiagnosticReport.findOneAndUpdate as jest.Mock).mockReturnValue({ lean: async () => { throw { code: 11000 }; } });
  expect(await sendDiagnosticReportIfDue(end)).toBe(false);
  expect(mockSendMail).not.toHaveBeenCalled();
});
it('preserves a retryable failure rather than marking a failed SMTP attempt as sent', async () => {
  mockSendMail.mockRejectedValue({ code: 'EAUTH', response: 'private provider details' });
  expect(await sendDiagnosticReportIfDue(end)).toBe(false);
  expect(ReleaseDiagnosticReport.updateOne).toHaveBeenCalledWith({ _id: '2026-11-04' }, { $set: { status: 'failed', failureCode: 'EAUTH' } });
});
it('test email uses encrypted SMTP and strips visual spaces from the app password', async () => {
  await sendDiagnosticTestEmail();
  expect(nodemailer.createTransport).toHaveBeenCalledWith(expect.objectContaining({ requireTLS: true, auth: { user: '12345kolt@gmail.com', pass: 'mockapppassword' }, logger: false, debug: false }));
  expect(mockSendMail).toHaveBeenCalledWith(expect.objectContaining({ to: '12345kolt@gmail.com', subject: '[LiVi] Проверка ежедневного отчёта' }));
});
