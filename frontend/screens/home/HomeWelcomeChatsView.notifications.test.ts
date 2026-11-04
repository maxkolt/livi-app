import { readFileSync } from 'fs';
import { join } from 'path';
import { runInNewContext } from 'vm';
import ts from 'typescript';

// Exercise the actual list selector without mounting Skia/native glass on Node.
const source = readFileSync(join(__dirname, 'HomeWelcomeChatsView.tsx'), 'utf8');
const file = ts.createSourceFile('HomeWelcomeChatsView.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let selector: ts.Node | undefined;
function find(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(file) === 'filteredChats' &&
      node.initializer && ts.isCallExpression(node.initializer)) selector = node.initializer.arguments[0];
  ts.forEachChild(node, find);
}
find(file);
if (!selector) throw new Error('Chat list selector not found');
const js = ts.transpileModule(`(${selector.getText(file)})`, {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
}).outputText;

it('never renders a notification row containing only a name and badge, then reveals the complete row', () => {
  const context = {
    allFriends: [{ id: 'peer', name: 'Alex' }, { id: 'ready', name: 'Ron' }],
    previews: { ready: { id: 'ready-message', text: 'Already ready', at: 100 } } as Record<string, { id: string; text: string; at: number }>,
    unreadByUser: { peer: 3, ready: 1 }, filter: 'unread', trimmedQuery: '',
    getFriendDisplay: (friend: { name: string }) => ({ displayName: friend.name }),
  };
  const select = runInNewContext(js, context) as () => Array<{ id: string }>;
  expect(select().map(row => row.id)).toEqual(['ready']);
  context.previews.peer = { id: 'push-latest', text: 'Newest message', at: 200 };
  expect(select().map(row => row.id)).toEqual(['peer', 'ready']);
  context.previews.peer.text = '   ';
  expect(select().map(row => row.id)).toEqual(['ready']);
});
