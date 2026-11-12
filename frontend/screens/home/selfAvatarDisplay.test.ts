import { getSearchAvatarDisplayUri } from './selfAvatarDisplay';

const saved = {
  avatarUri: '', myFullAvatarUri: 'data:image/jpeg;base64,old', savedAvatarUrl: '',
  resolvedAvatarUri: '', resolvedAvatarReady: true,
  myFullAvatarResolvedUri: 'file:///old-saved.jpg', myFullAvatarResolvedReady: true,
  isAndroid: true,
};

it('uses the newly selected photo on the first Search frame while the previous avatar is still saved', () => {
  expect(getSearchAvatarDisplayUri({ ...saved, avatarUri: 'file:///new-selection.jpg',
    resolvedAvatarUri: 'file:///new-selection.jpg' })).toBe('file:///new-selection.jpg');
});

it('does not let an old resolved file displace a new selection before effects run', () => {
  expect(getSearchAvatarDisplayUri({ ...saved, avatarUri: 'file:///latest-selection.jpg',
    resolvedAvatarUri: 'file:///older-selection.jpg', resolvedAvatarReady: false })).toBe('file:///latest-selection.jpg');
});

it('returns to the saved avatar after the preview is cleared', () => {
  expect(getSearchAvatarDisplayUri(saved)).toBe('file:///old-saved.jpg');
  expect(getSearchAvatarDisplayUri({ ...saved, myFullAvatarUri: 'data:image/jpeg;base64,new',
    myFullAvatarResolvedUri: 'file:///new-saved.jpg' })).toBe('file:///new-saved.jpg');
});

it('waits for Android data conversion and leaves an iOS data URI displayable', () => {
  const loading = { ...saved, myFullAvatarResolvedReady: false, resolvedAvatarUri: '', resolvedAvatarReady: false };
  expect(getSearchAvatarDisplayUri(loading)).toBe('');
  expect(getSearchAvatarDisplayUri({ ...loading, isAndroid: false })).toBe(saved.myFullAvatarUri);
});
