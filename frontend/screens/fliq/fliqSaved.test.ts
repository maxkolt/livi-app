const storage = new Map<string, string>();

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async (key: string) => storage.get(key) ?? null),
  setItem: jest.fn(async (key: string, value: string) => {
    storage.set(key, value);
  }),
}));

import AsyncStorage from '@react-native-async-storage/async-storage';
import type { FliqItem } from './fliqApi';
import { useFliqSaved } from './fliqSaved';

const video: FliqItem = {
  id: 'CEJXqm2eiJ0',
  source: 'youtube',
  title: 'Example #shorts',
  author: 'LiVi',
  durationSec: 18,
  topics: ['humor'],
};

describe('Fliq saved videos', () => {
  beforeEach(() => {
    storage.clear();
    jest.clearAllMocks();
    useFliqSaved.setState({ items: [], hydrated: false });
  });

  it('saves, unsaves and persists a video', () => {
    useFliqSaved.getState().toggle(video);

    expect(useFliqSaved.getState().items).toHaveLength(1);
    expect(useFliqSaved.getState().items[0]).toMatchObject(video);
    expect(AsyncStorage.setItem).toHaveBeenCalledTimes(1);

    useFliqSaved.getState().toggle(video);
    expect(useFliqSaved.getState().items).toEqual([]);
    expect(AsyncStorage.setItem).toHaveBeenCalledTimes(2);
  });

  it('hydrates only valid YouTube entries', async () => {
    storage.set('fliq_saved_v1', JSON.stringify([
      { ...video, savedAt: 123 },
      { id: '', source: 'youtube' },
      { id: 'bad', source: 'tiktok' },
    ]));

    await useFliqSaved.getState().hydrate();

    expect(useFliqSaved.getState().hydrated).toBe(true);
    expect(useFliqSaved.getState().items).toEqual([{ ...video, savedAt: 123 }]);
  });

  it('removes a saved video', () => {
    useFliqSaved.setState({ items: [{ ...video, savedAt: 123 }], hydrated: true });
    useFliqSaved.getState().remove(video.id);

    expect(useFliqSaved.getState().items).toEqual([]);
    expect(AsyncStorage.setItem).toHaveBeenCalledWith('fliq_saved_v1', '[]');
  });
});
