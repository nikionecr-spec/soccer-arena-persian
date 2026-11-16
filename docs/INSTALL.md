# نصب و استقرار روی VPS — Soccer Arena Persian

پیش‌نیازها: یک VPS اوبونتو/دبیان (حداقل ۲ هسته، ۴GB RAM)، یک دامنه با رکورد A به IP سرور، دسترسی SSH.

## گام ۱ — بررسی و ایمن‌سازی سرور

```bash
ssh root@YOUR_SERVER_IP
apt update && apt upgrade -y
adduser sap && usermod -aG sudo sap
# ورود با کلید + غیرفعال‌کردن رمز ریشه:
mkdir -p /home/sap/.ssh && cp ~/.ssh/authorized_keys /home/sap/.ssh/ 2>/dev/null || true
sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/; s/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
systemctl restart ssh
# فایروال
apt install -y ufw
ufw allow 22 && ufw allow 80 && ufw allow 443 && ufw --force enable
# fail2ban (اختیاری ولی توصیه‌شده)
apt install -y fail2ban && systemctl enable --now fail2ban
```

## گام ۲ — نصب Docker

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker sap
# خروج و ورود مجدد تا گروه اعمال شود
docker compose version   # باید نسخه چاپ کند
```

## گام ۳ — انتقال پروژه

```bash
sudo mkdir -p /opt/soccer && sudo chown sap:sap /opt/soccer
# از سیستم خودتان:
scp -r soccer-arena-persian/* sap@YOUR_SERVER_IP:/opt/soccer/
```

## گام ۴ — تنظیم Environment

```bash
cd /opt/soccer
cp .env.example .env
node -e "console.log('JWT_SECRET=' + require('crypto').randomBytes(48).toString('hex'))"   # مقدار را در .env بگذارید
nano .env    # JWT_SECRET و POSTGRES_PASSWORD را با مقادیر واقعی پر کنید
chmod 600 .env
```

## گام ۵ — بالا آوردن پشته

```bash
cd /opt/soccer
docker compose up -d --build
docker compose ps          # هر ۴ سرویس Up باشد (certbot در حالت idle طبیعی است)
curl http://127.0.0.1:8080/api/health   # از داخل سرور — ok:true
curl http://127.0.0.1:80/              # سرو کلاینت از nginx
```

اسکیما دیتابیس به‌صورت خودکار در اولین اجرای PostgreSQL اعمال می‌شود (`db/schema.sql` mount شده در docker-entrypoint-initdb.d).

## گام ۶ — SSL با Let's Encrypt

۱) در `deploy/nginx.conf`، `server_name _` را در بلوک HTTP به دامنه خود تغییر دهید.
۲) گواهی بگیرید:

```bash
cd /opt/soccer
docker compose run --rm certbot certonly --webroot -w /var/www/certbot -d YOUR_DOMAIN --agree-tos -m YOU@MAIL --no-eff-email
```

۳) بلوک ۴۴۳ در `deploy/nginx.conf` را از حالت کامنت خارج کنید و `YOUR_DOMAIN` را جایگزین کنید (۳ جا) و همچنین خط `location / { return 301 ... }` را باز کنید:

```bash
nano deploy/nginx.conf
docker compose restart nginx
```

۴) تمدید خودکار: certbot container هر ۱۲ ساعت `renew` را اجرا می‌کند؛ پس از تمدید، nginx را با یک cron ری‌لود کنید:

```bash
(crontab -l; echo "0 4 * * 1 cd /opt/soccer && docker compose exec nginx nginx -s reload") | crontab -
```

## گام ۷ — اتصال واقعی اپلیکیشن

- کلاینت وب: `https://YOUR_DOMAIN` — همان فایل `client/index.html` که سرور سرو می‌کند.
- اپ اندروید: در `client/index.html` مقدار `window.SAP_SERVER` را روی `https://YOUR_DOMAIN` بگذارید (راهنمای کامل در `docs/BUILD_ANDROID.md`) و APK بسازید.

تست نهایی: از دو گوشی/مرورگر جداگانه ثبت‌نام کنید و یک مسابقه رنکد کامل بگذارید.

## گام ۸ — پشتیبان‌گیری و مانیتورینگ

```bash
chmod +x scripts/*.sh
mkdir -p /opt/soccer/backups
(crontab -l; echo "0 3 * * * /opt/soccer/scripts/backup.sh >> /var/log/sap_backup.log 2>&1") | crontab -
/opt/soccer/scripts/backup.sh     # اجرای آزمایشی
```

- Health Check: `GET /api/health` (برای UptimeRobot یا مشابه آن مناسب است)
- لاگ‌ها: `docker compose logs -f game` — `docker compose logs postgres`
- مصرف منابع: `docker stats`

## به‌روزرسانی نسخه جدید

```bash
cd /opt/soccer
# فایل‌های جدید را کپی کنید سپس:
docker compose up -d --build
docker compose logs -f game    # چند ثانیه لاگ ببینید
```

داده‌ها در volumeهای `pgdata` و `redisdata` باقی می‌مانند.

## عیب‌یابی سریع

| مشکل | بررسی |
|---|---|
| سرویس بالا نمی‌آید | `docker compose logs game` — معمولاً `.env` ناقص است |
| WebSocket وصل نمی‌شود | nginx باید headerهای `Upgrade/Connection` داشته باشد؛ پورت 443 باز باشد |
| دیتابیس خالی است | schema فقط در **اولین** راه‌اندازی volume اعمال می‌شود؛ برای re-apply: `docker compose exec -T postgres psql -U soccer -d soccer < db/schema.sql` |
| گواهی SSL گرفته نشد | دامنه A record درست است؟ پورت 80 باز؟ بلوک `/.well-known/acme-challenge/` فعال است؟ |
