// Firebase কনফিগ — আসল মানগুলো Firebase Console থেকে নিয়ে এখানে বসাতে হবে।
// Firebase Console > Project Settings > Your apps > Web app — সেখান থেকে
// firebaseConfig অবজেক্টটি কপি করে নিচের "REPLACE_ME" গুলোর জায়গায় বসান।
// কনফিগ না বসানো পর্যন্ত অ্যাপটি সিড-ডেটা (পাবলিক তালিকা) দিয়ে
// খোঁজার কাজ চালাবে, কিন্তু নতুন রেজিস্ট্রেশন/রিভিউ সংরক্ষণ করবে না।
// বিস্তারিত: README.md-এর "Firebase setup checklist" দেখুন।

export const firebaseConfig = {
  apiKey: "AIzaSyAbLgw-ynpvlRRSf4RSxBag-CBDGNDP3Xw",
  authDomain: "roktodata-khunjun.firebaseapp.com",
  projectId: "roktodata-khunjun",
  storageBucket: "roktodata-khunjun.firebasestorage.app",
  messagingSenderId: "947865005012",
  appId: "1:947865005012:web:7a7af3ddb7a93eeca74441"
};

// আসল কনফিগ বসানো হয়েছে কি না
export const isFirebaseConfigured =
  !Object.values(firebaseConfig).some(v => v === "REPLACE_ME" || !v);
