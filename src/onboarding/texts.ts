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
  /** After approval: how to connect the bot in Telegram Business (chat automation). */
  approved: (bot: string) => string;
  bizOn: string;
  bizNoReply: string;
  bizOff: string;
  userbotOnly: string;
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
      '👋 <b>Assalomu alaykum!</b>\n\nMen — Telegram uchun <b>AI avtojavob yordamchisi</b>. Siz band bo‘lganingizda kontaktlaringiz yozgan xabarlarga sizning uslubingizda javob beraman, shaxsiy savollarni esa sizga yuboraman.\n\nMen akkauntingizga kirmayman: Telegram Business’ning «Chatbotlar / Автоматизация чатов» funksiyasi orqali ishlayman, shuning uchun <b>Telegram Premium</b> kerak.\n\nBoshlash uchun bir necha qadam sozlaymiz.',
    chooseLang: '🌐 Tilni tanlang:',
    chooseAi: '🤖 Qaysi AI ishlatasiz?\n\nAI kalitingiz faqat sizniki bo‘ladi va xarajatlar ham shu kalit hisobidan.',
    sendKey: (ai) =>
      `🔑 <b>${AI_LABEL[ai]}</b> API kalitingizni yuboring.\n\nKalitni bu yerdan olasiz: ${KEY_URL[ai]}\n\n<i>Xavfsizlik uchun xabaringiz tekshirilgach chatdan o‘chiriladi; kalit shifrlangan holda saqlanadi.</i>`,
    checking: '⏳ Kalit tekshirilmoqda…',
    keyInvalid: '❌ Bu API kalit noto‘g‘ri. Tekshirib, qaytadan yuboring (yoki boshqa AI tanlang).',
    keyCheckFailed: '⚠️ Kalitni hozir tekshirib bo‘lmadi (tarmoq yoki AI xizmati javob bermadi). Birozdan keyin qaytadan yuboring.',
    keyOk: (ai) => `✅ ${AI_LABEL[ai]} kaliti to‘g‘ri!`,
    consent:
      '📋 <b>Qisqacha qanday ishlaydi</b>\n\n• Ruxsat berilgach, meni Telegram → Sozlamalar → Telegram Business → Chatbotlar (Автоматизация чатов) bo‘limiga qo‘shasiz — akkauntingizga kirish yoki parol kerak emas.\n• Kontaktlaringiz yozganda AI siz uchun javob beradi; shaxsiy savollar (qayerdasiz, kim bilan, qarz…) sizga yuboriladi.\n• Hamma sozlamalar shu chatdagi menyuda: kimga javob berish, uslub, uzunlik, ovozli/rasmli xabarlar.\n• /tasks — shaxsiy assistent: “Ali yozsa ayt”, “soat 18 da eslat”.\n\n⚠️ <b>Muhim</b>\n• Telegram Premium kerak; Telegram qoidasiga ko‘ra bot faqat oxirgi 24 soat ichida yozgan odamlarga javob bera oladi.\n• API kalitingiz va xabarlar serverda shifrlangan holda saqlanadi; server administratori texnik jihatdan ularga kira oladi.\n• Istalgan payt botni Chatbotlar bo‘limidan olib tashlab, maxfiylik menyusi orqali ma’lumotlaringizni o‘chirasiz.\n\nRozimisiz?',
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
      (bot) =>
      `🎉 <b>Ruxsat berildi!</b>\n\nEndi meni akkauntingizga ulang:\n1️⃣ Telegram → <b>Sozlamalar → Telegram Business → Chatbotlar</b> (ruschada: <i>Telegram для бизнеса → Автоматизация чатов</i>).\n2️⃣ Qidiruvga <b>@${bot}</b> deb yozing va qo‘shing.\n3️⃣ <b>«Xabarlarga javob berish»</b> ruxsatini yoqing va qaysi chatlarga javob berishimni tanlang.\n\nUlanishim bilan sizga xabar beraman. Keyin menyu (/menu) orqali hamma narsani sozlaysiz. Yordam: /help`,
    sendText: '✍️ Iltimos, kalitni matn ko‘rinishida yuboring.',
    full: '⚠️ Hozircha yangi foydalanuvchilar uchun joy qolmagan. Keyinroq urinib ko‘ring.',
    reopened: '🔄 Administrator sizga qaytadan so‘rov yuborishga ruxsat berdi. /start bosing va sozlang.',
    unavailable: '⚠️ Ro‘yxatdan o‘tish vaqtincha ishlamayapti. Keyinroq urinib ko‘ring.',
    tooMany: '⏳ Juda ko‘p urinish. 10 daqiqadan keyin qaytadan yuboring.',
    bizOn: '🟢 Telegram Business orqali ulandim! Endi kontaktlaringiz yozganda javob beraman. Sozlamalar: /menu',
    bizNoReply: '🟡 Ulandim, lekin menga «xabarlarga javob berish» ruxsati berilmagan. Telegram → Sozlamalar → Telegram Business → Chatbotlar bo‘limida ruxsatni yoqing.',
    bizOff: '🔴 Telegram Business ulanishi o‘chirildi — avtojavoblar to‘xtadi.',
    userbotOnly: '⚠️ Bu funksiya faqat akkaunt to‘liq ulangan (userbot) rejimda ishlaydi; Telegram Business orqali mavjud emas.',
  },
  ru: {
    welcome:
      '👋 <b>Здравствуйте!</b>\n\nЯ — <b>AI-автоответчик для Telegram</b>. Пока вы заняты, я отвечаю вашим контактам в вашем стиле, а личные вопросы пересылаю вам.\n\nЯ не захожу в ваш аккаунт: работаю через функцию Telegram Business «Автоматизация чатов», поэтому нужен <b>Telegram Premium</b>.\n\nДавайте настроим всё за несколько шагов.',
    chooseLang: '🌐 Выберите язык:',
    chooseAi: '🤖 Какой AI будете использовать?\n\nКлюч будет только вашим, расходы — тоже по вашему ключу.',
    sendKey: (ai) =>
      `🔑 Отправьте API-ключ <b>${AI_LABEL[ai]}</b>.\n\nГде взять ключ: ${KEY_URL[ai]}\n\n<i>Для безопасности сообщение с ключом будет удалено из чата после проверки; ключ хранится в зашифрованном виде.</i>`,
    checking: '⏳ Проверяю ключ…',
    keyInvalid: '❌ Этот API-ключ неверный. Проверьте и отправьте снова (или выберите другой AI).',
    keyCheckFailed: '⚠️ Сейчас не удалось проверить ключ (сеть или AI-сервис не ответили). Отправьте его ещё раз чуть позже.',
    keyOk: (ai) => `✅ Ключ ${AI_LABEL[ai]} верный!`,
    consent:
      '📋 <b>Коротко, как это работает</b>\n\n• После одобрения вы добавляете меня в Telegram → Настройки → Telegram для бизнеса → Автоматизация чатов — входить в аккаунт и вводить пароль не нужно.\n• Когда пишут ваши контакты, AI отвечает за вас; личные вопросы (где вы, с кем, деньги в долг…) приходят вам.\n• Все настройки — в меню этого чата: кому отвечать, стиль, длина, голосовые и фото.\n• /tasks — личный ассистент: «скажи, когда напишет Али», «напомни в 18:00».\n\n⚠️ <b>Важно</b>\n• Нужен Telegram Premium; по правилам Telegram бот может отвечать только тем, кто писал за последние 24 часа.\n• API-ключ и сообщения хранятся на сервере в зашифрованном виде; администратор сервера технически имеет к ним доступ.\n• В любой момент можно убрать бота из «Автоматизации чатов» и удалить данные в меню приватности.\n\nВы согласны?',
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
      (bot) =>
      `🎉 <b>Доступ одобрен!</b>\n\nТеперь подключите меня к аккаунту:\n1️⃣ Telegram → <b>Настройки → Telegram для бизнеса → Автоматизация чатов</b>.\n2️⃣ Введите <b>@${bot}</b> и добавьте.\n3️⃣ Включите разрешение <b>«Отвечать на сообщения»</b> и выберите, в каких чатах мне отвечать.\n\nКак только подключите — я сообщу. Дальше всё настраивается через меню (/menu). Помощь: /help`,
    sendText: '✍️ Пожалуйста, отправьте ключ текстом.',
    full: '⚠️ Сейчас нет свободных мест для новых пользователей. Попробуйте позже.',
    reopened: '🔄 Администратор разрешил подать заявку заново. Нажмите /start и настройте всё ещё раз.',
    unavailable: '⚠️ Регистрация временно недоступна. Попробуйте позже.',
    tooMany: '⏳ Слишком много попыток. Попробуйте снова через 10 минут.',
    bizOn: '🟢 Подключено через Telegram Business! Теперь я отвечаю вашим контактам. Настройки: /menu',
    bizNoReply: '🟡 Подключено, но у меня нет разрешения «Отвечать на сообщения». Включите его: Telegram → Настройки → Telegram для бизнеса → Автоматизация чатов.',
    bizOff: '🔴 Подключение Telegram Business отключено — автоответы остановлены.',
    userbotOnly: '⚠️ Эта функция работает только при полном подключении аккаунта (userbot); через Telegram Business она недоступна.',
  },
  en: {
    welcome:
      '👋 <b>Hello!</b>\n\nI’m an <b>AI auto-responder for Telegram</b>. While you’re busy I reply to your contacts in your style and forward personal questions to you.\n\nI never log into your account: I work through Telegram Business “Chatbots” (chat automation), so <b>Telegram Premium</b> is required.\n\nLet’s set things up in a few steps.',
    chooseLang: '🌐 Choose your language:',
    chooseAi: '🤖 Which AI will you use?\n\nThe key stays yours, and usage is billed to it.',
    sendKey: (ai) =>
      `🔑 Send your <b>${AI_LABEL[ai]}</b> API key.\n\nGet a key here: ${KEY_URL[ai]}\n\n<i>For safety, the message with your key is deleted from the chat after the check; the key is stored encrypted.</i>`,
    checking: '⏳ Checking the key…',
    keyInvalid: '❌ This API key is invalid. Please check it and send it again (or choose another AI).',
    keyCheckFailed: '⚠️ Couldn’t check the key right now (network or AI service did not respond). Please send it again a bit later.',
    keyOk: (ai) => `✅ The ${AI_LABEL[ai]} key is valid!`,
    consent:
      '📋 <b>How it works, briefly</b>\n\n• After approval you add me in Telegram → Settings → Telegram Business → Chatbots — no account login or password needed.\n• When your contacts write, the AI replies for you; personal questions (where are you, with whom, lending money…) come to you.\n• Everything is configured in this chat’s menu: whom to answer, style, length, voice and photos.\n• /tasks — personal assistant: “tell me when Ali writes”, “remind me at 18:00”.\n\n⚠️ <b>Important</b>\n• Telegram Premium is required; by Telegram’s rules the bot can only reply to people who wrote within the last 24 hours.\n• Your API key and messages are stored encrypted on the server; the server administrator can technically access them.\n• You can remove the bot from Chatbots and delete your data from the privacy menu at any time.\n\nDo you agree?',
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
      (bot) =>
      `🎉 <b>Access approved!</b>\n\nNow connect me to your account:\n1️⃣ Telegram → <b>Settings → Telegram Business → Chatbots</b>.\n2️⃣ Type <b>@${bot}</b> and add it.\n3️⃣ Turn on the <b>“Reply to messages”</b> permission and choose which chats I should answer.\n\nI’ll let you know as soon as I’m connected. Then configure everything from the menu (/menu). Help: /help`,
    sendText: '✍️ Please send the key as text.',
    full: '⚠️ There are no free places for new users right now. Please try again later.',
    reopened: '🔄 The administrator allowed you to apply again. Press /start and set things up.',
    unavailable: '⚠️ Sign-up is temporarily unavailable. Please try again later.',
    tooMany: '⏳ Too many attempts. Please try again in 10 minutes.',
    bizOn: '🟢 Connected via Telegram Business! I’ll now reply to your contacts. Settings: /menu',
    bizNoReply: '🟡 Connected, but I don’t have the “Reply to messages” permission. Turn it on in Telegram → Settings → Telegram Business → Chatbots.',
    bizOff: '🔴 The Telegram Business connection was turned off — auto-replies stopped.',
    userbotOnly: '⚠️ This feature needs a fully connected account (userbot); it is not available via Telegram Business.',
  },
};

export const LANG_BUTTONS: Array<{ lang: Lang; label: string }> = [
  { lang: 'uz', label: '🇺🇿 O‘zbekcha' },
  { lang: 'ru', label: '🇷🇺 Русский' },
  { lang: 'en', label: '🇬🇧 English' },
];
