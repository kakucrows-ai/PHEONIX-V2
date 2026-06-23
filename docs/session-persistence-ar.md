# نظام حماية الجلسات — Madox v2.1.0

  ## لماذا كانت الجلسات تُفقد؟

  | السبب | المشكلة | الحل |
  |-------|---------|------|
  | كتابة غير ذرية | تلف الملف عند crash أثناء الكتابة | Atomic Write (tmp → rename) |
  | لا يوجد checksum | تلف خفي غير مكتشف | SHA-256 لكل حفظ |
  | حفظ كل 4 دقائق | فقدان الكوكيز بين الحفظات | خُفِّض إلى 2 دقيقة |
  | لا يوجد حفظ قبل الإغلاق | فقدان الجلسة عند restart | emergencyFlush قبل كل exit |
  | لا يوجد Lock File | كتابة متزامنة تُتلف الملف | قفل ذري على كل عملية كتابة |
  | 3 نسخ احتياطية فقط | قلة خيارات الاسترداد | رُفِّع إلى 5 نسخ |

  ---

  ## كيف يعمل نظام الكتابة الذري؟

  ```
  الطريقة القديمة (خطرة):
  writeFileSync(appstate.json, data)  ← إذا crash هنا = ملف تالف

  الطريقة الجديدة (آمنة):
  1. writeFileSync(appstate.json.tmp, data)  ← كتابة آمنة
  2. تحقق أن الملف المؤقت صحيح (parse + validate)
  3. كتابة checksum SHA-256
  4. renameSync(tmp → appstate.json)  ← ذري، لا يمكن أن يتلف
  ```

  ---

  ## سلسلة الاسترداد عند الفشل

  عند بدء التشغيل، يبحث النظام بهذا الترتيب:

  ```
  1. appstate.json          ← التحقق من checksum SHA-256
  2. appstate.backup1.json  ← أحدث نسخة احتياطية
  3. appstate.backup2.json
  4. appstate.backup3.json
  5. appstate.backup4.json
  6. appstate.backup5.json
  ↓ إذا فشلت جميعها → رسالة واضحة + توقف نظيف
  ```

  ---

  ## نظام الحفظ التلقائي

  | الحدث | الإجراء |
  |-------|---------|
  | كل 2 دقيقة | كشف تغيير الكوكيز + حفظ + رفع GitHub |
  | SIGINT / SIGTERM | emergencyFlush ثم إغلاق نظيف |
  | uncaughtException | emergencyFlush ثم إعادة تشغيل |
  | تسرب الذاكرة | emergencyFlush ثم إعادة تشغيل |
  | فشل إعادة تسجيل الدخول | emergencyFlush ثم انتظار 60 ثانية |

  ---

  ## Lock File — منع الكتابة المتزامنة

  ```
  appstate.json.lock  ← يُنشأ قبل الكتابة، يُحذف بعدها
  أي محاولة كتابة أخرى تنتظر (أو تتخطى Lock القديم > 30 ثانية)
  ```

  ---

  ## أوامر الصيانة

  | الأمر | الوظيفة |
  |-------|---------|
  | `-كوكيز` | تحديث الكوكيز مباشرة من الميسنجر |
  | `-cookiestatus` | عرض معلومات الجلسة الحالية |
  | `-restart` | إعادة تشغيل آمنة مع حفظ الجلسة |

  ---

  ## استكشاف الأخطاء

  ### البوت يخرج من الجلسة عند الريستارت
  ```bash
  # تحقق من ملفات الجلسة
  ls -la appstate*.json

  # إذا كان appstate.json فارغاً أو تالفاً
  cp appstate.backup1.json appstate.json

  # أو استخدم الأمر مباشرة
  -كوكيز
  ```

  ### appstate.json تالف
  النظام يستعيد تلقائياً من أحدث backup صالح.
  إذا فشلت جميع النسخ، ابحث عن:
  - `appstate.emergency.json` (آخر طارئ قبل crash)
  - `appstate.backup*.json` (1 إلى 5)

  ### السجلات (Logs)
  ```
  logs/madox-YYYY-MM-DD.log  ← كل العمليات
  grep "Session" logs/*.log   ← أحداث الجلسة فقط
  grep "Emergency" logs/*.log ← حالات الطوارئ
  grep "Checksum" logs/*.log  ← أخطاء التحقق
  ```

  ---

  ## دورة حياة Restart الآمن

  ```
  1. إشارة SIGTERM/SIGINT
  2. emergencyFlush() ← حفظ فوري للكوكيز
  3. cookieRefresher.stop()
  4. humanSimulator.stop()
  5. process.exit(0)
  ━━━━━━━━━━━━━━━━━━━━━━━━
  6. start.js يكتشف الخروج
  7. validateAppState() ← تحقق من سلامة الملف
  8. إذا تالف → استعادة من backup تلقائياً
  9. spawn index.js
  10. تحميل الجلسة + تسجيل دخول فوري
  ```

  ---

  *آخر تحديث: يونيو 2026 — Madox v2.1.0*
  