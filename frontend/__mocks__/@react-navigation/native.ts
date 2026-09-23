// Мок @react-navigation/native для юнит-тестов (testEnvironment: 'node').
// Реальный пакет — ESM. Тестам логики нужны только action-креаторы: они чистые
// и возвращают описание действия, которое код передаёт в навигатор.

export const CommonActions = {
  navigate: (...args: any[]) => ({ type: 'NAVIGATE', payload: args[0] }),
  goBack: () => ({ type: 'GO_BACK' }),
  reset: (state: any) => ({ type: 'RESET', payload: state }),
  setParams: (params: any) => ({ type: 'SET_PARAMS', payload: { params } }),
};

export const StackActions = {
  pop: (count = 1) => ({ type: 'POP', payload: { count } }),
  push: (name: string, params?: any) => ({ type: 'PUSH', payload: { name, params } }),
  replace: (name: string, params?: any) => ({ type: 'REPLACE', payload: { name, params } }),
};

export const useIsFocused = () => true;
export const useFocusEffect = (_effect: unknown) => {};
export const useNavigation = () => ({
  navigate: () => {},
  goBack: () => {},
  dispatch: () => {},
  setParams: () => {},
  addListener: () => () => {},
});
export const useRoute = () => ({ params: {} });
