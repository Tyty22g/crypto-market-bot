# Crypto Market Bot (Binance Spot → Telegram)

مشروع Worker مجدول كل دقيقة + لوحة Pages لإدارة الأزواج.

## المكونات
- Binance Public Market Data: `https://data-api.binance.vision/api/v3/ticker/24hr`
- Cloudflare Worker + Cron Trigger `* * * * *`
- Cloudflare KV لتخزين الإعدادات ورقم منشور Telegram
- Cloudflare Pages لاستضافة `dashboard/`
- Telegram Bot API: ينشئ أول منشور ثم يعدّل نفس المنشور

## 1) إنشاء KV
من Cloudflare Dashboard:
Workers & Pages → KV → Create namespace
سمّه `CRYPTO_CONFIG` وانسخ Namespace ID.

افتح `wrangler.toml` واستبدل:
`PASTE_YOUR_KV_NAMESPACE_ID_HERE`
بالمعرّف الحقيقي.

## 2) إعداد أسرار Worker
في Worker → Settings → Variables and Secrets أضف Secrets:
- `TELEGRAM_BOT_TOKEN` = توكن البوت من BotFather
- `TELEGRAM_CHAT_ID` = `@YourChannelUsername` للقناة العامة، أو رقم chat id للقناة الخاصة
- `ADMIN_KEY` = كلمة طويلة عشوائية خاصة بلوحة التحكم

أضف البوت إلى القناة واجعله Admin مع صلاحية Post Messages.

## 3) نشر Worker
ارفع المشروع إلى GitHub.
أنشئ Worker واربطه بالمستودع من Workers & Pages / Workers Builds، واجعل إعداد البناء يستخدم `wrangler.toml` في جذر المستودع.
أو انشر محلياً باستخدام Wrangler:
```bash
npx wrangler deploy
```
يجب أن تكون KV namespace ID والأسرار مضبوطة قبل النشر.
بعد النشر تأكد أن Cron Trigger ظاهر بقيمة `* * * * *`.

## 4) نشر لوحة Pages
أنشئ Pages project واربطه بنفس GitHub repository.
- Framework preset: None
- Build command: اتركه فارغاً
- Build output directory: `dashboard`

بعد النشر افتح رابط Pages.

## 5) تشغيل البوت أول مرة
في لوحة Pages:
1. أدخل رابط Worker مثل `https://crypto-market-bot.username.workers.dev`
2. أدخل نفس قيمة `ADMIN_KEY`
3. اضغط تحميل الإعدادات الحالية أو اكتب أزواج USDT.
4. اضغط حفظ الإعدادات.
5. اضغط نشر / تحديث الآن.

بعدها Cron سيحدث نفس منشور القناة كل دقيقة.

## ملاحظات مهمة
- لا تضع Telegram token في GitHub أو لوحة Pages.
- Binance public market-data endpoints لا تحتاج API key.
- الكود يرسل قائمة الأزواج المختارة إلى ticker/24hr ضمن طلب مجمّع واحد (حتى 100 زوج في الإعداد الحالي)، بدلاً من جلب كل السوق.
- رسالة Telegram الواحدة لها حد طول؛ الكود يرفض الرسالة إذا تجاوزت 3900 حرف. لذلك لا يمكن عرض عدد غير محدود في منشور واحد. قلّل الأزواج أو عطّل تفاصيل الحجم والأعلى/الأدنى إذا وصلت للحد.
- الكود الحالي يقبل حتى 100 زوج في الإعدادات، لكن عدد الأزواج الفعلي الذي يتسع في المنشور أقل وقد يختلف حسب طول البيانات.
- `priceChange` و`priceChangePercent` هنا هما تغير آخر 24 ساعة، وليس التغير منذ آخر تحديث بالدقيقة.
- بيانات السوق عامة وليست توصية استثمارية.


---
## v2 — ما الجديد

**الترقية بدون تخريب:** نفس `wrangler.toml` (KV `CONFIG` + كرون كل دقيقة) ونفس الأسرار. القناة الحالية تُرحَّل تلقائياً كقناة `main` بنفس العنوان والأزواج والفاصل والزر. API القديم (`/api/config` و`/api/publish`...) ما زال يعمل.

**إصلاح التأخير وضياع منشور الساعة:** الجدولة صارت تحفظ آخر موعد ناجح في KV (كتابة واحدة فقط عند النشر الناجح)، وتعوّض الموعد الفائت أو الفاشل خلال مهلة (الأسعار 10 د، الساعة 15 د، 4 ساعات 30 د، اليومي 60 د). المهام تُرسل بالتسلسل مع فاصل ثانية بين منشور وآخر داخل نفس القناة لتجنب 429.

**قنوات متعددة:** من اللوحة تضيف قناة (معرّف @ أو -100...) وتحدد عملاتها ومهامها وتوقيتها، وتنشر أول منشور فوراً. نفس البوت يخدم كل القنوات (أضفه Admin بصلاحية Post Messages). حد أقصى 20 قناة.

**مهام لكل قناة:** أسعار كل N دقيقة · تحليل ساعة · تقرير 4 ساعات · ملخص يومي · تنبيه حركة قوية (نسبة وفترة وتهدئة) · فرق توقيت · إيقاف مؤقت · فحص الاتصال · نشر يدوي لأي مهمة.

**ملاحظات:**
- الحساب المجاني: 50 طلب خارجي لكل تشغيل و10ms CPU. مع أكثر من 4-5 قنوات يُفضّل Workers Paid.
- لو الفاصل أقل من 5 دقائق فالتعويض لا يُحفظ في KV (حتى لا تتجاوز حد الكتابة المجاني)، وهذا لا يهم لأن التالي يأتي بعد دقائق.
- لمتابعة المشاكل: `npx wrangler tail` أو Observability في Cloudflare، وابحث عن `JOB_ATTEMPT` و`BINANCE_ERRORS` و`TELEGRAM_HTTP_429`.
