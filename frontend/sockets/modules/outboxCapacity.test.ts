import { assertOutboxCapacity, MAX_OUTBOX_METADATA_BYTES, utf8ByteLength } from './outboxCapacity';

describe('Android offline queue metadata capacity', () => {
  it.each(['text', 'Привет', '🙂', '\ud800', '\udc00', 'a🙂Бя'])('counts UTF-8 bytes for %p without native encoders', (value) => {
    expect(utf8ByteLength(value)).toBe(Buffer.byteLength(value, 'utf8'));
  });

  it('allows the exact metadata limit and rejects growth by one byte', () => {
    const overhead = Buffer.byteLength(JSON.stringify(['']));
    const text = 'x'.repeat(MAX_OUTBOX_METADATA_BYTES - overhead);
    expect(() => assertOutboxCapacity([text])).not.toThrow();
    expect(() => assertOutboxCapacity([`${text}x`])).toThrow('outbox_full');
    expect(() => assertOutboxCapacity(['Я'.repeat(MAX_OUTBOX_METADATA_BYTES / 2)])).toThrow('outbox_full');
  });
});
