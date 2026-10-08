import type { Lang } from '../tenancy/context.js';

export type AiChoice = 'gemini' | 'openai' | 'anthropic';
export const AI_CHOICES: readonly AiChoice[] = ['gemini', 'openai', 'anthropic'];

export const AI_LABEL: Record<AiChoice, string> = {
  gemini: '✨ Google Gemini',
  openai: '🟢 OpenAI (ChatGPT)',
  anthropic: '🟠 Anthropic (Claude)',
};

const KEY_URL: Record<AiChoice, string> = {
  gemini: 'https://aistudio.google.com/apikey',
  openai: 'https://platform.openai.com/api-keys',
  anthropic: 'https://console.anthropic.com/settings/keys',
};

interface Texts {
  welcome: string;
  chooseLang: string;
  chooseAi: string;
  sendKey: (ai: AiChoice) => string;
  checking: string;
  keyInvalid: string;
  keyCheckFailed: string;
  keyOk: (ai: AiChoice) => string;
  consent: string;
  agree: string;
  cancel: string;
  back: string;
  restart: string;
  submitted: string;
  pending: string;
  rejected: string;
  suspended: string;
  cancelled: string;
  approved: string;
  sendText: string;
  full: string;
  reopened: string;
  unavailable: string;
  tooMany: string;
}

/** Owner-facing onboarding texts (HTML; nothing untrusted is interpolated). */
export const T: Record<Lang, Texts> = {
  uz: {
    welcome:
      '👋 <b>Assalomu alaykum!</b>\n\nMen — Telegram uchun <b>AI avtojavob yordamchisi</b>. Siz band bo‘lganingizda akkauntingizga kelgan xabarlarga sizning uslubingizda javob beraman, shaxsiy savollarni esa sizga yuboraman.\n\nBoshlash uchun bir necha qadam sozlaymiz.',
    chooseLang: '🌐 Tilni tanlang:',
    chooseAi: '🤖 Qaysi AI ishlatasiz?\n\nAI kalitingiz faqat sizniki bo‘ladi va xarajatlar ham shu kalit hisobidan.',
    sendKey: (ai) =>
      `🔑 <b>${AI_LABEL[ai]}</b> API kalitingizni yuboring.\n\nKalitni bu yerdan olasiz: ${KEY_URL[ai]}\n\n<i>Xavfsizlik uchun xabaringiz tekshirilgach chatdan o‘chiriladi; kalit shifrlangan holda saqlanadi.</i>`,
    checking: '⏳ Kalit tekshirilmoqda…',
    keyInvalid: '❌ Bu API kalit noto‘g‘ri. Tekshirib, qaytadan yuboring (yoki boshqa AI tanlang).',
    keyCheckFailed: '⚠️ Kalitni hozir tekshirib bo‘lmadi (tarmoq yoki AI xizmati javob bermadi). Birozdan keyin qaytadan yuboring.',
    keyOk: (ai) => `✅ ${AI_LABEL[ai]} kaliti to‘g‘ri!`,
    consent:
      '📋 <b>Qisqacha qanday ishlaydi</b>\n\n• Ruxsat berilgach, Telegram akkauntingizni QR kod orqali ulaysiz (/login).\n• Kontaktlaringiz yozganda AI siz uchun javob beradi; shaxsiy savollar (qayerdasiz, kim bilan, qarz…) sizga yuboriladi.\n• Hamma sozlamalar shu chatdagi menyuda: kimga javob berish, uslub, uzunlik, ovozli/rasmli xabarlar.\n• /tasks — shaxsiy assistent: “Ali online bo‘lsa ayt”, “soat 18 da eslat”.\n\n⚠️ <b>Muhim</b>\n• Akkaunt sessiyangiz, API kalitingiz va xabarlar serverda shifrlangan holda saqlanadi; server administratori texnik jihatdan ularga kira oladi.\n• Userbot ishlatish Telegram qoidalariga ko‘ra akkaunt cheklanishiga olib kelishi mumkin.\n• Istalgan payt /logout va maxfiylik menyusi orqali ma’lumotlaringizni o‘chirasiz.\n\nRozimisiz?',
    agree: '✅ Roziman — so‘rov yuborish',
    cancel: '❌ Bekor qilish',
    back: '⬅️ Orqaga',
    restart: '🔄 Qaytadan sozlash',
    submitted: '📨 So‘rovingiz yuborildi! Administrator ruxsat berishi bilan sizga xabar beraman.',
    pending: '⏳ So‘rovingiz ko‘rib chiqilmoqda. Ruxsat berilishi bilan xabar beraman.',
    rejected: '🚫 Afsuski, so‘rovingiz rad etildi.',
    suspended: '⏸ Hisobingiz vaqtincha to‘xtatilgan. Administrator bilan bog‘laning.',
    cancelled: '❎ Bekor qilindi. Qaytadan boshlash uchun /start bosing.',
    approved:
      '🎉 <b>Ruxsat berildi!</b>\n\nEndi Telegram akkauntingizni ulang: /login bosing va QR kodni telefoningizdagi Telegram → Sozlamalar → Qurilmalar → «Qurilmani ulash» orqali skanerlang.\n\nUlangach, menyu (/menu) orqali hamma narsani sozlaysiz. Yordam: /help',
    sendText: '✍️ Iltimos, kalitni matn ko‘rinishida yuboring.',
    full: '⚠️ Hozircha yangi foydalanuvchilar uchun joy qolmagan. Keyinroq urinib ko‘ring.',
    reopened: '🔄 Administrator sizga qaytadan so‘rov yuborishga ruxsat berdi. /start bosing va sozlang.',
    unavailable: '⚠️ Ro‘yxatdan o‘tish vaqtincha ishlamayapti. Keyinroq urinib ko‘ring.',
    tooMany: '⏳ Juda ko‘p urinish. 10 daqiqadan keyin qaytadan yuboring.',
  },
  ru: {
    welcome:
      '👋 <b>Здравствуйте!</b>\n\nЯ — <b>AI-автоответчик для Telegram</b>. Пока вы заняты, я отвечаю на сообщения в вашем аккаунте в вашем стиле, а личные вопросы пересылаю вам.\n\nДавайте настроим всё за несколько шагов.',
    chooseLang: '🌐 Выберите язык:',
    chooseAi: '🤖 Какой AI будете использовать?\n\nКлюч будет только вашим, расходы — тоже по вашему ключу.',
    sendKey: (ai) =>
      `🔑 Отправьте API-ключ <b>${AI_LABEL[ai]}</b>.\n\nГде взять ключ: ${KEY_URL[ai]}\n\n<i>Для безопасности сообщение с ключом будет удалено из чата после проверки; ключ хранится в зашифрованном виде.</i>`,
    checking: '⏳ Проверяю ключ…',
    keyInvalid: '❌ Этот API-ключ неверный. Проверьте и отправьте снова (или выберите другой AI).',
    keyCheckFailed: '⚠️ Сейчас не удалось проверить ключ (сеть или AI-сервис не ответили). Отправьте его ещё раз чуть позже.',
    keyOk: (ai) => `✅ Ключ ${AI_LABEL[ai]} верный!`,
    consent:
      '📋 <b>Коротко, как это работает</b>\n\n• После одобрения вы подключаете свой Telegram-аккаунт по QR-коду (/login).\n• Когда пишут ваши контакты, AI отвечает за вас; личные вопросы (где вы, с кем, деньги в долг…) приходят вам.\n• Все настройки — в меню этого чата: кому отвечать, стиль, длина, голосовые и фото.\n• /tasks — личный ассистент: «скажи, когда Али будет онлайн», «напомни в 18:00».\n\n⚠️ <b>Важно</b>\n• Сессия аккаунта, API-ключ и сообщения хранятся на сервере в зашифрованном виде; администратор сервера технически имеет к ним доступ.\n• Использование userbot может привести к ограничениям аккаунта по правилам Telegram.\n• В любой момент можно отключиться (/logout) и удалить данные в меню приватности.\n\nВы согласны?',
    agree: '✅ Согласен — отправить заявку',
    cancel: '❌ Отмена',
    back: '⬅️ Назад',
    restart: '🔄 Настроить заново',
    submitted: '📨 Заявка отправлена! Сообщу, как только администратор её одобрит.',
    pending: '⏳ Ваша заявка на рассмотрении. Сообщу, как только её одобрят.',
    rejected: '🚫 К сожалению, ваша заявка отклонена.',
    suspended: '⏸ Ваш доступ временно приостановлен. Свяжитесь с администратором.',
    cancelled: '❎ Отменено. Чтобы начать заново, нажмите /start.',
    approved:
      '🎉 <b>Доступ одобрен!</b>\n\nТеперь подключите аккаунт: нажмите /login и отсканируйте QR-код в Telegram на телефоне → Настройки → Устройства → «Подключить устройство».\n\nПосле подключения всё настраивается через меню (/menu). Помощь: /help',
    sendText: '✍️ Пожалуйста, отправьте ключ текстом.',
    full: '⚠️ Сейчас нет свободных мест для новых пользователей. Попробуйте позже.',
    reopened: '🔄 Администратор разрешил подать заявку заново. Нажмите /start и настройте всё ещё раз.',
    unavailable: '⚠️ Регистрация временно недоступна. Попробуйте позже.',
    tooMany: '⏳ Слишком много попыток. Попробуйте снова через 10 минут.',
  },
  en: {
    welcome:
      '👋 <b>Hello!</b>\n\nI’m an <b>AI auto-responder for Telegram</b>. While you’re busy I reply to messages on your account in your style and forward personal questions to you.\n\nLet’s set things up in a few steps.',
    chooseLang: '🌐 Choose your language:',
    chooseAi: '🤖 Which AI will you use?\n\nThe key stays yours, and usage is billed to it.',
    sendKey: (ai) =>
      `🔑 Send your <b>${AI_LABEL[ai]}</b> API key.\n\nGet a key here: ${KEY_URL[ai]}\n\n<i>For safety, the message with your key is deleted from the chat after the check; the key is stored encrypted.</i>`,
    checking: '⏳ Checking the key…',
    keyInvalid: '❌ This API key is invalid. Please check it and send it again (or choose another AI).',
    keyCheckFailed: '⚠️ Couldn’t check the key right now (network or AI service did not respond). Please send it again a bit later.',
    keyOk: (ai) => `✅ The ${AI_LABEL[ai]} key is valid!`,
    consent:
      '📋 <b>How it works, briefly</b>\n\n• After approval you connect your Telegram account with a QR code (/login).\n• When your contacts write, the AI replies for you; personal questions (where are you, with whom, lending money…) come to you.\n• Everything is configured in this chat’s menu: whom to answer, style, length, voice and photos.\n• /tasks — personal assistant: “tell me when Ali is online”, “remind me at 18:00”.\n\n⚠️ <b>Important</b>\n• Your account session, API key and messages are stored encrypted on the server; the server administrator can technically access them.\n• Using a userbot may get an account restricted under Telegram’s rules.\n• You can disconnect (/logout) and delete your data from the privacy menu at any time.\n\nDo you agree?',
    agree: '✅ I agree — send request',
    cancel: '❌ Cancel',
    back: '⬅️ Back',
    restart: '🔄 Set up again',
    submitted: '📨 Request sent! I’ll let you know as soon as the administrator approves it.',
    pending: '⏳ Your request is being reviewed. I’ll let you know once it’s approved.',
    rejected: '🚫 Sorry, your request was declined.',
    suspended: '⏸ Your access is temporarily suspended. Please contact the administrator.',
    cancelled: '❎ Cancelled. Press /start to begin again.',
    approved:
      '🎉 <b>Access approved!</b>\n\nNow connect your account: press /login and scan the QR code in Telegram on your phone → Settings → Devices → “Link Desktop Device”.\n\nOnce connected, configure everything from the menu (/menu). Help: /help',
    sendText: '✍️ Please send the key as text.',
    full: '⚠️ There are no free places for new users right now. Please try again later.',
    reopened: '🔄 The administrator allowed you to apply again. Press /start and set things up.',
    unavailable: '⚠️ Sign-up is temporarily unavailable. Please try again later.',
    tooMany: '⏳ Too many attempts. Please try again in 10 minutes.',
  },
};

export const LANG_BUTTONS: Array<{ lang: Lang; label: string }> = [
  { lang: 'uz', label: '🇺🇿 O‘zbekcha' },
  { lang: 'ru', label: '🇷🇺 Русский' },
  { lang: 'en', label: '🇬🇧 English' },
];
