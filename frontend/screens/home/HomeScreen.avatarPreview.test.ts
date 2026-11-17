import { readFileSync } from 'fs';
import { join } from 'path';
import { runInNewContext } from 'vm';
import ts from 'typescript';
import { isLocalAvatarUri } from './selfAvatarDisplay';

const source = readFileSync(join(__dirname, '../HomeScreen.tsx'), 'utf8');
const file = ts.createSourceFile('HomeScreen.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let handler: ts.ArrowFunction | undefined;
function find(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(file) === 'handleMyAvatar' &&
    node.initializer && ts.isArrowFunction(node.initializer)) handler = node.initializer;
  ts.forEachChild(node, find);
}
find(file);
if (!handler) throw new Error('Own avatar event handler not found');
const javascript = ts.transpileModule(`(${handler.getText(file)})`, {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
}).outputText;

it.each(['file:///picked.jpg', 'content://media/123', 'ph://picked', 'assets-library://picked'])(
  'keeps the selected %s painted while the saved server photo is being resolved', async selected => {
    let preview = selected;
    let full = '';
    const putFull = jest.fn().mockResolvedValue(undefined);
    const receive = runInNewContext(javascript, {
      getCurrentUserId: () => 'self', applyAvatarVer: jest.fn(),
      AsyncStorage: { setItem: async () => {} },
      setMyFullAvatarUri: (value: string) => { full = value; },
      setAvatarUri: (action: string | ((previous: string) => string)) => {
        preview = typeof action === 'function' ? action(preview) : action;
      },
      isLocalAvatarUri, putFull, console,
    }) as (event: { userId: string; avatarVer: number; avatarB64: string }) => Promise<void>;
    await receive({ userId: 'self', avatarVer: 5, avatarB64: 'data:image/jpeg;base64,saved' });
    expect(preview).toBe(selected);
    expect(full).toBe('data:image/jpeg;base64,saved');
    expect(putFull).toHaveBeenCalledWith('self', 5, full);
  },
);
