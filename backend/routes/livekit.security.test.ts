import type { NextFunction, Request, Response, Router } from 'express';

const mockGrant = jest.fn();
const mockJwt = jest.fn(async () => 'isolated-test-token');
jest.mock('livekit-server-sdk', () => ({ AccessToken: jest.fn().mockImplementation(() => ({
  addGrant: mockGrant, toJwt: mockJwt,
})) }));
jest.mock('../utils/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('../utils/capacityMetrics', () => ({ recordTokenSuccess: jest.fn(), recordTokenFailure: jest.fn() }));

const A = '64b000000000000000000001';
const B = '64b000000000000000000002';
const OUTSIDER = '64b000000000000000000003';
let router: Router;
let isAllowedParticipant: (roomName: string, userId: string) => boolean;

beforeAll(() => {
  const previous = { key: process.env.LIVEKIT_API_KEY, secret: process.env.LIVEKIT_API_SECRET };
  process.env.LIVEKIT_API_KEY = 'isolated-test-key';
  process.env.LIVEKIT_API_SECRET = 'isolated-test-secret';
  try {
    const loaded = require('./livekit') as typeof import('./livekit');
    router = loaded.default;
    isAllowedParticipant = loaded.isAllowedParticipant;
  } finally {
    if (previous.key === undefined) delete process.env.LIVEKIT_API_KEY;
    else process.env.LIVEKIT_API_KEY = previous.key;
    if (previous.secret === undefined) delete process.env.LIVEKIT_API_SECRET;
    else process.env.LIVEKIT_API_SECRET = previous.secret;
  }
});
beforeEach(() => jest.clearAllMocks());

async function tokenRequest(roomName: unknown, trustedUserId = OUTSIDER) {
  const route = router.stack.find(layer => layer.route?.path === '/livekit/token')!.route!;
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  await route.stack[0].handle({ userId: trustedUserId, body: { roomName }, app: { locals: {} } } as unknown as Request,
    res as unknown as Response, (() => {}) as NextFunction);
  return res;
}

it.each(['room', 'rand_room'])('rejects third-party token issuance for a %s call', async prefix => {
  const roomName = `${prefix}_${A}_${B}`;
  expect(isAllowedParticipant(roomName, OUTSIDER)).toBe(false);
  const response = await tokenRequest(roomName);
  expect(response.status).toHaveBeenCalledWith(403);
  expect(response.json).toHaveBeenCalledWith({ ok: false, error: 'not_participant' });
  expect(mockJwt).not.toHaveBeenCalled();
  expect(mockGrant).not.toHaveBeenCalled();
});

it.each([
  'custom-room', `room_socket-a_socket-b`, `rand_room_${A}`, `room_${A}_${B}_extra`,
  `rand_room_${A}_${B}/suffix`, `room_${A}_${'g'.repeat(24)}`, '',
])('rejects unknown or malformed room names: %s', roomName => {
  expect(isAllowedParticipant(roomName, A)).toBe(false);
});

it.each(['room', 'rand_room'])('preserves token refresh for either member of a %s call', async prefix => {
  const roomName = `${prefix}_${A}_${B}`;
  for (const member of [A, B]) {
    const response = await tokenRequest(roomName, member);
    expect(response.status).not.toHaveBeenCalled();
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ ok: true, token: 'isolated-test-token' }));
    expect(mockGrant).toHaveBeenLastCalledWith({ roomJoin: true, room: roomName, canPublish: true, canSubscribe: true });
  }
});

it('rejects custom-room token creation even for an authenticated user', async () => {
  const response = await tokenRequest('custom-room', A);
  expect(response.status).toHaveBeenCalledWith(403);
  expect(mockJwt).not.toHaveBeenCalled();
});

it('requires authenticated installation ownership before token creation', async () => {
  const response = await tokenRequest(`rand_room_${A}_${B}`, '');
  expect(response.status).toHaveBeenCalledWith(401);
  expect(mockJwt).not.toHaveBeenCalled();
});
