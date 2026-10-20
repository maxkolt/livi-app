import { mergePendingOutboxIntoMessages, messageFromPendingOutboxItem } from './outboxPendingRows';

describe('outboxPendingRows', () => {
  it('builds a text bubble from a pending outbox item', () => {
    const built = messageFromPendingOutboxItem(
      {
        id: 'outbox_1',
        optimisticUiId: '111-abc',
        createdAt: 1_700_000_000_000,
        payload: { to: 'peer', type: 'text', text: 'hi', clientMessageId: '111-abc' },
      },
      'me',
    );
    expect(built?.statusId).toBe('111-abc');
    expect(built?.message).toMatchObject({
      id: '111-abc',
      text: 'hi',
      type: 'text',
      sender: 'me',
      from: 'me',
      to: 'peer',
    });
  });

  it('merges missing pending audio into an empty local list', () => {
    const { messages, sendingIds } = mergePendingOutboxIntoMessages(
      [],
      [
        {
          id: 'outbox_a',
          optimisticUiId: '222-xyz',
          createdAt: 1,
          payload: {
            to: 'peer',
            type: 'audio',
            localUri: 'file:///v.m4a',
            name: 'voice.m4a',
            clientMessageId: '222-xyz',
          },
        },
      ],
      'me',
    );
    expect(sendingIds).toEqual(['222-xyz']);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ id: '222-xyz', type: 'audio', uri: 'file:///v.m4a' });
  });

  it('does not duplicate an already visible pending row', () => {
    const { messages, sendingIds } = mergePendingOutboxIntoMessages(
      [{ id: '222-xyz', type: 'text', text: 'hi', sender: 'me' }],
      [
        {
          id: 'outbox_a',
          optimisticUiId: '222-xyz',
          createdAt: 1,
          payload: { to: 'peer', type: 'text', text: 'hi', clientMessageId: '222-xyz' },
        },
      ],
      'me',
    );
    expect(messages).toHaveLength(1);
    expect(sendingIds).toEqual(['222-xyz']);
  });
});
