# APK বানানো — Windows PC (Android Studio + Node.js)

এই ফোল্ডার (`blood-app-public`) থেকেই APK বানানো যাবে। PC-তে যা যা
আগে থেকে আছে (2026-11-21 যাচাই করা): **Android Studio + Android SDK**,
**Node.js v26.13.1 + npm 11.20.0** (PATH-এ আছে)।

## ধাপ ০ — Firebase কনফিগ আগে বসান (জরুরি)

APK বানানোর **আগে** `firebase-config.js`-এ আসল মান বসাতে হবে
(README.md-এর "Firebase setup checklist" দেখুন) — না হলে APK-তে
রেজিস্ট্রেশন/রিভিউ সংরক্ষণ হবে না (শুধু সিড-ডেটা দিয়ে খোঁজা চলবে)।
কনফিগ বদলালে পরে `npm run sync` আবার চালাতে হবে।

## ধাপ ১ — ফোল্ডার PC-তে নিন

`blood-app-public` ফোল্ডারটি পুরো PC-তে কপি করুন, যেমন:
`C:\Users\ABIR ADMED\Desktop\blood-app`
(`node_modules` আর `android` ফোল্ডারসহ কপি করলে ভালো — না করলেও
নিচের ধাপে আবার তৈরি হয়ে যাবে।)

## ধাপ ২ — ডিপেন্ডেন্সি ইনস্টল (cmd বা PowerShell)

```cmd
cd C:\Users\ABIR ADMED\Desktop\blood-app
npm install
```

## ধাপ ৩ — ওয়েব অ্যাসেট Android প্রজেক্টে sync করুন

```cmd
npm run sync
```

এটা (১) ওয়েব ফাইলগুলো `www/`-তে কপি করে, (২) Android প্রজেক্টে
sync করে। **ওয়েব ফাইলে কোনো পরিবর্তন করলে এই কমান্ড আবার চালাতে
হবে, তারপর APK বানাতে হবে।**

## ধাপ ৪ — Android Studio-তে খুলুন

1. Android Studio খুলুন → **Open** → `blood-app\android` ফোল্ডার
   বাছুন → OK।
2. প্রথমবার Gradle sync হবে — ইন্টারনেট লাগবে, ৫–১৫ মিনিট লাগতে
   পারে (Gradle + SDK কম্পোনেন্ট ডাউনলোড হবে)। নিচে "Gradle sync
   finished" না আসা পর্যন্ত অপেক্ষা করুন।
3. কোনো SDK কম্পোনেন্ট মিসিং বললে Studio-র দেওয়া **Install** লিংকে
   ক্লিক করুন।

## ধাপ ৫ — APK বানান (টেস্টের জন্য, debug)

Android Studio-তে: **Build → Build App Bundle(s) / APK(s) →
Build APK(s)**। শেষে নোটিফিকেশনে **locate** চাপলে ফাইল পাবেন:

```
android\app\build\outputs\apk\debug\app-debug.apk
```

ফোনে ইনস্টল: ফাইলটা ফোনে কপি করে খুলুন (Unknown sources অনুমতি
দিতে হতে পারে), অথবা USB দিয়ে `adb install app-debug.apk`।

## ধাপ ৬ — Play Store-এর জন্য Release AAB বানান

Play Store-এ APK নয়, **AAB** লাগে। আর সাইনিং কি লাগে —
**কি হারালে ভবিষ্যতে আর আপডেট দেওয়া যাবে না**, তাই কি ফাইল +
পাসওয়ার্ড নিরাপদে রাখতে হবে।

1. Android Studio-তে: **Build → Generate Signed App Bundle / APK**।
2. **Android App Bundle** বাছুন → Next।
3. **Create new** চাপুন (প্রথমবার):
   - Key store path: যেমন `C:\Users\ABIR ADMED\blood-app-key.jks`
     (এই ফাইলটি **কখনো হারাবেন না, কাউকে দেবেন না**)
   - Password, Alias (`roktodata`), পাসওয়ার্ড, নাম/সংস্থা দিন।
   - Validity: 25+ বছর রাখুন।
4. **release** বাছুন → Finish।

AAB পাবেন এখানে:

```
android\app\build\outputs\bundle\release\app-release.aab
```

## ধাপ ৭ — Play Store-এ আপলোড (ব্যবহারকারীকে করতে হবে)

- Play Console অ্যাকাউন্ট লাগবে ($25 এককালীন, নিজের কার্ড + ID
  যাচাই — অন্য কেউ করে দিতে পারে না)।
- Privacy policy লাগবে (অ্যাপ লোকেশন + ফোন নম্বর নেয়)।
- Store listing: আইকন (icon.svg থেকে PNG বানাতে হবে — ৫১২×৫১২),
  feature graphic, স্ক্রিনশট।
- প্রথম রিলিজ: Internal testing ট্র্যাকে দিয়ে নিজে পরীক্ষা করে
  তারপর Production-এ দিন।

## ভার্সন বাড়ানো (আপডেটের সময়)

`android\app\build.gradle` খুলে `versionCode` (+১) আর `versionName`
(যেমন `1.0.0` → `1.0.1`) বাড়ান, তারপর ধাপ ৩ → ধাপ ৫/৬ আবার করুন।
**একই সাইনিং কি দিয়ে সাইন করতে হবে** — না হলে Play Store আপডেট
নেবে না।

## সমস্যা হলে

| সমস্যা | সমাধান |
|---|---|
| `npm` চেনে না (PowerShell) | নতুন PowerShell খুলুন; Node PATH-এ আছে কি না `node --version` দিয়ে দেখুন |
| `npm.ps1 cannot be loaded` | `Set-ExecutionPolicy RemoteSigned -Scope CurrentUser -Force` (একবার করা আছে) |
| Gradle sync ফেল | ইন্টারনেট চেক করুন; **File → Invalidate Caches → Restart** |
| `SDK location not found` | Studio দিয়ে প্রথমে প্রজেক্ট খুলুন (Studio নিজে local.properties বানায়) |
| APK-তে পুরোনো ওয়েব ফাইল | `npm run sync` আবার চালিয়ে APK পুনর্নির্মাণ করুন |
| Firebase কাজ করে না | `firebase-config.js`-এ আসল মান আছে কি না দেখুন; `www\firebase-config.js`-ও sync হয়েছে কি না দেখুন |

## অ্যাপের তথ্য

- Package ID: `com.sohel.roktodata` (বদলানো যাবে না একবার প্রকাশ করলে)
- অ্যাপের নাম: রক্তদাতা খুঁজুন
- Permissions: Internet + Fine/Coarse Location (GPS)
- Min SDK: Capacitor 7 ডিফল্ট (Android 7.0+, API 24)
