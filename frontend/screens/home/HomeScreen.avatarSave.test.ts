import { readFileSync } from 'fs';
import { join } from 'path';
import { runInNewContext } from 'vm';
import ts from 'typescript';

// Execute the actual save handler: success feedback must depend on upload ACKs,
// including the HTTP fallback, rather than on the local photo preview.
const source = readFileSync(join(__dirname, '../HomeScreen.tsx'), 'utf8');
const file = ts.createSourceFile('HomeScreen.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let handler: ts.ArrowFunction | undefined;
function find(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(file) === 'handleSaveProfile' &&
    node.initializer && ts.isArrowFunction(node.initializer)) handler = node.initializer;
  ts.forEachChild(node, find);
}
find(file);
if (!handler) throw new Error('Profile save handler not found');
const javascript = ts.transpileModule(`(${handler.getText(file)})`, {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
}).outputText;

function setup({ socketOk = true, httpOk = true, storageOk = true, uri = 'file:///new-avatar.jpg' } = {}) {
  const feedback = jest.fn();
  const upload = jest.fn().mockImplementation(() => httpOk
    ? Promise.resolve({ avatarVer: 5 }) : Promise.reject(new Error('offline')));
  const alert = jest.fn();
  const storage = jest.fn().mockImplementation(() => storageOk ? Promise.resolve() : Promise.reject(new Error('disk full')));
  const save = runInNewContext(javascript, {
    savingRef: { current: false }, Date, setTimeout, clearTimeout,
    setSaving: jest.fn(), getCurrentUserId: () => 'self', ensureIdentity: jest.fn(),
    nickLiveRef: { current: 'Nick' }, nick: 'Nick', savedNick: 'Nick',
    avatarUri: uri, savedAvatarUrl: '', normalizeLocalImageUri: async (value: string) => value,
    imageToBase64: async () => 'new-image',
    socket: { emit: (_event: string, _payload: unknown, ack: (value: unknown) => void) => ack({ ok: socketOk, avatarVer: socketOk ? 5 : undefined }) },
    uploadAvatarAndSave: upload, applyAvatarVer: jest.fn(), AsyncStorage: { setItem: async () => {} },
    getFull: async () => '', setMyFullAvatarUri: jest.fn(), setSavedAvatarUrl: jest.fn(),
    saveProfileToStorage: storage, saveDraftProfile: async () => {}, updateProfile: async () => ({ ok: true }),
    pendingAttachRef: { current: null }, attachIdentitySafe: async () => {}, installId: 'install',
    setSavedNickDebug: jest.fn(), ExpoImage: { prefetch: jest.fn() }, toAvatarThumb: (value: string) => value,
    setSavedToast: jest.fn(), setAvatarSaveSuccessId: feedback, showAppAlert: alert,
    t: (key: string) => key, lang: 'ru', logger: { warn: jest.fn() }, console: { error: jest.fn(), warn: jest.fn() },
  }) as () => Promise<void>;
  return { save, feedback, upload, alert };
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());
async function finish(save: () => Promise<void>) {
  const pending = save();
  await jest.runAllTimersAsync();
  await pending;
}

it('confirms a successfully uploaded and saved avatar exactly once', async () => {
  const run = setup();
  await finish(run.save);
  expect(run.feedback).toHaveBeenCalledTimes(1);
  expect(run.feedback.mock.calls[0][0](3)).toBe(4);
  expect(run.upload).not.toHaveBeenCalled();
});

it('confirms the avatar after a successful HTTP fallback', async () => {
  const run = setup({ socketOk: false });
  await finish(run.save);
  expect(run.upload).toHaveBeenCalledWith('file:///new-avatar.jpg');
  expect(run.feedback).toHaveBeenCalledTimes(1);
});

it('never confirms a preview when both upload paths fail', async () => {
  const run = setup({ socketOk: false, httpOk: false });
  await finish(run.save);
  expect(run.feedback).not.toHaveBeenCalled();
  expect(run.alert).toHaveBeenCalledWith('errorTitle', 'avatarUploadFailed');
});

it('does not confirm when local persistence fails after upload', async () => {
  const run = setup({ storageOk: false });
  await finish(run.save);
  expect(run.feedback).not.toHaveBeenCalled();
});

it('does not show avatar confirmation for a profile save without a new photo', async () => {
  const run = setup({ uri: '' });
  await finish(run.save);
  expect(run.feedback).not.toHaveBeenCalled();
});
