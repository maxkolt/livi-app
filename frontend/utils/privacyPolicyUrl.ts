/** Публичная политика конфиденциальности (Google Play / сплеш). Переопределение: EXPO_PUBLIC_PRIVACY_POLICY_URL */
export function getPrivacyPolicyUrl(): string {
  return (process.env.EXPO_PUBLIC_PRIVACY_POLICY_URL || '').trim() || 'https://maxkolt.github.io/livi-app/';
}
