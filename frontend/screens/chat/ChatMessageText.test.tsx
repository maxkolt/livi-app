import React from 'react';
const mockOpenUrl = jest.fn(async (_url: string) => undefined);
jest.mock('react-native', () => ({ Text: 'Text', Linking: { openURL: mockOpenUrl } }));
import { ChatMessageText } from './ChatMessageText';

type TextNode = React.ReactElement<{ children?: React.ReactNode; onPress?: () => void; onLongPress?: () => void }>;
function textContent(node: React.ReactNode): string {
  if (typeof node === 'string') return node;
  if (!React.isValidElement<{ children?: React.ReactNode }>(node)) return '';
  return React.Children.toArray(node.props.children).map(textContent).join('');
}

it('renders the entire multiline caption once and keeps links and message long press working', async () => {
  const caption = 'Подпись под фото\nссылка www.example.com и https://example.com/photo';
  const openMessageActions = jest.fn();
  const tree = ChatMessageText({
    text: caption, style: { marginTop: 8, paddingHorizontal: 4, fontSize: 15 },
    linkColor: '#62b0d8', onLongPressLink: openMessageActions,
  });
  expect(textContent(tree)).toBe(caption);
  const links = (React.Children.toArray(tree.props.children) as TextNode[]).filter(node => node.props.onPress);
  expect(links).toHaveLength(2);
  links[0].props.onPress!();
  links[1].props.onPress!();
  await Promise.resolve();
  expect(mockOpenUrl.mock.calls).toEqual([['https://www.example.com'], ['https://example.com/photo']]);
  links[0].props.onLongPress!();
  expect(openMessageActions).toHaveBeenCalledTimes(1);
});


it('disables caption links while album photos are being selected', () => {
  const tree = ChatMessageText({
    text: 'Подпись https://example.com', style: {}, linkColor: '#62b0d8',
    onLongPressLink: jest.fn(), linksDisabled: true,
  });
  const nodes = React.Children.toArray(tree.props.children) as TextNode[];
  expect(textContent(tree)).toBe('Подпись https://example.com');
  expect(nodes.every(node => !node.props.onPress && !node.props.onLongPress)).toBe(true);
});
