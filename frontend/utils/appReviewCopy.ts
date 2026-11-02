import type { Lang } from './i18n';

type ReviewCopy = { title: string; body: string; action: string; error: string };
const copy: Record<Lang, ReviewCopy> = {
  ru: { title: 'Ваш отзыв о LiVi', body: 'Поделитесь впечатлениями в Google Play. Ваша оценка и отзыв помогут нам сделать LiVi лучше.', action: 'Оставить отзыв', error: 'Не удалось открыть Google Play. Попробуйте ещё раз.' },
  en: { title: 'Your review of LiVi', body: 'Share your experience on Google Play. Your rating and review help us make LiVi better.', action: 'Leave a review', error: 'Could not open Google Play. Please try again.' },
  es: { title: 'Tu reseña de LiVi', body: 'Comparte tu experiencia en Google Play. Tu valoración y reseña nos ayudan a mejorar LiVi.', action: 'Escribir una reseña', error: 'No se pudo abrir Google Play. Inténtalo de nuevo.' },
  de: { title: 'Deine Rezension zu LiVi', body: 'Teile deine Erfahrungen auf Google Play. Deine Bewertung und Rezension helfen uns, LiVi zu verbessern.', action: 'Rezension schreiben', error: 'Google Play konnte nicht geöffnet werden. Bitte versuche es erneut.' },
  fr: { title: 'Votre avis sur LiVi', body: 'Partagez votre expérience sur Google Play. Votre note et votre avis nous aident à améliorer LiVi.', action: 'Laisser un avis', error: 'Impossible d’ouvrir Google Play. Veuillez réessayer.' },
  it: { title: 'La tua recensione di LiVi', body: 'Condividi la tua esperienza su Google Play. Il tuo voto e la tua recensione ci aiutano a migliorare LiVi.', action: 'Scrivi una recensione', error: 'Impossibile aprire Google Play. Riprova.' },
  pt: { title: 'Sua avaliação do LiVi', body: 'Compartilhe sua experiência no Google Play. Sua nota e seu comentário nos ajudam a melhorar o LiVi.', action: 'Escrever uma avaliação', error: 'Não foi possível abrir o Google Play. Tente novamente.' },
  tr: { title: 'LiVi hakkındaki yorumunuz', body: 'Deneyiminizi Google Play’de paylaşın. Puanınız ve yorumunuz LiVi’yi geliştirmemize yardımcı olur.', action: 'Yorum yaz', error: 'Google Play açılamadı. Lütfen tekrar deneyin.' },
  ar: { title: 'مراجعتك لتطبيق LiVi', body: 'شارك تجربتك على Google Play. يساعدنا تقييمك ومراجعتك على تحسين LiVi.', action: 'كتابة مراجعة', error: 'تعذّر فتح Google Play. يُرجى المحاولة مجددًا.' },
  ja: { title: 'LiViのレビュー', body: 'Google Playでご感想をお聞かせください。評価とレビューはLiViの改善に役立ちます。', action: 'レビューを書く', error: 'Google Playを開けませんでした。もう一度お試しください。' },
  ko: { title: 'LiVi에 대한 리뷰', body: 'Google Play에서 사용 경험을 공유해 주세요. 별점과 리뷰는 LiVi를 개선하는 데 도움이 됩니다.', action: '리뷰 작성', error: 'Google Play를 열 수 없습니다. 다시 시도해 주세요.' },
  zh: { title: '您对LiVi的评价', body: '在Google Play分享您的体验。您的评分和评价有助于我们改进LiVi。', action: '撰写评价', error: '无法打开Google Play，请重试。' },
  'zh-TW': { title: '您對LiVi的評論', body: '在Google Play分享您的體驗。您的評分和評論有助於我們改進LiVi。', action: '撰寫評論', error: '無法開啟Google Play，請再試一次。' },
  hi: { title: 'LiVi के बारे में आपकी समीक्षा', body: 'Google Play पर अपना अनुभव साझा करें। आपकी रेटिंग और समीक्षा से हमें LiVi को बेहतर बनाने में मदद मिलती है।', action: 'समीक्षा लिखें', error: 'Google Play नहीं खुल सका। कृपया फिर कोशिश करें।' },
  vi: { title: 'Bài đánh giá của bạn về LiVi', body: 'Chia sẻ trải nghiệm trên Google Play. Điểm xếp hạng và bài đánh giá giúp chúng tôi cải thiện LiVi.', action: 'Viết bài đánh giá', error: 'Không thể mở Google Play. Vui lòng thử lại.' },
  th: { title: 'รีวิว LiVi ของคุณ', body: 'แบ่งปันประสบการณ์บน Google Play คะแนนและรีวิวของคุณช่วยให้เราพัฒนา LiVi ได้ดียิ่งขึ้น', action: 'เขียนรีวิว', error: 'เปิด Google Play ไม่ได้ โปรดลองอีกครั้ง' },
  id: { title: 'Ulasan Anda tentang LiVi', body: 'Bagikan pengalaman Anda di Google Play. Rating dan ulasan Anda membantu kami menyempurnakan LiVi.', action: 'Tulis ulasan', error: 'Google Play tidak dapat dibuka. Silakan coba lagi.' },
};

export const appReviewCopy = (lang: Lang): ReviewCopy => copy[lang] ?? copy.en;
