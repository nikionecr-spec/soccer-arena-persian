# راهنمای مدیریت سرور — Soccer Arena Persian

## سرویس‌ها و وظایف

| کانتینر | نقش | ری‌استارت |
|---|---|---|
| sap_game | سرور بازی (REST + WebSocket) | `unless-stopped` + healthcheck ۳۰ ثانیه |
| sap_postgres | پایگاه داده اصلی | `unless-stopped` + healthcheck |
| sap_redis | کش/صف (اختیاری فعال) | `unless-stopped` |
| sap_nginx | TLS + reverse proxy | `unless-stopped` |
| sap_certbot | تمدید گواهی (idle) | — |

## دستورات روزمره

```bash
cd /opt/soccer
docker compose ps                     # وضعیت
docker compose logs -f game           # لاگ زنده سرور بازی
docker compose logs --since 1h game   # لاگ یک ساعت اخیر
docker compose restart game           # ری‌استارت فقط سرور بازی
docker compose up -d --build          # اعمال کد جدید
docker stats                          # مصرف CPU/RAM زنده
```

## بررسی سلامت

- `GET https://YOUR_DOMAIN/api/health` → `{"ok":true,...}`
- تعداد اتصال‌های WebSocket: `docker compose exec game node -e "console.log(require('ws').getTotalServers?.() ?? '—')"` (یا لاگ‌ها)
- دیتابیس: `docker compose exec postgres psql -U soccer -d soccer -c "SELECT count(*) FROM users;"`
- آخرین مسابقات: `... -c "SELECT id,mode,score_a,score_b,finished_at FROM matches ORDER BY finished_at DESC LIMIT 10;"`

## پشتیبان‌گیری و بازیابی

- پشتیبان شبانه خودکار: `crontab -l` باید خط `backup.sh` را داشته باشد (گام ۸ در INSTALL.md).
- فایل‌ها در `/opt/soccer/backups/soccer_YYYYMMDD_HHMMSS.sql.gz` با نگهداشت ۷ روزه.
- بازیابی: `./scripts/restore.sh /opt/soccer/backups/<FILE>.sql.gz`

**توصیه:** هفته‌ای یک‌بار یک فایل پشتیبان را در جای بیرون از سرور (مثلاً S3/B2 یا سیستم خودتان) کپی کنید:

```bash
scp sap@YOUR_SERVER_IP:/opt/soccer/backups/soccer_$(date +%Y%m%d)_*.sql.gz ~/backups/
```

## تنظیمات قابل تغییر بدون کدنویسی (در `.env`)

| متغیر | پیش‌فرض | اثر |
|---|---|---|
| TURN_SECONDS | 10 | طول نوبت هر ضربه |
| TARGET_GOALS | 3 | تعداد گل برای برد |
| RECONNECT_GRACE_SECONDS | 60 | مهلت بازگشت بازیکن قطع‌شده |
| ELO_K | 32 | شدت تغییر امتیاز رتبه |
| COIN_WIN / COIN_LOSS / COIN_GOAL | 50/15/10 | اقتصاد سکه |
| RATE_MSG_PER_5S | 40 | محدودیت پیام هر اتصال |

پس از تغییر: `docker compose up -d` (فقط game ری‌استارت می‌شود).

## امنیت — چک‌لیست

- [ ] `.env` با chmod 600 و خارج از گیت
- [ ] `JWT_SECRET` تصادفی ۹۶ نویسه (نه مقدار پیش‌فرض)
- [ ] پورت‌های 5432/6379 **از بیرون باز نیستند** (فقط داخل شبکه docker) — `ufw status`
- [ ] SSH با کلید و بدون ریشه
- [ ] fail2ban فعال
- [ ] پشتیبان شبانه + یک کپی بیرون‌ازسرور
- [ ] `docker compose exec postgres psql -U soccer -d soccer -c "SELECT event, count(*) FROM audit_log GROUP BY event;"` — مرور دوره‌ای رویدادها

## پاسخ به رخدادهای رایج

**حافظه سرور پر است؟** `docker stats` → معمولاً postgres است → `docker compose restart postgres` (بازی‌ها در جریان از دست می‌روند؛ بهتر است در ساعت کم‌ترافیک).

**شک به تقلب؟** رویدادهای audit (register/login/match_start/match_end/buy) با userId ثبت شده‌اند؛ امتیاز فقط سمت سرور تغییر می‌کند و کلاینت هرگز مختصات نمی‌فرستد، بنابراین تقلب در نتیجه مسابقه از کانال کلاینت ممکن نیست. الگوهای مشکوک: نرخ پیام غیرعادی (سرور خودش قطع می‌کند)، باز‌و‌بست سریع اتصال‌ها (در لاگ game دیده می‌شود).

**خروج اضطراری؟** `docker compose down` (داده‌ها در volumeها محفوظ‌اند) → `docker compose up -d` برای بازگشت.
