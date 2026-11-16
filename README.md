# Soccer Arena Persian — بازی آنلاین فوتبال دیسکی

بازی مستقل، آنلاین و کاملاً فارسی فوتبال دیسکی (مشابه گیم‌پلی Soccer Stars) برای اندروید و وب — با **سرور مرجع**، **موتور فیزیک مشترک قطعی** و رابط کاربری RTL با فونت Vazirmatn.

> ⚖️ این محصول هیچ دارایی، کد یا وابستگی‌ای به Miniclip ندارد؛ صرفاً ایده گیم‌پلی مشترک است و همه گرافیک‌ها/صداها به‌صورت برنامه‌ای تولید شده‌اند.

## دانلود دموی آفلاین (APK)

آخرین نسخه دمو (کاملاً آفلاین — تمرین با ربات): [Releases](../../releases) — فایل `SoccerArenaPersian-Demo-v0.1.0-release.apk` را نصب کنید.

## ساختار پروژه

```
soccer-arena-persian/
├── client/index.html      ← کل کلاینت در یک فایل خودکفا (UI + Canvas + فیزیک + فونت)
├── server/                ← سرور Node.js (REST + WebSocket، مرجع فیزیک و ضدتقلب)
│   ├── src/               ← کد سرور
│   ├── test/              ← تست فیزیک (۱۶ آزمون) + تست یکپارچگی (۳۹ آزمون) + حریف e2e مرورگر
│   └── test-results/      ← خروجی JSON آخرین اجرای تست‌ها
├── shared/physics.js      ← موتور فیزیک مشترک (کلاینت و سرور نسخه بایت‌به‌بایت یکسان)
├── db/schema.sql          ← اسکیمای PostgreSQL
├── deploy/                ← nginx.conf + گواهی‌ها (certbot)
├── android/               ← تنظیمات Capacitor + راهنمای ساخت APK/AAB
├── scripts/               ← backup.sh و restore.sh (عملیاتی روی VPS)
├── docs/                  ← INSTALL / SERVER_ADMIN / BUILD_ANDROID / PROTOCOL
├── docker-compose.yml     ← پشته کامل: game + postgres + redis + nginx + certbot
├── Dockerfile
└── .env.example           ← قالب متغیرهای محیطی (هرگز .env واقعی را کامیت نکنید)
```

## اجرای سریع محلی (برای توسعه)

```bash
cd server && npm install
node test/physics.test.js       # ۱۶/۱۶ پاس
node test/integration.test.js   # ۳۹/۳۹ پاس (دو کلاینت واقعی، مسابقه کامل)
node src/index.js               # سرور روی 8080 — کلاینت در http://localhost:8080
```

سپس در مرورگر: `http://localhost:8080` — ثبت‌نام کنید، «تمرین آفلاین» یا «مسابقه آنلاین رنکد» را باز کنید. با دو مرورگر/دو دستگاه یک مسابقه واقعی بگذارید.

## ویژگی‌ها

- مسابقه آنلاین ۱به۱ رنکد (ELO)، دوستانه، اتاق خصوصی با کد، دعوت دوستان، Matchmaking با نزدیکی امتیاز
- نوبت‌دهی با تایمر ۱۰ ثانیه و ضربه خودکار سمت سرور در پایان زمان
- سرور مرجع: کلاینت فقط `pieceId + angle + power` می‌فرستد؛ سرور فیزیک را شبیه‌سازی و بازپخش می‌کند
- قطعیت بین‌دستگاهی: گام ثابت ۱/۶۰ + فقط `+ - * /` و `Math.sqrt` در شبیه‌سازی + سرعت اولیه صحیح + کوانتیزه‌سازی وضعیت به فرمت شبکه
- مدیریت قطع اتصال: مهلت ۶۰ ثانیه، `state_sync` کامل هنگام بازگشت، شکست فنی پس از مهلت
- Rematch، تسلیم، فروشگاه ظاهری (۵ طرح مهره، ۴ زمین) با سکه، تاریخچه مسابقات، جدول رده‌بندی، دوستان
- ۱۵ صفحه فارسی RTL، ارقام فارسی، تاریخ شمسی، آموزش سه‌گامی، صدا و افکت سنتزی WebAudio
- حالت تمرین آفلاین با ربات (بدون نیاز به سرور)

## تست‌ها (همه قابل اجرا)

| تست | دستور | وضعیت تحویل |
|---|---|---|
| فیزیک | `node server/test/physics.test.js` | ۱۶/۱۶ پاس |
| یکپارچگی (سرور + دو کلاینت واقعی) | `node server/test/integration.test.js` | ۳۹/۳۹ پاس |
| حریف e2e برای مرورگر | `node server/test/browser_opponent.js` | مسابقه کامل مرورگر↔کلاینت |

## استقرار روی VPS

راهنمای کامل گام‌به‌گام: [`docs/INSTALL.md`](docs/INSTALL.md) — ساخت APK/AAB: [`docs/BUILD_ANDROID.md`](docs/BUILD_ANDROID.md) — مدیریت سرور: [`docs/SERVER_ADMIN.md`](docs/SERVER_ADMIN.md) — پروتکل: [`docs/PROTOCOL.md`](docs/PROTOCOL.md)

## مجوزها

- کد پروژه: مالک پروژه (تحویل اختصاصی)
- فونت Vazirmatn: مجوز آزاد OFL — github.com/rastikerdar/vazirmatn
- کتابخانه `ws`: MIT
