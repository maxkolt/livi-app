import { diagnosticDeviceAllowed, diagnosticDeviceKey, diagnosticReportWindow, sanitizeDiagnosticData,
  sanitizeDiagnosticDevice, sanitizeDiagnosticEvent } from './releaseDiagnostics';

const now = Date.parse('2026-11-04T12:00:00Z');
const event = { id: 's_1', session: 's1', event: 'call_outcome', level: 'info', at: now, data: {} };
const previousModels = process.env.RELEASE_DIAGNOSTICS_MODELS;
const previousIds = process.env.RELEASE_DIAGNOSTICS_INSTALL_IDS;
afterEach(() => {
  if (previousModels === undefined) delete process.env.RELEASE_DIAGNOSTICS_MODELS; else process.env.RELEASE_DIAGNOSTICS_MODELS = previousModels;
  if (previousIds === undefined) delete process.env.RELEASE_DIAGNOSTICS_INSTALL_IDS; else process.env.RELEASE_DIAGNOSTICS_INSTALL_IDS = previousIds;
});

it('removes message content, addresses, secrets, arbitrary nested data and raw errors', () => {
  expect(sanitizeDiagnosticData({ text: 'private message', token: 'secret', uri: 'https://private',
    reason: 'mail@example.com', code: 'https://server/?token=secret', phase: 'reconnected',
    durationMs: 2500, ok: true, count: Infinity, nested: { secret: 'password' } })).toEqual({ phase: 'reconnected', durationMs: 2500, ok: true });
});
it('validates event timestamps and identity while stripping extra data', () => {
  expect(sanitizeDiagnosticEvent({ ...event, text: 'private', data: { phase: 'active', text: 'secret' } }, now)).toEqual({ ...event, data: { phase: 'active' } });
  expect(sanitizeDiagnosticEvent({ ...event, at: now + 301_000 }, now)).toBeNull();
  expect(sanitizeDiagnosticEvent({ ...event, at: now - 31 * 86400_000 }, now)).toBeNull();
  expect(sanitizeDiagnosticEvent({ ...event, id: '<script>' }, now)).toBeNull();
  expect(sanitizeDiagnosticEvent({ ...event, level: 'admin' }, now)).toBeNull();
});
it('accepts only LiVi packages and numeric build numbers', () => {
  const device = { model: 'SM-S938B', manufacturer: 'Samsung', os: '16', version: '1.1.22', build: '209', packageName: 'com.kolt12max.livi' };
  expect(sanitizeDiagnosticDevice(device)).toEqual(device);
  expect(sanitizeDiagnosticDevice({ ...device, packageName: 'other.app' })).toBeNull();
  expect(sanitizeDiagnosticDevice({ ...device, build: 'abc' })).toBeNull();
});
it('is disabled without an explicit model or installation and gives installation IDs precedence', () => {
  delete process.env.RELEASE_DIAGNOSTICS_MODELS; delete process.env.RELEASE_DIAGNOSTICS_INSTALL_IDS;
  expect(diagnosticDeviceAllowed('inst1', 'SM-S938B')).toBe(false);
  process.env.RELEASE_DIAGNOSTICS_MODELS = 'sm-s938b';
  expect(diagnosticDeviceAllowed('inst1', 'SM-S938B')).toBe(true);
  process.env.RELEASE_DIAGNOSTICS_INSTALL_IDS = 'inst2';
  expect(diagnosticDeviceAllowed('inst1', 'SM-S938B')).toBe(false);
  expect(diagnosticDeviceAllowed('inst2', 'anything')).toBe(true);
});
it('hashes installation IDs so reports do not disclose raw device identifiers', () => {
  expect(diagnosticDeviceKey('inst1')).toMatch(/^[a-f0-9]{24}$/);
  expect(diagnosticDeviceKey('inst1')).not.toBe(diagnosticDeviceKey('inst2'));
});
it.each([
  ['2026-11-04T17:59:59Z', '2026-11-03'], ['2026-11-04T18:00:00Z', '2026-11-04'],
  ['2026-11-04T22:00:00Z', '2026-11-04'], ['2027-01-01T00:00:00Z', '2026-12-31'],
])('uses 21:00 Moscow for %s', (at, key) => {
  const window = diagnosticReportWindow(new Date(at));
  expect(window.key).toBe(key);
  expect(window.end.getUTCHours()).toBe(18);
  expect(window.end.getTime() - window.start.getTime()).toBe(86400_000);
});
