import React from 'react';
import { readFileSync } from 'fs';
import { join } from 'path';
import { runInNewContext } from 'vm';
import ts from 'typescript';

// Render the production nickname row without starting native profile/Skia modules.
const source = readFileSync(join(__dirname, 'HomeWelcomeProfileView.tsx'), 'utf8');
const file = ts.createSourceFile('HomeWelcomeProfileView.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let visibility: ts.Expression | undefined;
let row: ts.JsxElement | undefined;
function findSource(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(file) === 'nicknameActionsVisible') {
    visibility = node.initializer;
  }
  if (ts.isJsxElement(node) && node.openingElement.tagName.getText(file) === 'View' &&
      node.openingElement.attributes.getText(file).includes('styles.inlineNickRow,')) row = node;
  ts.forEachChild(node, findSource);
}
findSource(file);
if (!visibility || !row) throw new Error('Production nickname row not found');
const script = ts.transpileModule(`(function () {
  const nicknameActionsVisible = ${visibility.getText(file)};
  return (${row.getText(file)});
})`, { compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2020 } }).outputText;

type RowProps = {
  testID?: string;
  children?: React.ReactNode;
  onFocus?: () => void;
  onBlur?: () => void;
  onChangeText?: (value: string) => void;
};
function find(node: React.ReactNode, id: string): React.ReactElement<RowProps> | undefined {
  if (!React.isValidElement<RowProps>(node)) return;
  if (node.props.testID === id) return node;
  return React.Children.toArray(node.props.children).map(child => find(child, id)).find(Boolean);
}
function fixture() {
  const state = {
    React, View: 'View', TextInput: 'TextInput', Pressable: 'Pressable', Ionicons: 'Icon',
    styles: {}, isTablet: false, compactLandscape: false, hubMetrics: { rowHeight: 44 },
    accountOpen: false, nick: 'Saved nickname', savedNick: 'Saved nickname', savedToast: false,
    busy: false, saving: false, nicknameActionSize: 32, nicknameInputRef: { current: null },
    lang: 'ru', t: (key: string) => key, APP_INPUT_MAX_FONT_SIZE_MULTIPLIER: 1.2,
    UI_ACCENT: '#fff', WELCOME_PROFILE_ROW_ICON: '#fff', WELCOME_MUTED_TEXT: '#aaa',
    setAccountOpen: (value: boolean) => { state.accountOpen = value; },
    setNick: (value: string) => { state.nick = value; },
    setSavedToast: (value: boolean) => { state.savedToast = value; },
    saveNickname: jest.fn(), deleteNickname: jest.fn(),
  };
  const render = runInNewContext(script, state) as () => React.ReactNode;
  const actions = () => ['profile-nickname-save', 'profile-nickname-clear']
    .filter(id => !!find(render(), id));
  return { state, render, actions };
}

it('keeps nickname save/delete hidden throughout avatar autosave and its success feedback', () => {
  const { state, actions } = fixture();
  expect(actions()).toEqual([]);
  state.busy = state.saving = true;
  expect(actions()).toEqual([]);
  state.busy = state.saving = false;
  state.savedToast = true;
  expect(actions()).toEqual([]);
  state.savedToast = false;
  expect(actions()).toEqual([]);
});

it('shows actions when the nickname is deliberately focused, then hides them on blur without edits', () => {
  const { state, render, actions } = fixture();
  state.savedToast = true;
  find(render(), 'profile-nickname-input')!.props.onFocus!();
  expect(actions()).toEqual(['profile-nickname-save', 'profile-nickname-clear']);
  find(render(), 'profile-nickname-input')!.props.onBlur!();
  expect(actions()).toEqual([]);
});

it('preserves the actions for an unsaved nickname after the input loses focus', () => {
  const { render, actions } = fixture();
  const input = find(render(), 'profile-nickname-input')!;
  input.props.onFocus!();
  input.props.onChangeText!('Edited nickname');
  input.props.onBlur!();
  expect(actions()).toEqual(['profile-nickname-save', 'profile-nickname-clear']);
});

it('leaves only the pencil after the edited nickname finishes saving', () => {
  const { state, render, actions } = fixture();
  find(render(), 'profile-nickname-input')!.props.onFocus!();
  find(render(), 'profile-nickname-input')!.props.onChangeText!('Edited nickname');
  expect(find(render(), 'profile-nickname-edit')).toBeUndefined();
  // Profile save closes the input, then publishes the persisted nickname.
  state.accountOpen = false;
  state.savedNick = state.nick;
  state.savedToast = true;
  expect(actions()).toEqual([]);
  expect(find(render(), 'profile-nickname-edit')).toBeDefined();
  expect(find(render(), 'profile-nickname-input')!.props).toMatchObject({ value: 'Edited nickname' });
});
