// Capacitor কনফিগ (JavaScript — TypeScript লাগে না)
// Android package id — Play Store-এ এই id দিয়েই অ্যাপ চেনা যাবে।
// একবার প্রকাশ করলে আর বদলানো যায় না।
/** @type {import('@capacitor/cli').CapacitorConfig} */
const config = {
  appId: 'com.sohel.roktodata',
  appName: 'Blood Donor Finder',
  // ওয়েব অ্যাসেট www/ ফোল্ডারে থাকে (copy-to-www.js দিয়ে কপি হয় —
  // কোনো build step নেই; "." webDir হিসেবে বৈধ নয়)
  webDir: 'www',
  plugins: {
    SplashScreen: {
      launchShowDuration: 800,
      backgroundColor: '#14213D'
    },
    StatusBar: {
      style: 'dark',
      backgroundColor: '#14213D'
    }
  }
};

module.exports = config;
