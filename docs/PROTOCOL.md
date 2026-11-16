# پروتکل WebSocket — Soccer Arena Persian

- آدرس: `wss://<domain>/ws?token=<JWT>` (توکن JWT پس از ورود/ثبت‌نام از REST)
- قالب پیام: JSON با فیلد `t` (نوع)
- محدودسازی: حداکثر `RATE_MSG_PER_5S` (پیش‌فرض ۴۰) پیام در ۵ ثانیه برای هر اتصال — تخلف = قطع
- قطع و بازگشت: همیشه با `state_sync` وضعیت کامل بازیابی می‌شود

## کلاینت → سرور

| t | فیلدها | توضیح |
|---|---|---|
| `auth` | `token` | احراز هویت اتصال (جایگزین توکن در URL) |
| `queue_join` | — | ورود به صف Matchmaking |
| `queue_leave` | — | خروج از صف |
| `room_create` | `params: {targetGoals?, turnSeconds?}` | ساخت اتاق خصوصی → پاسخ `room_created` با کد ۶ نویسی |
| `room_join` | `code` | ورود با کد → وقتی کامل شد مسابقه دوستانه شروع می‌شود |
| `invite_friend` | `userId` | دعوت دوست آنلاین به مسابقه دوستانه |
| `invite_accept` | `inviteId` | پذیرش دعوت → مسابقه دوستانه |
| `move` | `pieceId, angle, power` | **تنها ورودی گیم‌پلی.** angle رادیان جهت پرتاب، power ∈ [0,1] |
| `resign` | — | تسلیم → پایان مسابقه با برنده حریف |
| `rematch_ok` | — | درخواست بازی دوباره پس از پایان (هر دو لازم است) |
| `ping` | — | keep-alive → پاسخ `pong` |

## سرور → کلاینت

| t | فیلدهای کلیدی | توضیح |
|---|---|---|
| `auth_ok` | `profile`, `resumed?`, `matchId?` | احراز شد؛ در صورت بازگشت به مسابقه resumed=true |
| `profile_update` | `profile` | پس از تغییر سکه/رتبه |
| `queued` / `queue_left` | `position?` | وضعیت صف |
| `match_found` | `matchId, mode, team, formation, targetGoals, turnSeconds, opponent{name,rating}, you` | شروع مسابقه؛ `formation` چیدمان اولیه |
| `turn_start` | `turn (0|1), turnIndex, deadline, seconds, scores` | شروع نوبت؛ deadline با ساعت سرور |
| `shot_result` | `pieceId, vx, vy, power, auto, events[], frames, final{f,b}, scores, scored` | **مغز همگام‌سازی**: سرعت اولیه صحیح؛ events رویدادهای زمان‌دار با `f` (شماره فریم ۱-مبنا): `hit{a,b,x,y,p}` / `wall{x,y}` / `post{x,y}` / `goal{side,scoringTeam}`؛ `final` وضعیت نهایی بدنه‌ها به ترتیب ثابت `a0..a4,b0..b4,ball` با مختصات گرد ۰٫۱ |
| `goal_reset` | `kickoff, scores, formation` | پس از گل: چیدمان جدید + نوبت تیم گل‌خورده |
| `state_sync` | `matchId, mode, team, turn, deadline, scores, formation, status, targetGoals` | بازیابی کامل هنگام بازگشت |
| `opponent_left` | `team, graceSeconds` | حریف قطع شد؛ شمارش مهلت |
| `opponent_rejoin` | `team` | حریف برگشت |
| `match_end` | `winner, reason(goals|resign|forfeit), scores, rankDelta{0,1}, coinDelta{0,1}` | پایان مسابقه + تغییر رتبه/سکه (فقط رنکد) |
| `rematch_status` | `rematch[2]` | وضعیت آماده‌بودن دو طرف |
| `room_created` | `code, params` | کد اتاق |
| `room_joined` / `room_guest_joined` | `code` | ورود با کد |
| `invite` | `inviteId, from, fromName` | دعوت دریافتی |
| `invite_sent` | `inviteId` | دعوت ارسال شد |
| `error` | `code, message` | پیام خطای فارسی برای نمایش |
| `pong` | `serverTime` | پاسخ ping |

## قواعد همگام‌سازی (چرا هر دو دستگاه یکسان می‌بینند؟)

1. سرور سرعت اولیه را با `Math.round(cos·v), Math.round(sin·v)` به عدد صحیح می‌رساند و **همان** مؤلفه‌ها را در `shot_result` می‌فرستد؛ کلاینت با `shootV` همان اعداد را تزریق می‌کند — هیچ مثلثاتی سمت کلاینت در فیزیک اجرا نمی‌شود.
2. شبیه‌سازی فقط از `+ - * /` و `Math.sqrt` استفاده می‌کند (طبق مشخصات ECMAScript دقیق بین همه موتورهای JS).
3. پس از هر ضربه، سرور وضعیت خودش را به فرمت شبکه (گرد ۰٫۱) کوانتیزه می‌کند؛ یعنی شوت بعدی روی سرور و همه کلاینت‌ها از وضعیت بیت‌به‌بیت یکسان آغاز می‌شود.
4. کلاینت رویدادها را با شماره فریم برای صدا/افکت مصرف می‌کند و در پایان ضربه روی `final` قفل می‌کند.
5. گام زمانی ثابت ۱/۶۰ ثانیه با ۸ زیرگام (هیچ وابستگی به نرخ فریم واقعی دستگاه).
