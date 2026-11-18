import { readFileSync } from 'fs';
import { join } from 'path';
import { runInNewContext } from 'vm';
import ts from 'typescript';
import { preparePhotoComposeSelection } from '../utils/photoCompose';

// Exercise the real event handler without mounting camera/editor/native gestures.
const source = readFileSync(join(__dirname, 'MediaViewer.tsx'), 'utf8');
const file = ts.createSourceFile('MediaViewer.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let handler: ts.ArrowFunction | undefined;
let closeHandler: ts.ArrowFunction | undefined;
function find(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'sendSelection' && node.initializer && ts.isArrowFunction(node.initializer)) handler = node.initializer;
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'requestClose' && node.initializer && ts.isCallExpression(node.initializer) && ts.isArrowFunction(node.initializer.arguments[0])) closeHandler = node.initializer.arguments[0];
  ts.forEachChild(node, find);
}
find(file);
if (!handler || !closeHandler) throw new Error('Photo composer handlers not found');
const js = ts.transpileModule(`(${handler.getText(file)})`, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;
const closeJs = ts.transpileModule(`(${closeHandler.getText(file)})`, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;

function composer() {
  const onSend = jest.fn();
  const busy = jest.fn();
  const dismiss = jest.fn();
  let finish!: (width: number, height: number) => void;
  const state = {
    onSend, busy: false, sendInFlightRef: { current: false },
    visibleRef: { current: true }, composeGenerationRef: { current: 1 },
    displayUris: ['file:///edited.jpg'], assets: [], caption: 'Подпись 📦\nТекст',
    setBusy: busy, Keyboard: { dismiss }, preparePhotoComposeSelection,
    onClose: jest.fn(),
    Image: { getSize: jest.fn((_uri, success) => { finish = success; }) },
  };
  const send = runInNewContext(js, state) as () => Promise<void>;
  const close = runInNewContext(closeJs, state) as () => void;
  return { state, send, close, onSend, busy, dismiss, finish: () => finish(900, 1600) };
}

it('waits for final dimensions and sends a selected album only once despite repeated taps', async () => {
  const c = composer();
  const job = c.send();
  await c.send();
  expect(c.onSend).not.toHaveBeenCalled();
  c.finish(); await job;
  expect(c.onSend).toHaveBeenCalledWith({ assets: [{ uri: 'file:///edited.jpg', width: 900, height: 1600 }], caption: c.state.caption });
  await c.send();
  expect(c.onSend).toHaveBeenCalledTimes(1);
  expect(c.dismiss).toHaveBeenCalledTimes(1);
});

it('does not send an edited photo if the viewer is closed during preparation', async () => {
  const c = composer();
  const job = c.send();
  c.state.visibleRef.current = false;
  c.finish(); await job;
  expect(c.onSend).not.toHaveBeenCalled();
  expect(c.state.sendInFlightRef.current).toBe(false);
});

it('cannot hand an old prepared photo to a newly opened composer', async () => {
  const c = composer();
  const job = c.send();
  c.state.composeGenerationRef.current++;
  c.state.sendInFlightRef.current = false;
  c.finish(); await job;
  expect(c.onSend).not.toHaveBeenCalled();
  expect(c.busy.mock.calls).toEqual([[true]]);
});

it('invalidates a pending send immediately when Close is pressed, before the visibility render', async () => {
  const c = composer();
  const job = c.send();
  c.close();
  expect(c.state.onClose).toHaveBeenCalledTimes(1);
  c.finish(); await job;
  expect(c.onSend).not.toHaveBeenCalled();
  expect(c.state.visibleRef.current).toBe(false);
});
