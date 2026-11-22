// রক্তদাতা খুঁজুন — সাহায্যকারী ফাংশন (শুধু হিসাব, Firebase ছাড়া)
// এই ফাংশনগুলো ব্রাউজারেও চলে, node-এও পরীক্ষা করা যায়।

export const BLOOD_GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];

// কে কাকে রক্ত দিতে পারে (লোহিত কণিকা / RBC সামঞ্জস্য):
// donorGroup -> যেসব গ্রুপের রোগীকে দেওয়া যায়
export const CAN_DONATE_TO = {
  'O-': ['O-', 'O+', 'A-', 'A+', 'B-', 'B+', 'AB-', 'AB+'],
  'O+': ['O+', 'A+', 'B+', 'AB+'],
  'A-': ['A-', 'A+', 'AB-', 'AB+'],
  'A+': ['A+', 'AB+'],
  'B-': ['B-', 'B+', 'AB-', 'AB+'],
  'B+': ['B+', 'AB+'],
  'AB-': ['AB-', 'AB+'],
  'AB+': ['AB+']
};

// রোগীর গ্রুপের জন্য কোন কোন গ্রুপের ডোনার চলবে (CAN_DONATE_TO-এর উল্টো)
export function compatibleDonorGroups(patientGroup) {
  return BLOOD_GROUPS.filter(g => CAN_DONATE_TO[g].includes(patientGroup));
}

export function isCompatible(donorGroup, patientGroup) {
  return !!CAN_DONATE_TO[donorGroup] && CAN_DONATE_TO[donorGroup].includes(patientGroup);
}

// দুই জায়গার দূরত্ব (মিটার) — haversine সূত্র
export function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000; // পৃথিবীর ব্যাসার্ধ (মিটার)
  const toRad = deg => deg * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// দূরত্ব সুন্দর করে: 850m -> "850 m", 12400m -> "12.4 km"
export function fmtDistance(meters, lang = 'bn') {
  if (meters == null || !isFinite(meters)) return '—';
  if (meters < 1000) return lang === 'bn' ? `${toBn(Math.round(meters))} মি` : `${Math.round(meters)} m`;
  const km = (meters / 1000).toFixed(1);
  return lang === 'bn' ? `${toBn(km)} কিমি` : `${km} km`;
}

// বাংলা সংখ্যা (০-৯)
const BN_DIGITS = ['০', '১', '২', '৩', '৪', '৫', '৬', '৭', '৮', '৯'];
export function toBn(value) {
  return String(value).replace(/[0-9]/g, d => BN_DIGITS[Number(d)]);
}

// সংখ্যা ভাষা অনুযায়ী (বাংলায় বাংলা সংখ্যা, বাকিগুলোতে ইংরেজি)
export function fmtNum(n, lang = 'bn') {
  if (n == null) return '—';
  return lang === 'bn' ? toBn(n) : String(n);
}

// তারিখ YYYY-MM-DD আকারে
export function dateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// দুই তারিখের মধ্যে দিনের পার্থক্য
export function daysBetween(a, b) {
  const ms = new Date(b).getTime() - new Date(a).getTime();
  return Math.floor(ms / 86400000);
}

// শেষ রক্তদানের তারিখ থেকে "এখন দিতে পারবে" কি না (৯০ দিনের বিশ্রাম)
export function isReadyToDonate(lastDonationDate) {
  if (!lastDonationDate) return true; // কখনো দেয়নি — দিতে পারবে
  return daysBetween(lastDonationDate, dateStr(new Date())) >= 90;
}

// যোগ্যতা যাচাই: বয়স ১৮–৭০ + ৯০ দিনের বিশ্রাম
export function donorEligibility({ age, lastDonationDate }) {
  const reasons = [];
  if (age != null && (age < 18 || age > 70)) reasons.push('age');
  if (lastDonationDate && !isReadyToDonate(lastDonationDate)) reasons.push('rest');
  return { eligible: reasons.length === 0, reasons };
}

// র‍্যান্ডম মালিক-টোকেন (নিজের তালিকা চেনার জন্য, localStorage-এ থাকে)
export function generateOwnerToken() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let s = '';
  for (let i = 0; i < 24; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

// ফোন নম্বর সাধারণ আকারে (তুলনার জন্য): শুধু সংখ্যা, শুরুর 880/0 ঠিক করা
export function normalizePhone(phone) {
  if (!phone) return '';
  let p = String(phone).replace(/[^0-9+]/g, '');
  if (p.startsWith('+880')) p = '0' + p.slice(4);
  else if (p.startsWith('880')) p = '0' + p.slice(3);
  return p;
}

// বাংলাদেশি মোবাইল নম্বর কি না (০১ দিয়ে শুরু, ১১ সংখ্যা)
export function isValidBdPhone(phone) {
  return /^01[3-9]\d{8}$/.test(normalizePhone(phone));
}

// ফোন নম্বর মাস্ক করে দেখান (তালিকায় পুরো নম্বর দেখানো হয় না):
// 01309223983 -> "01XXX-XXXXXX"। কল বাটনে আসল নম্বরই ব্যবহার হয়।
export function maskPhone(phone) {
  const p = normalizePhone(phone);
  if (!p) return '';
  if (p.length === 11) return p.slice(0, 2) + 'XXX-XXXXXX';
  if (p.length > 4) return p.slice(0, 2) + 'X'.repeat(p.length - 2);
  return p;
}

// HTML এস্কেপ (ব্যবহারকারীর লেখা কার্ডে দেখানোর সময় XSS ঠেকাতে)
export function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// নামের ইনিশিয়াল (অ্যাভাটারের জন্য)
export function initials(name) {
  if (!name) return '?';
  const parts = String(name).trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// বাংলাদেশের জেলার কেন্দ্র (আনুমানিক) — ঠিকানা-শুধু তালিকার
// দূরত্ব হিসাবের ফলব্যাক হিসেবে। GPS/জিওকোড করা কোঅর্ডিনেট থাকলে
// সেটাই ব্যবহৃত হয়; এই মানগুলো শুধু আনুমানিক অবস্থান দেয়।
export const BD_DISTRICT_CENTERS = {
  'Dhaka': [23.8103, 90.4125], 'ঢাকা': [23.8103, 90.4125],
  'Chattogram': [22.3569, 91.7832], 'চট্টগ্রাম': [22.3569, 91.7832],
  'Khulna': [22.8456, 89.5403], 'খুলনা': [22.8456, 89.5403],
  'Rajshahi': [24.3745, 88.6042], 'রাজশাহী': [24.3745, 88.6042],
  'Barishal': [22.7010, 90.3535], 'বরিশাল': [22.7010, 90.3535],
  'Sylhet': [24.8949, 91.8687], 'সিলেট': [24.8949, 91.8687],
  'Rangpur': [25.7439, 89.2752], 'রংপুর': [25.7439, 89.2752],
  'Mymensingh': [24.7471, 90.4203], 'ময়মনসিংহ': [24.7471, 90.4203],
  'Kushtia': [23.9013, 89.1221], 'কুষ্টিয়া': [23.9013, 89.1221],
  'Jhenaidah': [23.5448, 89.1539], 'ঝিনাইদহ': [23.5448, 89.1539],
  'Chuadanga': [23.6402, 88.8414], 'চুয়াডাঙ্গা': [23.6402, 88.8414],
  'Cumilla': [23.4683, 91.1788], 'কুমিল্লা': [23.4683, 91.1788],
  'Narayanganj': [23.6238, 90.4990], 'নারায়ণগঞ্জ': [23.6238, 90.4990],
  'Bogura': [24.8465, 89.3763], 'বগুড়া': [24.8465, 89.3763],
  'Dinajpur': [25.6217, 88.6354], 'দিনাজপুর': [25.6217, 88.6354],
  'Faridpur': [23.6071, 89.8429], 'ফরিদপুর': [23.6071, 89.8429],
  'Jessore': [23.1665, 89.2081], 'যশোর': [23.1665, 89.2081],
  'Satkhira': [22.7185, 89.0764], 'সাতক্ষীরা': [22.7185, 89.0764],
  'Noakhali': [22.8242, 91.1017], 'নোয়াখালী': [22.8242, 91.1017],
  'Tangail': [24.2512, 89.9167], 'টাঙ্গাইল': [24.2512, 89.9167],
  'Pabna': [24.0081, 89.2391], 'পাবনা': [24.0081, 89.2391],
  'Coxs Bazar': [21.4272, 92.0058], "Cox's Bazar": [21.4272, 92.0058], 'কক্সবাজার': [21.4272, 92.0058],
  'Gazipur': [23.9999, 90.4203], 'গাজীপুর': [23.9999, 90.4203],
  'Narsingdi': [23.9208, 90.7180], 'নরসিংদী': [23.9208, 90.7180],
  'Manikganj': [23.8644, 90.0047], 'মানিকগঞ্জ': [23.8644, 90.0047],
  'Munshiganj': [23.5433, 90.5357], 'মুন্সিগঞ্জ': [23.5433, 90.5357],
  'Rajbari': [23.7572, 89.6440], 'রাজবাড়ী': [23.7572, 89.6440],
  'Gopalganj': [23.0055, 89.8267], 'গোপালগঞ্জ': [23.0055, 89.8267],
  'Madaripur': [23.1641, 90.1897], 'মাদারীপুর': [23.1641, 90.1897],
  'Shariatpur': [23.2423, 90.4348], 'শরীয়তপুর': [23.2423, 90.4348],
  'Kishoreganj': [24.4260, 90.7814], 'কিশোরগঞ্জ': [24.4260, 90.7814],
  'Netrokona': [24.8822, 90.7297], 'নেত্রকোণা': [24.8822, 90.7297],
  'Sherpur': [25.0205, 90.0153], 'শেরপুর': [25.0205, 90.0153],
  'Jamalpur': [24.9375, 89.9371], 'জামালপুর': [24.9375, 89.9371],
  'Sunamganj': [25.0710, 91.3992], 'সুনামগঞ্জ': [25.0710, 91.3992],
  'Moulvibazar': [24.4829, 91.7774], 'মৌলভীবাজার': [24.4829, 91.7774],
  'Habiganj': [24.4771, 91.4500], 'হবিগঞ্জ': [24.4771, 91.4500],
  'Brahmanbaria': [23.9608, 91.1115], 'ব্রাহ্মণবাড়িয়া': [23.9608, 91.1115],
  'Chandpur': [23.2513, 90.6570], 'চাঁদপুর': [23.2513, 90.6570],
  'Lakshmipur': [22.9444, 90.8289], 'লক্ষ্মীপুর': [22.9444, 90.8289],
  'Feni': [23.0159, 91.3976], 'ফেনী': [23.0159, 91.3976],
  'Bandarban': [22.1953, 92.2184], 'বান্দরবান': [22.1953, 92.2184],
  'Rangamati': [22.7324, 92.2985], 'রাঙ্গামাটি': [22.7324, 92.2985],
  'Khagrachari': [23.1193, 91.9847], 'খাগড়াছড়ি': [23.1193, 91.9847],
  'Bagerhat': [22.6516, 89.7857], 'বাগেরহাট': [22.6516, 89.7857],
  'Narail': [23.1725, 89.5121], 'নড়াইল': [23.1725, 89.5121],
  'Magura': [23.4854, 89.4198], 'মাগুরা': [23.4854, 89.4198],
  'Meherpur': [23.7623, 88.7061], 'মেহেরপুর': [23.7623, 88.7061],
  'Sirajganj': [24.4534, 89.7006], 'সিরাজগঞ্জ': [24.4534, 89.7006],
  'Joypurhat': [25.0947, 89.0227], 'জয়পুরহাট': [25.0947, 89.0227],
  'Natore': [24.4102, 89.0076], 'নাটোর': [24.4102, 89.0076],
  'Naogaon': [24.7936, 88.9318], 'নওগাঁ': [24.7936, 88.9318],
  'Chapainawabganj': [24.5965, 88.2775], 'চাঁপাইনবাবগঞ্জ': [24.5965, 88.2775],
  'Panchagarh': [26.3354, 88.5517], 'পঞ্চগড়': [26.3354, 88.5517],
  'Thakurgaon': [26.0338, 88.4616], 'ঠাকুরগাঁও': [26.0338, 88.4616],
  'Nilphamari': [25.9318, 88.8560], 'নীলফামারী': [25.9318, 88.8560],
  'Lalmonirhat': [25.9923, 89.2847], 'লালমনিরহাট': [25.9923, 89.2847],
  'Kurigram': [25.8072, 89.6295], 'কুড়িগ্রাম': [25.8072, 89.6295],
  'Gaibandha': [25.3297, 89.5429], 'গাইবান্ধা': [25.3297, 89.5429],
  'Barguna': [22.0953, 90.1121], 'বরগুনা': [22.0953, 90.1121],
  'Bhola': [22.6856, 90.6482], 'ভোলা': [22.6856, 90.6482],
  'Jhalokati': [22.6411, 90.1987], 'ঝালকাঠি': [22.6411, 90.1987],
  'Patuakhali': [22.3596, 90.3299], 'পটুয়াখালী': [22.3596, 90.3299],
  'Pirojpur': [22.5791, 89.9752], 'পিরোজপুর': [22.5791, 89.9752]
};

export function districtCenter(district) {
  if (!district) return null;
  return BD_DISTRICT_CENTERS[district] || BD_DISTRICT_CENTERS[String(district).trim()] || null;
}

// GPS কোঅর্ডিনেটের সবচেয়ে কাছের জেলার বাংলা নাম (হোম হেডারে দেখানোর জন্য)
export function nearestDistrict(lat, lng) {
  let best = null, bestD = Infinity;
  for (const [name, c] of Object.entries(BD_DISTRICT_CENTERS)) {
    if (!/[\u0980-\u09FF]/.test(name)) continue; // শুধু বাংলা নাম (প্রতি জেলায় একটা)
    const d = haversineMeters(lat, lng, c[0], c[1]);
    if (d < bestD) { bestD = d; best = name; }
  }
  return best;
}

// ছবি ছোট করে data URL বানান (Firestore-এ রাখার জন্য —
// Firebase Storage ছাড়াই চলে; 480px, JPEG q0.7, সাধারণত 30–80KB)
export function fileToCompressedDataUrl(file, maxDim = 480, quality = 0.7) {
  return new Promise((resolve, reject) => {
    if (!file || !file.type.startsWith('image/')) {
      return reject(new Error('image_only'));
    }
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      let { width, height } = img;
      const scale = Math.min(1, maxDim / Math.max(width, height));
      width = Math.round(width * scale);
      height = Math.round(height * scale);
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, width, height);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('image_read_failed'));
    };
    img.src = url;
  });
}
