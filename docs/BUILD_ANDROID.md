# ساخت خروجی اندروید (APK / AAB) — Soccer Arena Persian

کلاینت یک تک‌فایل HTML خودکفاست و با **Capacitor** در قاب بومی اندروید اجرا می‌شود. ساخت نهایی به Android SDK نیاز دارد که باید روی سیستم خودتان (یا CI مثل GitHub Actions) انجام شود — زمان اجرای کل راهنما: حدود ۳۰ دقیقه.

## پیش‌نیازها (روی سیستم شما)

1. **Node.js 18+** — nodejs.org
2. **JDK 17** — مثل Temurin: `adoptium.net`
3. **Android Studio** (برای SDK + شبیه‌ساز) — developer.android.com/studio
   - یا فقط خط فرمان: `sdkmanager` با پکیج‌های `platform-tools`, `platforms;android-34`, `build-tools;34.0.0`
4. متغیر محیطی: `ANDROID_HOME=~/Android/Sdk` (یا مسیر نصب)

## گام ۱ — پروژه اندروید را بسازید

```bash
cd soccer-arena-persian/android
npm install          # capacitor + @capacitor/cli + @capacitor/android
```

## گام ۲ — آدرس سرور خودتان را تنظیم کنید

در فایل اصلی کلاینت (`../client/index.html`) مقدار زیر را پیدا و تنظیم کنید:

```js
window.SAP_SERVER = '';   // ← این را به آدرس VPS خودتان تغییر دهید، مثلاً:
window.SAP_SERVER = 'https://play.example.ir';
```

اگر خالی بماند، کلاینت همان میزبانی که فایل از آن باز شده را استفاده می‌کند (برای استقرار وب کافی است؛ برای APK باید دامنه خودتان را بنویسید).

سپس کپی به پروژه اندروید:

```bash
npm run sync         # web dir را به android/app/src/main/assets/public کپی می‌کند
```

## گام ۳ — Debug APK (برای تست سریع)

```bash
cd android/
npx cap open android      # Android Studio → Build → Build APK(s)
# یا فقط خط فرمان:
./gradlew assembleDebug
# خروجی: android/app/build/outputs/apk/debug/app-debug.apk
adb install -r app/build/outputs/apk/debug/app-debug.apk   # نصب روی گوشی متصل
```

## گام ۴ — Release APK و AAB (برای انتشار)

۱) کلید امضا بسازید (یک‌بار برای همیشه؛ **گم نشود**):

```bash
keytool -genkey -v -keystore soccer-arena.keystore -alias soccerarena \
  -keyalg RSA -keysize 2048 -validity 10000
```

۲) فایل `android/key.properties` بسازید (کامیت نکنید):

```properties
storeFile=../../soccer-arena.keystore
storePassword=YOUR_STORE_PASS
keyAlias=soccerarena
keyPassword=YOUR_KEY_PASS
```

۳) امضا و ساخت:

```bash
./gradlew assembleRelease      # → APK امضاشده
./gradlew bundleRelease        # → AAB برای Google Play
```

خروجی‌ها:
- `app/build/outputs/apk/release/app-release.apk`
- `app/build/outputs/bundle/release/app-release.aab`

۴) تست نهایی release: روی گوشی نصب کنید، دو دستگاه جداگانه با دو حساب، یک مسابقه کامل آنلاین.

## گام ۵ — آیکون و نام (اختیاری اما توصیه‌شده)

- نام اپ: `android/app/src/main/res/values/strings.xml` → `app_name`
- آیکون‌ها: در Android Studio → Image Asset یا پوشه‌های `res/mipmap-*`

## نکات مهم

- **WebView**: حداقل Chrome System WebView نسخه ۸۵+ (روی همه گوشی‌های فعال امروزی موجود است).
- WebSocket در WebView بدون مشکل کار می‌کند؛ نیازی به پرمیشن اینترنت اضافه نیست (`android.permission.INTERNET` در manifest پیش‌فرض Capacitor هست).
- در `capacitor.config.json` مقدار `server.androidScheme` روی `https` است تا `fetch` و `WebSocket` بدون مشکل mixed-content کار کنند.
- هر تغییر در `client/index.html` نیاز به `npm run sync` و build مجدد دارد.

## خط تولید با GitHub Actions (اختیاری)

نمونه workflow در `android/github-actions.yml` آمده است: با هر push، debug APK می‌سازد و به artifact می‌گذارد.
