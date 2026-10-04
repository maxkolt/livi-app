import { requireNativeComponent, type HostComponent } from 'react-native';

/**
 * requireNativeComponent регистрирует имя глобально, и повторный вызов падает
 * «Tried to register two views with the same name». Fast Refresh перевыполняет модуль
 * с таким вызовом — красный экран в dev. Кэш на global переживает перевыполнение.
 */
export function requireNativeComponentOnce<P extends object>(name: string): HostComponent<P> {
  const g = global as { __liviNativeViews?: Record<string, HostComponent<any>> };
  const cache = (g.__liviNativeViews ??= {});
  return (cache[name] ??= requireNativeComponent<P>(name));
}
