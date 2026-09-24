/** Текст на месте сообщения, которое не удалось расшифровать (на языке интерфейса). */
export function e2eUndecryptableText(): string {
  try {
    // Лениво: сокет-модули не должны тянуть i18n и стор при импорте.
    const { t } = require("../../utils/i18n");
    const { useLang } = require("../../store/lang");
    return t("e2eUndecryptable", useLang.getState().lang);
  } catch {
    return "🔒 Message could not be decrypted";
  }
}
