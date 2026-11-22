// রক্তদাতা খুঁজুন — মূল অ্যাপ (Firebase + Firestore + OpenStreetMap)
// Firebase v10 মডুলার SDK, CDN থেকে লোড হয় (কনফিগ বসানো থাকলে)।
// কনফিগ না থাকলেও সিড-ডেটা (পাবলিক তালিকা) দিয়ে খোঁজার কাজ চলবে।
//
// ডেটা মডেল (Firestore):
//   donors/{id}            — name, phone, address, age, gender, bloodGroup,
//                            profession, photoUrl?, lastDonation?, lat, lng,
//                            district, country, paused, voluntaryFreeConsent,
//                            ownerUid, ownerToken, createdAt
//   hospitals/{id}         — name, phone, address, facilities, doctorsHere,
//                            photoUrl, licenceProvided, lat, lng, district,
//                            country, infoTrue, ownerUid, ownerToken, createdAt
//   hospitals/{id}/private/licence — { dataUrl } (শুধু মালিক দেখতে পারবে)
//   doctors/{id}           — name, phone, degree, specialty, workplace,
//                            workplaceType, regNumber?, photoUrl, address,
//                            lat, lng, district, country, infoTrue,
//                            ownerUid, ownerToken, createdAt
//   reviews/{id}           — targetType, targetId, stars, text, name,
//                            ownerUid, createdAt
//   requests/{id}          — group, hospital, district, area?, phone,
//                            patientName?, neededBy?, notes?, status
//                            ('open'|'fulfilled'), lat, lng, country,
//                            ownerUid, ownerToken, createdAt
//   reports/{id}           — targetType, targetKey, reporterUid, createdAt
//   blood_orgs/{id}        — সংগঠনের তালিকা (সিড-ডেটা seed.js থেকে আসে)
//   takedowns/{phone}      — { phone } সিড-ডোনার সরানোর অনুরোধ
//
// লগইন (v10): ফোন + পাসওয়ার্ড, Firebase Email/Password —
// ফোন নম্বর থেকে সিনথেটিক ইমেইল বানানো হয়: 01XXXXXXXXX@roktodata.app
// (কোনো আসল ইমেইল লাগে না; Google সাইন-ইন নেই, SMS OTP নেই)।
// নতুন অ্যাকাউন্ট: বর্তমান অ্যানোনিমাস ইউজারের সঙ্গে লিংক করা হয়
// (linkWithCredential) — UID একই থাকে, আগের তালিকা থেকে যায়।
// লগইন: ownerUid দিয়ে Firestore থেকে অ্যাকাউন্টের তালিকা নতুন করে আনা হয়
// (এই ডিভাইসের অ্যানোনিমাস তালিকা অ্যাকাউন্টের তালিকা দিয়ে বদলে যায়)।
// পাসওয়ার্ড Firebase-এ হ্যাশ করে রাখা হয় — অ্যাপ কখনো দেখতে পায় না।
//
// সিড-ডেটা (seed.js): পাবলিক তালিকা — হাসপাতাল, ডাক্তার, ডোনার, সংগঠন।

import { firebaseConfig, isFirebaseConfigured } from './firebase-config.js';
import { SEED_HOSPITALS, SEED_DOCTORS, SEED_DONORS, SEED_BLOOD_ORGS } from './seed.js';
import {
  BLOOD_GROUPS, CAN_DONATE_TO, compatibleDonorGroups, isCompatible,
  haversineMeters, fmtDistance, fmtNum, toBn, dateStr, daysBetween,
  isReadyToDonate, generateOwnerToken, normalizePhone, isValidBdPhone,
  maskPhone, nearestDistrict,
  esc, initials, districtCenter, fileToCompressedDataUrl,
  BD_DISTRICT_CENTERS as BD_DISTRICTS_FALLBACK
} from './utils.js';
import { LANGUAGES, DEFAULT_LANG, t, langDir, COUNTRIES } from './i18n.js';

let db = null, auth = null, user = null, fb = null;

const $ = id => document.getElementById(id);
const state = {
  lang: localStorage.getItem('rb_lang') || DEFAULT_LANG,
  country: localStorage.getItem('rb_country') || 'Bangladesh',
  group: null,           // বাছাই করা ব্লাড গ্রুপ
  radiusKm: 10,          // ডিফল্ট ১০ কিমি
  pos: null,             // { lat, lng, label } — GPS বা জেলা জিওকোড
  donors: [], hospitals: [], doctors: [], reviews: [], requests: [], takedowns: new Set(),
  donorFilter: 'near',   // রক্ত ট্যাবের ফিল্টার: near | all | ready
  doctorSpec: '',        // ডাক্তার ট্যাবে বাছাই করা বিশেষজ্ঞতা
  reqGroup: null,        // অনুরোধ ফর্মে বাছাই করা গ্রুপ
  reports: [], reportCounts: {}, // 'type:key' -> রিপোর্ট সংখ্যা (৩+ হলে তালিকা লুকায়)
  blocked: new Set(JSON.parse(localStorage.getItem('rb_blocked') || '[]')), // এই ডিভাইসে লুকানো তালিকা
  ownerToken: localStorage.getItem('rb_owner_token') || '',
  myListings: JSON.parse(localStorage.getItem('rb_my_listings') || '[]'),
  reviewTarget: null, reviewStars: 0,
  soundOn: localStorage.getItem('rb_sound') !== 'off', // ক্লিক সাউন্ড (ডিফল্ট চালু)
  editing: null          // { type, id } — এডিট চলছে কি না
};

if (!state.ownerToken) {
  state.ownerToken = generateOwnerToken();
  localStorage.setItem('rb_owner_token', state.ownerToken);
}

const tr = key => t(state.lang, key);
const num = n => fmtNum(n, state.lang);

// ---------- ছোট সাহায্যকারী ----------

// ---------- ক্লিক সাউন্ড (Web Audio — কোনো ফাইল লাগে না) ----------
// হালকা মিষ্টি "টিক" শব্দ — বাটন/ট্যাব/টাইল চাপলে বাজবে
let audioCtx = null;
function playClick() {
  if (!state.soundOn) return;
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const t0 = audioCtx.currentTime;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(620, t0);
    osc.frequency.exponentialRampToValueAtTime(880, t0 + 0.07);
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(0.12, t0 + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.12);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start(t0);
    osc.stop(t0 + 0.13);
  } catch (e) { /* সাউন্ড না চললে চুপচাপ থাকুন */ }
}

// ---------- টেক্সট সাইজ (সেটিংসে — v9-এ ডিজাইন স্থির, শুধু সাইজ বদলায়) ----------
let textSize = localStorage.getItem('rb_textsize') || 'default';
function applyTextSize() { document.documentElement.dataset.text = textSize; }
function syncTextSizeRow() {
  document.querySelectorAll('#textsize-row button').forEach(b =>
    b.classList.toggle('selected', b.getAttribute('data-textsize') === textSize));
}

// ---------- কার্ডের SVG আইকন (লাইন-স্টাইল, মকের মতো) ----------
const SVG_PHONE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>';
const SVG_PIN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg>';
const SVG_NAV = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="3 11 22 2 13 21 11 13 3 11"/></svg>';
const SVG_STETH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4.8 2.3A.3.3 0 1 0 5 2H4a2 2 0 0 0-2 2v5a6 6 0 0 0 6 6 6 6 0 0 0 6-6V4a2 2 0 0 0-2-2h-1a.2.2 0 1 0 .3.3"/><path d="M8 15v1a6 6 0 0 0 6 6 6 6 0 0 0 6-6v-4"/><circle cx="20" cy="10" r="2"/></svg>';
const SVG_HOSP = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21h18"/><path d="M5 21V7l7-4 7 4v14"/><path d="M12 10v4"/><path d="M10 12h4"/></svg>';
const SVG_DROP = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22a7 7 0 0 0 7-7c0-2-1-3.9-3-5.5s-3.5-4-4-6.5c-.5 2.5-2 4.9-4 6.5C6 11.1 5 13 5 15a7 7 0 0 0 7 7z"/></svg>';

function toast(msg, isError = false) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  el.classList.toggle('error', isError);
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.add('hidden'), 5000);
}

function needFirebase() {
  if (!isFirebaseConfigured) {
    toast(tr('config_warning'), true);
    return false;
  }
  if (!user) {
    toast(tr('locating'), true);
    return false;
  }
  return true;
}

function getPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('nogeo'));
    navigator.geolocation.getCurrentPosition(resolve, err => {
      reject(new Error(err.code === 1 ? 'denied' : 'failed'));
    }, { enableHighAccuracy: true, timeout: 15000 });
  });
}

// Nominatim জিওকোড (OpenStreetMap — ফ্রি, কোনো API key লাগে না)
async function geocodePlace(query) {
  const url = 'https://nominatim.openstreetmap.org/search?format=json&limit=1&q=' +
    encodeURIComponent(query);
  const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
  if (!res.ok) throw new Error('geocode_failed');
  const arr = await res.json();
  if (!arr.length) throw new Error('not_found');
  return { lat: parseFloat(arr[0].lat), lng: parseFloat(arr[0].lon), label: arr[0].display_name };
}

// জেলা/শহর থেকে অবস্থান: প্রথমে বান্ডেল করা টেবিল (বাংলাদেশ),
// না পেলে Nominatim
async function resolvePlace(text) {
  const center = districtCenter(text);
  if (center) return { lat: center[0], lng: center[1], label: text };
  return geocodePlace(`${text}, ${state.country}`);
}

// কাছের OSM জায়গা (হাসপাতাল/ক্লিনিক/ডাক্তার) — রেজিস্টার্ড তালিকার পরে দেখায়
async function osmNearby(amenities, lat, lng, radiusKm) {
  const deg = radiusKm / 111; // ~১ ডিগ্রি = ১১১ কিমি
  const viewbox = `${lng - deg},${lat + deg},${lng + deg},${lat - deg}`;
  const out = [];
  for (const amenity of amenities) {
    try {
      const url = 'https://nominatim.openstreetmap.org/search?format=json' +
        `&amenity=${amenity}&viewbox=${viewbox}&bounded=1&limit=20` +
        '&addressdetails=1&extratags=1&accept-language=' + state.lang;
      const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
      if (!res.ok) continue;
      const arr = await res.json();
      for (const p of arr) {
        const plat = parseFloat(p.lat), plng = parseFloat(p.lon);
        const dist = haversineMeters(lat, lng, plat, plng);
        if (dist > radiusKm * 1000) continue;
        const tags = p.extratags || {};
        out.push({
          osm: true,
          osmId: p.osm_type + '/' + p.osm_id,
          name: p.display_name.split(',')[0],
          address: p.display_name,
          lat: plat, lng: plng, dist,
          phone: tags['contact:phone'] || tags.phone || null,
          amenity
        });
      }
    } catch (e) { /* OSM না পেলে চুপচাপ এগিয়ে যান */ }
  }
  // একই জায়গা দুই amenity-তে এলে একবার রাখুন
  const seen = new Set();
  return out.filter(p => {
    const k = p.lat.toFixed(4) + ',' + p.lng.toFixed(4) + '|' + p.name;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).sort((a, b) => a.dist - b.dist);
}

// ---------- Firebase চালু ----------

async function initFirebase() {
  const appMod = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js');
  const authMod = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js');
  const fsMod = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
  fb = { ...appMod, ...authMod, ...fsMod };
  const app = fb.initializeApp(firebaseConfig);
  auth = fb.getAuth(app);
  db = fb.getFirestore(app);
  // আগের লগইন সেশন (পাসওয়ার্ড অ্যাকাউন্ট) থাকলে সেটাই ব্যবহার করুন —
  // না থাকলে অ্যানোনিমাস লগইন করুন। সরাসরি signInAnonymously করলে
  // আগের পাসওয়ার্ড সেশন মুছে যেত।
  const existing = await new Promise(resolve => {
    const unsub = fb.onAuthStateChanged(auth, u => { unsub(); resolve(u); });
  });
  if (existing) {
    user = existing;
  } else {
    const cred = await fb.signInAnonymously(auth);
    user = cred.user;
  }
}

async function loadFirestoreData() {
  if (!db) return;
  try {
    const [dSnap, hSnap, drSnap, rSnap, tSnap, repSnap, reqSnap] = await Promise.all([
      fb.getDocs(fb.collection(db, 'donors')),
      fb.getDocs(fb.collection(db, 'hospitals')),
      fb.getDocs(fb.collection(db, 'doctors')),
      fb.getDocs(fb.collection(db, 'reviews')),
      fb.getDocs(fb.collection(db, 'takedowns')),
      fb.getDocs(fb.collection(db, 'reports')),
      fb.getDocs(fb.collection(db, 'requests'))
    ]);
    state.donors = dSnap.docs.map(d => ({ id: d.id, source: 'registered', ...d.data() }));
    state.hospitals = hSnap.docs.map(d => ({ id: d.id, source: 'registered', ...d.data() }));
    state.doctors = drSnap.docs.map(d => ({ id: d.id, source: 'registered', ...d.data() }));
    state.reviews = rSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    state.requests = reqSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    state.takedowns = new Set(tSnap.docs.map(d => normalizePhone(d.data().phone || d.id)));
    state.reports = repSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    state.reportCounts = {};
    state.reports.forEach(r => {
      const k = r.targetType + ':' + r.targetKey;
      state.reportCounts[k] = (state.reportCounts[k] || 0) + 1;
    });
  } catch (e) {
    console.error('Firestore load failed', e);
  }
}

// localStorage-এ সরানো সিড-ডোনার (Firebase না থাকলে)
function localTakedowns() {
  try { return JSON.parse(localStorage.getItem('rb_takedowns') || '[]'); }
  catch { return []; }
}

function isTakenDown(phone) {
  const n = normalizePhone(phone);
  return state.takedowns.has(n) || localTakedowns().includes(n);
}

// ---------- একত্রিত ডেটা (Firestore + সিড) ----------

// তালিকার স্থিতিশীল চাবি — রেজিস্টার্ড ডকুমেন্টে id, সিডে ফোন/নাম
function entryKey(type, e) {
  if (e.id) return e.id;
  if (type === 'donor' && e.phone) return 'phone:' + normalizePhone(e.phone);
  return 'name:' + (e.name || '');
}

// ৩+ রিপোর্ট পেলে তালিকা সবার কাছ থেকে লুকিয়ে যাবে (মডারেশন)
function isReportedOut(type, e) {
  return (state.reportCounts[type + ':' + entryKey(type, e)] || 0) >= 3;
}

// এই ডিভাইসে ব্যবহারকারী নিজে লুকিয়েছে কি না
function isBlocked(type, e) {
  return state.blocked.has(type + ':' + entryKey(type, e));
}

function allDonors() {
  const seeds = SEED_DONORS
    .filter(s => !isTakenDown(s.phone))
    .map(s => ({ ...s, source: 'public', publicListing: true, paused: false }));
  return [...state.donors, ...seeds]
    .filter(d => !isReportedOut('donor', d) && !isBlocked('donor', d));
}

function allHospitals() {
  const seeds = SEED_HOSPITALS.map(s => ({ ...s, source: 'public', publicListing: true }));
  return [...state.hospitals, ...seeds]
    .filter(h => !isReportedOut('hospital', h) && !isBlocked('hospital', h));
}

function allDoctors() {
  const seeds = SEED_DOCTORS.map(s => ({ ...s, source: 'public', publicListing: true }));
  return [...state.doctors, ...seeds]
    .filter(d => !isReportedOut('doctor', d) && !isBlocked('doctor', d));
}

function allBloodOrgs() {
  return SEED_BLOOD_ORGS.map(s => ({ ...s, source: 'public', publicListing: true }));
}

// জরুরি অনুরোধ — শুধু আসল ব্যবহারকারীর অনুরোধ (কোনো সিড/ডেমো নেই)
function allRequests() {
  return state.requests.filter(r => !isReportedOut('request', r) && !isBlocked('request', r));
}
function openRequests() {
  const ts = r => (r.createdAt && r.createdAt.seconds) ? r.createdAt.seconds : 0;
  return allRequests()
    .filter(r => r.status !== 'fulfilled')
    .sort((a, b) => ts(b) - ts(a));
}

// এন্ট্রির অবস্থান: নিজের lat/lng → জেলার কেন্দ্র → null
function entryPos(e) {
  if (e.lat != null && e.lng != null) return { lat: e.lat, lng: e.lng, approx: !!e.approxCoords };
  const c = districtCenter(e.district);
  if (c) return { lat: c[0], lng: c[1], approx: true };
  return null;
}

// ---------- পরিসংখ্যান + গ্রুপ টাইল ----------

function renderStats() {
  if (!$('stat-total')) return; // v9-এ পরিসংখ্যান ব্যান্ড নেই
  const donors = allDonors().filter(d => !d.paused);
  const ready = donors.filter(d => isReadyToDonate(d.lastDonation));
  const groupsCovered = new Set(ready.map(d => d.bloodGroup)).size;
  $('stat-total').textContent = num(donors.length);
  $('stat-ready').textContent = num(ready.length);
  $('stat-coverage').textContent = state.lang === 'bn'
    ? `${toBn(groupsCovered)}/৮` : `${groupsCovered}/8`;
}

function renderGroupTiles() {
  // হোম + রক্ত ট্যাব — দুই জায়গাতেই একই টাইল (মক: শুধু গ্রুপের নাম)
  const html = BLOOD_GROUPS.map(g =>
    `<button type="button" class="tile ${state.group === g ? 'active' : ''}" data-group="${g}"><b>${g}</b></button>`
  ).join('');
  ['group-tiles', 'group-tiles-donors'].forEach(id => {
    const box = $(id);
    if (box) box.innerHTML = html;
  });
  document.querySelectorAll('#group-tiles .tile, #group-tiles-donors .tile').forEach(btn => {
    btn.addEventListener('click', () => {
      state.group = btn.getAttribute('data-group');
      renderGroupTiles();
    });
  });
  // হোমের "O+ রক্তদাতা খুঁজুন" বাটন + রক্ত ট্যাবের শিরোনাম
  const findLabel = $('find-donors-label');
  if (findLabel) findLabel.textContent = state.group
    ? `${state.group} ${tr('find_donors_suffix')}` : tr('find_donors_suffix');
  const title = $('donors-title');
  if (title) title.textContent = state.group
    ? `${state.group} ${tr('donors_title_suffix')}` : tr('nav_donors');
}

function renderCompatChart() {
  let html = `<table class="compat-table"><tr><th>↓ ${tr('compat_give')} / ${tr('compat_receive')} →</th>` +
    BLOOD_GROUPS.map(g => `<th>${g}</th>`).join('') + '</tr>';
  for (const donor of BLOOD_GROUPS) {
    html += `<tr><th>${donor}</th>` + BLOOD_GROUPS.map(patient =>
      `<td class="${isCompatible(donor, patient) ? 'yes' : 'no'}">${isCompatible(donor, patient) ? '✓' : '·'}</td>`
    ).join('') + '</tr>';
  }
  html += '</table>';
  $('compat-chart').innerHTML = `<div class="compat-wrap">${html}</div>`;
}

function renderOrgs() {
  $('org-list').innerHTML = allBloodOrgs().map(o => `
    <div class="listing">
      <div class="avatar red">${esc(initials(o.name_en || o.name))}</div>
      <div class="listing-body">
        <h3>${esc(o.name)} <span class="badge public">${tr('public_listing')}</span></h3>
        <p>${esc(o.address || '')}</p>
        <div class="listing-actions">
          ${o.phone ? `<a class="btn" href="tel:${esc(o.phone.replace(/[^0-9+]/g, ''))}">📞 ${tr('call_btn')}</a>` : ''}
          ${o.website ? `<a class="btn secondary" href="${esc(o.website)}" target="_blank" rel="noopener">${tr('website_btn')}</a>` : ''}
        </div>
      </div>
    </div>`).join('') || `<p class="empty">${tr('no_donors')}</p>`;
}

function renderSpecialties() {
  // বিশেষজ্ঞতার পিল (মক: সব / মেডিসিন / হৃদরোগ / গাইনি…)
  const specs = [...new Set(allDoctors().map(d => d.specialty).filter(Boolean))].sort().slice(0, 6);
  const box = $('specialty-pills');
  if (!box) return;
  box.innerHTML = `<button type="button" data-spec="" class="${!state.doctorSpec ? 'active' : ''}">${tr('filter_all_spec')}</button>` +
    specs.map(s => `<button type="button" data-spec="${esc(s)}" class="${state.doctorSpec === s ? 'active' : ''}">${esc(s)}</button>`).join('');
  box.querySelectorAll('button').forEach(b => {
    b.addEventListener('click', () => {
      state.doctorSpec = b.getAttribute('data-spec');
      renderSpecialties();
      if ($('doctor-results').innerHTML.trim()) searchDoctors();
    });
  });
}

function renderDistrictList() {
  const districts = [...new Set(
    Object.keys(BD_DISTRICTS_FALLBACK).concat(allDonors().map(d => d.district).filter(Boolean))
  )].sort();
  $('district-list').innerHTML = districts.map(d => `<option value="${esc(d)}">`).join('');
}

// ---------- খোঁজা: ডোনার ----------

// কার্ডের নিচে রিপোর্ট + লুকান (Play UGC নীতি: ইন-অ্যাপ রিপোর্টিং)
function cardTools(type, e) {
  const key = entryKey(type, e);
  return `<p class="card-tools"><button type="button" class="link-btn" data-report-type="${type}" data-report-key="${esc(key)}">${tr('report_btn')}</button> • <button type="button" class="link-btn" data-hide-type="${type}" data-hide-key="${esc(key)}">${tr('hide_btn')}</button></p>`;
}

function donorCard(d, distMeters) {
  const ready = isReadyToDonate(d.lastDonation);
  const badges = [];
  // শেষ দানের তারিখ থাকলে ৯০ দিনের নিয়ম; না থাকলে আগের আচরণই (প্রস্তুত)
  if (d.lastDonation && !ready) badges.push(`<span class="badge warn">${tr('resting_badge')}</span>`);
  else if (ready) badges.push(`<span class="badge ok">${tr('ready_badge')}</span>`);
  if (d.source === 'registered') badges.push(`<span class="badge teal">${tr('volunteer_free')}</span>`);
  if (d.publicListing) badges.push(`<span class="badge public">${tr('public_listing')} • ${tr('not_verified')}</span>`);
  return `<div class="listing">
    <div class="listing-main">
      <div class="group-badge">${esc(d.bloodGroup)}</div>
      <div class="listing-body">
        <h3>${esc(d.name)}</h3>
        <p class="donor-line">${SVG_PHONE}<span>${esc(maskPhone(d.phone))}</span></p>
        <p class="donor-line">${SVG_PIN}<span>${esc([d.area, d.district].filter(Boolean).join(', '))}${d.profession ? ' • ' + esc(d.profession) : ''}</span></p>
        ${d.lastDonation ? `<p>${tr('last_donation_label')}: ${esc(d.lastDonation)}</p>` : ''}
        ${d.sourceUrl ? `<p><a href="${esc(d.sourceUrl)}" target="_blank" rel="noopener">${tr('source_link')}</a></p>` : ''}
      </div>
      <div class="listing-side">
        ${distMeters != null ? `<span class="badge dist-pill">${fmtDistance(distMeters, state.lang)}</span>` : ''}
        <a class="round-btn teal" href="tel:${esc(String(d.phone).replace(/[^0-9+]/g, ''))}" aria-label="${tr('call_btn')}">${SVG_PHONE}</a>
      </div>
    </div>
    <div class="listing-foot">
      <div class="badge-row">${badges.join('')}</div>
      ${cardTools('donor', d)}
    </div>
  </div>`;
}

async function ensurePosition(districtInputId, statusId) {
  // GPS আগে সেট করা থাকলে সেটাই; না হলে জেলার লেখা থেকে
  if (state.pos) return state.pos;
  const text = $(districtInputId).value.trim();
  if (!text) throw new Error('noloc');
  $(statusId).textContent = tr('searching');
  const pos = await resolvePlace(text);
  state.pos = pos;
  return pos;
}

async function searchDonors() {
  if (!state.group) return toast(tr('err_group'), true);
  let pos;
  try {
    pos = await ensurePosition('input-district', 'search-status');
  } catch (e) {
    return toast(tr('err_location_needed'), true);
  }
  $('search-status').textContent = tr('searching');
  const radiusM = state.radiusKm * 1000;
  const givers = compatibleDonorGroups(state.group);

  // ফিল্টার: কাছের আগে = এক্স্যাক্ট গ্রুপ আগে তারপর দূরত্ব;
  // সবাই = শুধু দূরত্ব; সক্রিয় = শুধু প্রস্তুত ডোনার
  let pool = allDonors()
    .filter(d => !d.paused)
    .filter(d => givers.includes(d.bloodGroup));
  if (state.donorFilter === 'ready') pool = pool.filter(d => isReadyToDonate(d.lastDonation));
  const scored = pool
    .map(d => {
      const p = entryPos(d);
      if (!p) return null;
      const dist = haversineMeters(pos.lat, pos.lng, p.lat, p.lng);
      return { d, dist };
    })
    .filter(x => x && x.dist <= radiusM)
    .sort((a, b) => {
      if (state.donorFilter === 'near') {
        const aExact = a.d.bloodGroup === state.group ? 0 : 1;
        const bExact = b.d.bloodGroup === state.group ? 0 : 1;
        if (aExact !== bExact) return aExact - bExact;
      }
      return a.dist - b.dist;
    });

  $('search-status').textContent = '';
  $('donors-subtitle').textContent = [tr('donors_found_a'), num(scored.length), tr('donors_found_b')].filter(Boolean).join(' ');
  $('donor-results').innerHTML = scored.length
    ? scored.map(x => donorCard(x.d, x.dist)).join('')
    : `<div class="card empty"><b>${tr('no_donors')}</b><br>${tr('no_donors_hint')}</div>`;
  bindReportButtons();
}

// ---------- খোঁজা: হাসপাতাল / ডাক্তার ----------

function avgRating(targetType, targetId) {
  const rs = state.reviews.filter(r => r.targetType === targetType && r.targetId === targetId
    && (state.reportCounts['review:' + r.id] || 0) < 3);
  if (!rs.length) return { avg: 0, count: 0 };
  return { avg: rs.reduce((s, r) => s + r.stars, 0) / rs.length, count: rs.length };
}

function starsHtml(avg) {
  if (!avg) return '';
  const full = Math.round(avg);
  return '★'.repeat(full) + '☆'.repeat(5 - full) + ` (${avg.toFixed(1)})`;
}

// হাসপাতালের ট্যাগ — শুধু facilities লেখা থেকে বের করা, কিছুই অনুমান নয়
function hospitalTag(h) {
  const f = (h.facilities || '').toLowerCase();
  if (/emergency|ইমার্জেন্সি/.test(f) && /24\/7|24x7|24 hours/.test(f)) return { text: tr('tag_emergency'), cls: 'pink' };
  if (/emergency|ইমার্জেন্সি/.test(f)) return { text: tr('tag_emergency_plain'), cls: 'pink' };
  if (/blood bank|ব্লাড ব্যাংক/.test(f)) return { text: tr('tag_bloodbank'), cls: 'green' };
  const first = (h.facilities || '').split(',')[0].trim();
  if (first) return { text: first, cls: 'blue' };
  return null;
}

function hospitalCard(h, distMeters) {
  const r = h.id && h.source === 'registered' ? avgRating('hospital', h.id) : { avg: 0, count: 0 };
  const tag = hospitalTag(h);
  const badges = [];
  if (h.publicListing) badges.push(`<span class="badge public">${tr('public_listing')}</span>`);
  if (h.licenceProvided) badges.push(`<span class="badge ok">${tr('f_licence_provided')}</span>`);
  return `<div class="listing">
    <div class="listing-main">
      <div class="icon-box blue">${SVG_HOSP}</div>
      <div class="listing-body">
        <h3>${esc(h.name)}</h3>
        ${tag ? `<p><span class="tag-pill ${tag.cls}">${esc(tag.text)}</span></p>` : ''}
        ${h.address ? `<p>${esc(h.address)}</p>` : ''}
        ${h.doctorsHere ? `<p>${tr('doctors_here_label')}: ${esc(h.doctorsHere)}</p>` : ''}
        ${r.count ? `<p>${starsHtml(r.avg)} • ${num(r.count)} ${tr('reviews_title')}</p>` : ''}
      </div>
      <div class="listing-side">
        ${distMeters != null ? `<span class="badge dist-pill blue">${fmtDistance(distMeters, state.lang)}</span>` : ''}
        ${h.lat != null ? `<a class="round-btn blue" target="_blank" rel="noopener" href="https://www.google.com/maps/dir/?api=1&destination=${h.lat},${h.lng}" aria-label="${tr('directions_btn')}">${SVG_NAV}</a>` : ''}
      </div>
    </div>
    <div class="listing-foot">
      <div class="badge-row">${badges.join('')}</div>
      <div class="listing-actions">
        ${h.phone ? `<a class="btn small" href="tel:${esc(String(h.phone).replace(/[^0-9+]/g, ''))}">${SVG_PHONE} ${tr('call_btn')}</a>` : ''}
        ${h.id && h.source === 'registered' ? `<button class="btn small navy" data-review="hospital:${h.id}">${tr('add_review')}</button>` : ''}
      </div>
      ${cardTools('hospital', h)}
    </div>
  </div>`;
}

function osmPlaceCard(p) {
  const isDoctor = p.amenity === 'doctors';
  return `<div class="listing">
    <div class="listing-main">
      <div class="icon-box ${isDoctor ? 'teal' : 'blue'}">${isDoctor ? SVG_STETH : SVG_HOSP}</div>
      <div class="listing-body">
        <h3>${esc(p.name)}</h3>
        <p>${esc(p.address)}</p>
        <p><span class="badge grey">OpenStreetMap</span></p>
      </div>
      <div class="listing-side">
        <span class="badge dist-pill ${isDoctor ? '' : 'blue'}">${fmtDistance(p.dist, state.lang)}</span>
        <a class="round-btn blue" target="_blank" rel="noopener" href="https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lng}" aria-label="${tr('directions_btn')}">${SVG_NAV}</a>
      </div>
    </div>
    ${p.phone ? `<div class="listing-foot"><div class="listing-actions"><a class="btn small" href="tel:${esc(String(p.phone).replace(/[^0-9+]/g, ''))}">${SVG_PHONE} ${tr('call_btn')}</a></div></div>` : ''}
  </div>`;
}

async function searchHospitals() {
  let pos;
  try {
    pos = await ensurePosition('input-district-h', 'search-status-h');
  } catch (e) {
    return toast(tr('err_location_needed'), true);
  }
  $('search-status-h').textContent = tr('searching');
  const radiusM = state.radiusKm * 1000;
  const mine = allHospitals().map(h => {
    const p = entryPos(h);
    if (!p) return null;
    return { h, dist: haversineMeters(pos.lat, pos.lng, p.lat, p.lng) };
  }).filter(x => x && x.dist <= radiusM).sort((a, b) => a.dist - b.dist);

  // রেজিস্টার্ড তালিকা আগে দেখান, তারপর OSM-এর আসল জায়গা
  let html = mine.map(x => hospitalCard(x.h, x.dist)).join('');
  $('hospital-results').innerHTML = html || '';
  const osm = await osmNearby(['hospital', 'clinic'], pos.lat, pos.lng, state.radiusKm);
  html += osm.map(osmPlaceCard).join('');
  $('search-status-h').textContent = '';
  const total = mine.length + osm.length;
  const area = (pos.label && pos.label !== 'GPS') ? pos.label : ($('input-district-h').value.trim() || nearestDistrict(pos.lat, pos.lng) || '');
  $('hospitals-subtitle').textContent = area
    ? (state.lang === 'bn' ? `${area}${tr('hospitals_near_suffix')} ${num(total)}টি` : `${num(total)} ${tr('results_hospitals')} ${tr('hospitals_near_suffix')} ${area}`)
    : `${num(total)} ${tr('results_hospitals')}`;
  $('hospital-results').innerHTML = html ||
    `<div class="card empty"><b>${tr('no_hospitals')}</b></div>`;
  updateMapMarkers(
    mine.map(x => ({ lat: x.h.lat, lng: x.h.lng, name: x.h.name }))
      .concat(osm.map(p => ({ lat: p.lat, lng: p.lng, name: p.name }))));
  bindReviewButtons();
  bindReportButtons();
}

function doctorCard(d, distMeters) {
  const r = d.id && d.source === 'registered' ? avgRating('doctor', d.id) : { avg: 0, count: 0 };
  const degrees = (d.degree || '').split(',').map(x => x.trim()).filter(Boolean).slice(0, 3);
  const badges = [];
  if (d.publicListing) badges.push(`<span class="badge public">${tr('public_listing')}</span>`);
  if (d.workplaceType === 'government') badges.push(`<span class="badge info">${tr('govt_yes')}</span>`);
  return `<div class="listing">
    <div class="listing-main">
      <div class="icon-box teal">${SVG_STETH}</div>
      <div class="listing-body">
        <h3>${esc(d.name)}</h3>
        <p class="spec-line">${esc(d.specialty || '')}${d.workplace ? ' • ' + esc(d.workplace) : ''}</p>
        ${d.regNumber ? `<p>Reg: ${esc(d.regNumber)}</p>` : ''}
        ${r.count ? `<p>${starsHtml(r.avg)} • ${num(r.count)} ${tr('reviews_title')}</p>` : ''}
      </div>
      <div class="listing-side">
        ${distMeters != null ? `<span class="badge dist-pill blue">${fmtDistance(distMeters, state.lang)}</span>` : ''}
      </div>
    </div>
    <div class="listing-foot">
      <div class="degree-chips">${degrees.map(x => `<span>${esc(x)}</span>`).join('')}</div>
      <div class="listing-actions">
        ${(d.phone || d.workplace) ? `<button class="btn navy pill" data-appt="${esc(entryKey('doctor', d))}">${tr('appointment_btn_short')}</button>` : ''}
        ${d.id && d.source === 'registered' ? `<button class="btn small" data-review="doctor:${d.id}">${tr('add_review')}</button>` : ''}
      </div>
    </div>
    <div class="listing-foot">
      <div class="badge-row">${badges.join('')}</div>
      ${cardTools('doctor', d)}
    </div>
  </div>`;
}

async function searchDoctors() {
  let pos;
  try {
    pos = await ensurePosition('input-district-d', 'search-status-d');
  } catch (e) {
    return toast(tr('err_location_needed'), true);
  }
  $('search-status-d').textContent = tr('searching');
  const radiusM = state.radiusKm * 1000;
  const spec = state.doctorSpec;
  const mine = allDoctors()
    .filter(d => !spec || d.specialty === spec)
    .map(d => {
      const p = entryPos(d);
      if (!p) return null;
      return { d, dist: haversineMeters(pos.lat, pos.lng, p.lat, p.lng) };
    }).filter(x => x && x.dist <= radiusM).sort((a, b) => a.dist - b.dist);

  let html = mine.map(x => doctorCard(x.d, x.dist)).join('');
  $('doctor-results').innerHTML = html || '';
  const osm = await osmNearby(['doctors', 'clinic'], pos.lat, pos.lng, state.radiusKm);
  html += osm.map(osmPlaceCard).join('');
  $('search-status-d').textContent = '';
  const total = mine.length + osm.length;
  $('doctors-subtitle').textContent = [tr('doctors_found_a'), num(total), tr('doctors_found_b')].filter(Boolean).join(' ');
  $('doctor-results').innerHTML = html ||
    `<div class="card empty"><b>${tr('no_doctors')}</b></div>`;
  bindReviewButtons();
  bindReportButtons();
  bindAppointmentButtons();
}

// ---------- সবকিছু খোঁজা (ইউনিভার্সাল সার্চ) ----------

// লেখা থেকে রক্তের গ্রুপ বের করুন — লাতিন (B+, AB-) ও বাংলা (বি পজেটিভ)
function parseBloodGroup(q) {
  const m = q.match(/\b(AB|A|B|O)\s*[+-]/i)
    || q.match(/\b(AB|A|B|O)\s+(positive|negative|pos|neg)\b/i);
  if (m) {
    const base = m[1].toUpperCase();
    const neg = /-|negative|neg/i.test(m[2] || m[0].slice(m[1].length));
    return base + (neg ? '-' : '+');
  }
  const bn = q.match(/(এবি|এ|বি|ও)\s*(পজেটিভ|পজিটিভ|নেগেটিভ)/);
  if (bn) {
    const base = { 'এবি': 'AB', 'এ': 'A', 'বি': 'B', 'ও': 'O' }[bn[1]];
    return base + (bn[2] === 'নেগেটিভ' ? '-' : '+');
  }
  return null;
}

// লেখার ভেতরে শব্দ আছে কি না — ইংরেজিতে শব্দের সীমানা মেনে, বাংলায় সরাসরি
function wordIn(q, word) {
  if (/^[a-z][a-z. ]*$/i.test(word)) {
    const escW = word.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
    return new RegExp('\\b' + escW, 'i').test(q);
  }
  return q.includes(word);
}

// লেখা থেকে জেলা বের করুন — জেলার ইংরেজি+বাংলা দুই নামই ফেরত দেয়
function parseDistrict(q) {
  const low = q.toLowerCase();
  let best = null;
  for (const name of Object.keys(BD_DISTRICTS_FALLBACK)) {
    if (low.includes(name.toLowerCase()) && (!best || name.length > best.length)) best = name;
  }
  if (!best) return null;
  const c = BD_DISTRICTS_FALLBACK[best];
  const names = Object.keys(BD_DISTRICTS_FALLBACK).filter(k => {
    const v = BD_DISTRICTS_FALLBACK[k];
    return v[0] === c[0] && v[1] === c[1];
  });
  return { names, center: { lat: c[0], lng: c[1] } };
}

// বিশেষজ্ঞতার বাংলা/ইংরেজি শব্দ → ইংরেজি বিশেষজ্ঞতায় মিলবে এমন সূত্র
const SPECIALTY_ALIASES = [
  ['সার্জারি', 'surg'], ['সার্জিক্যাল', 'surg'], ['surgery', 'surg'], ['surgical', 'surg'],
  ['কার্ডিও', 'cardio'], ['হৃদরোগ', 'cardio'], ['হার্ট', 'cardio'], ['cardiology', 'cardio'],
  ['শিশু', 'pediat'], ['child', 'pediat'], ['paediatric', 'pediat'], ['pediatric', 'pediat'],
  ['চোখ', 'ophthalm'], ['eye', 'ophthalm'],
  ['দাঁত', 'dent'], ['dental', 'dent'],
  ['চর্ম', 'dermat'], ['skin', 'dermat'],
  ['গাইনি', 'gynae'], ['gynae', 'gynae'],
  ['অর্থো', 'ortho'], ['হাড়', 'ortho'], ['ortho', 'ortho'],
  ['নাক কান গলা', 'ent'], ['ent', 'ent'],
  ['মেডিসিন', 'medicine'], ['medicine', 'medicine'],
  ['ডায়াবেটিস', 'diabet'], ['diabetes', 'diabet'],
  ['কিডনি', 'nephr'], ['kidney', 'nephr'],
  ['নিউরো', 'neuro'], ['মস্তিষ্ক', 'neuro'],
  ['মানসিক', 'psych'], ['psych', 'psych'],
  ['ক্যান্সার', 'oncol'], ['cancer', 'oncol'],
  ['গ্যাস্ট্রো', 'gastro']
];

function specialtyNeedle(q) {
  for (const [word, needle] of SPECIALTY_ALIASES) {
    if (wordIn(q, word)) return needle;
  }
  return null;
}

const DOCTOR_WORDS = ['ডাক্তার', 'ডাঃ', 'চিকিৎসক', 'doctor', 'dr.'];
const HOSPITAL_WORDS = ['হাসপাতাল', 'hospital', 'ক্লিনিক', 'clinic', 'নার্সিং'];
const DONOR_WORDS = ['রক্ত', 'blood', 'ডোনার', 'donor', 'ব্লাড'];

function searchUniversal() {
  const q = $('input-universal').value.trim();
  if (!q) { $('uni-results').innerHTML = ''; $('uni-status').textContent = ''; return; }
  showSearchView();
  $('uni-status').textContent = tr('searching');

  const group = parseBloodGroup(q);
  const district = parseDistrict(q);
  const specNeedle = specialtyNeedle(q);
  const wantDoctor = DOCTOR_WORDS.some(w => wordIn(q, w)) || !!specNeedle;
  const wantHospital = HOSPITAL_WORDS.some(w => wordIn(q, w));
  const wantDonor = DONOR_WORDS.some(w => wordIn(q, w)) || !!group;
  const anyCategory = wantDoctor || wantHospital || wantDonor;
  const tokens = q.toLowerCase().split(/[\s,]+/).filter(t => t.length >= 2);
  const tokenMatch = hay => tokens.some(t => hay.includes(t));

  // দূরত্বের রেফারেন্স: GPS থাকলে সেটা, না হলে লেখায় থাকা জেলার কেন্দ্র
  const ref = state.pos || (district ? district.center : null);
  const withDist = e => {
    if (!ref) return null;
    const p = entryPos(e);
    return p ? haversineMeters(ref.lat, ref.lng, p.lat, p.lng) : null;
  };
  const inDistrict = e => {
    if (!district) return true;
    const hay = `${e.district || ''} ${e.address || ''} ${e.area || ''} ${e.workplace || ''}`.toLowerCase();
    return district.names.some(n => hay.includes(n.toLowerCase()));
  };
  const byDist = (a, b) => {
    if (a.dist != null && b.dist != null) return a.dist - b.dist;
    if (a.dist != null) return -1;
    if (b.dist != null) return 1;
    return 0;
  };

  let donors = [];
  if (!anyCategory || wantDonor) {
    donors = allDonors().filter(d => !d.paused)
      .filter(d => inDistrict(d))
      .filter(d => {
        if (group) return compatibleDonorGroups(group).includes(d.bloodGroup);
        if (anyCategory) return true;
        return tokenMatch(`${d.name} ${d.bloodGroup} ${d.district || ''} ${d.area || ''} ${d.address || ''} ${d.profession || ''}`.toLowerCase());
      })
      .map(d => ({ d, dist: withDist(d) }))
      .sort((a, b) => {
        if (group) {
          const ae = a.d.bloodGroup === group ? 0 : 1, be = b.d.bloodGroup === group ? 0 : 1;
          if (ae !== be) return ae - be;
        }
        return byDist(a, b);
      }).slice(0, 50);
  }

  let hospitals = [];
  if (!anyCategory || wantHospital) {
    hospitals = allHospitals()
      .filter(h => inDistrict(h))
      .filter(h => anyCategory || tokenMatch(`${h.name} ${h.address || ''} ${h.facilities || ''} ${h.doctorsHere || ''}`.toLowerCase()))
      .map(h => ({ d: h, dist: withDist(h) }))
      .sort(byDist).slice(0, 50);
  }

  let doctors = [];
  if (!anyCategory || wantDoctor) {
    doctors = allDoctors()
      .filter(d => inDistrict(d))
      .filter(d => {
        if (specNeedle) return (d.specialty || '').toLowerCase().includes(specNeedle);
        if (anyCategory) return true;
        return tokenMatch(`${d.name} ${d.degree || ''} ${d.specialty || ''} ${d.workplace || ''} ${d.address || ''}`.toLowerCase());
      })
      .map(d => ({ d, dist: withDist(d) }))
      .sort(byDist).slice(0, 50);
  }

  const section = (title, items, card) => items.length
    ? `<h2 class="results-heading">${title} (${num(items.length)})</h2>` + items.map(x => card(x.d, x.dist)).join('')
    : '';
  const html = section(tr('results_donors'), donors, donorCard)
    + section(tr('results_hospitals'), hospitals, hospitalCard)
    + section(tr('results_doctors'), doctors, doctorCard);
  $('uni-status').textContent = '';
  $('uni-results').innerHTML = html ||
    `<div class="card empty"><b>${tr('uni_no_results')}</b><br>${tr('uni_no_results_hint')}</div>`;
  bindReviewButtons();
  bindReportButtons();
  bindAppointmentButtons();
}

// ---------- রিভিউ ----------

function bindReviewButtons() {
  document.querySelectorAll('[data-review]').forEach(btn => {
    btn.addEventListener('click', () => {
      const [type, id] = btn.getAttribute('data-review').split(':');
      openReviewPanel(type, id);
    });
  });
}

// ---------- অ্যাপয়েন্টমেন্ট ----------
// ডাক্তারকে সরাসরি কল নয় — তার কর্মস্থল হাসপাতালের নাম্বারে কল করে
// অ্যাপয়েন্টমেন্ট নিতে হয়। কর্মস্থলের নাম মিলিয়ে হাসপাতাল খুঁজুন।
function findHospitalForDoctor(d) {
  const wp = (d.workplace || '').toLowerCase().trim();
  if (!wp) return null;
  return allHospitals().find(h => {
    const hn = (h.name || '').toLowerCase().trim();
    return hn && (wp.includes(hn) || hn.includes(wp));
  }) || null;
}

function openAppointmentModal(key) {
  // state.doctors-এ শুধু রেজিস্টার্ড ডাক্তার থাকে — সিড ডাক্তার allDoctors()-এ
  const d = key.startsWith('name:')
    ? allDoctors().find(x => x.name === key.slice(5))
    : allDoctors().find(x => x.id === key);
  if (!d) return;
  const hosp = findHospitalForDoctor(d);
  const hospName = hosp ? hosp.name : (d.workplace || '');
  const hospPhone = (hosp && hosp.phone) ? hosp.phone : d.phone;
  $('appt-body').innerHTML = `
    <div class="appt-head">
      <h3>${esc(d.name)}</h3>
      <p>${esc(d.degree || '')}${d.specialty ? ' • ' + esc(d.specialty) : ''}</p>
      <p><b>${tr('appointment_workplace')}:</b> ${esc(hospName)}</p>
    </div>
    <p class="muted small">${tr('appointment_note')}</p>
    ${hospPhone ? `
      <button class="btn big" id="btn-appt-show" type="button">${tr('appointment_show_number')}</button>
      <div id="appt-number" class="hidden">
        <p class="appt-number">${esc(hospPhone)}</p>
        <a class="btn big" href="tel:${esc(String(hospPhone).replace(/[^0-9+]/g, ''))}">${tr('appointment_call_hospital')}</a>
        <p class="muted small">${tr('appointment_hint')}</p>
      </div>` : `<p class="muted">${tr('no_phone')}</p>`}`;
  $('appointment-panel').classList.remove('hidden');
  const showBtn = $('btn-appt-show');
  if (showBtn) showBtn.addEventListener('click', () => {
    showBtn.classList.add('hidden');
    $('appt-number').classList.remove('hidden');
  });
}

function bindAppointmentButtons() {
  document.querySelectorAll('[data-appt]').forEach(btn => {
    btn.addEventListener('click', () => openAppointmentModal(btn.getAttribute('data-appt')));
  });
}

// ---------- রিপোর্ট + লুকান (UGC মডারেশন) ----------

async function reportListing(type, key) {
  if (!needFirebase()) return;
  if (state.reports.some(r => r.targetType === type && r.targetKey === key && r.reporterUid === (user && user.uid))) {
    return toast(tr('report_already'));
  }
  if (!confirm(tr('report_confirm'))) return;
  try {
    const ref = await fb.addDoc(fb.collection(db, 'reports'), {
      targetType: type, targetKey: key,
      reporterUid: user ? user.uid : null,
      createdAt: fb.serverTimestamp()
    });
    state.reports.push({ id: ref.id, targetType: type, targetKey: key, reporterUid: user ? user.uid : null });
    const k = type + ':' + key;
    state.reportCounts[k] = (state.reportCounts[k] || 0) + 1;
    toast(tr('report_sent'));
  } catch (e) {
    console.error('Report failed', e);
    toast(tr('err_required'), true);
  }
}

function hideListing(type, key, cardEl) {
  state.blocked.add(type + ':' + key);
  localStorage.setItem('rb_blocked', JSON.stringify([...state.blocked]));
  if (cardEl) cardEl.remove();
  toast(tr('hide_done'));
}

function bindReportButtons() {
  document.querySelectorAll('[data-report-type]').forEach(btn => {
    btn.addEventListener('click', () => {
      reportListing(btn.getAttribute('data-report-type'), btn.getAttribute('data-report-key'));
    });
  });
  document.querySelectorAll('[data-hide-type]').forEach(btn => {
    btn.addEventListener('click', () => {
      hideListing(btn.getAttribute('data-hide-type'), btn.getAttribute('data-hide-key'),
        btn.closest('.listing'));
    });
  });
}

function openReviewPanel(type, id) {
  state.reviewTarget = { type, id };
  state.reviewStars = 0;
  renderStars();
  const list = state.reviews.filter(r => r.targetType === type && r.targetId === id
    && (state.reportCounts['review:' + r.id] || 0) < 3);
  $('review-list').innerHTML = list.length
    ? list.map(r => `<div class="review-item"><b>${esc(r.name)}</b> — ${'★'.repeat(r.stars)}${'☆'.repeat(5 - r.stars)}<br>${esc(r.text || '')}<br><button type="button" class="link-btn" data-report-type="review" data-report-key="${esc(r.id)}">${tr('report_btn')}</button></div>`).join('')
    : `<p class="muted">${tr('no_reviews')}</p>`;
  bindReportButtons();
  $('review-panel').classList.remove('hidden');
}

function renderStars() {
  document.querySelectorAll('#review-stars button').forEach(b => {
    const n = Number(b.getAttribute('data-star'));
    b.textContent = n <= state.reviewStars ? '★' : '☆';
    b.classList.toggle('on', n <= state.reviewStars);
  });
}

async function submitReview(e) {
  e.preventDefault();
  if (!needFirebase()) return;
  if (!state.reviewTarget || state.reviewStars < 1) return toast(tr('rating_label'), true);
  const name = $('r-name').value.trim();
  if (!name) return toast(tr('err_required'), true);
  const ref = await fb.addDoc(fb.collection(db, 'reviews'), {
    targetType: state.reviewTarget.type,
    targetId: state.reviewTarget.id,
    stars: state.reviewStars,
    text: $('r-text').value.trim(),
    name,
    ownerUid: user.uid,
    createdAt: fb.serverTimestamp()
  });
  state.reviews.push({
    id: ref.id, targetType: state.reviewTarget.type, targetId: state.reviewTarget.id,
    stars: state.reviewStars, text: $('r-text').value.trim(), name
  });
  $('form-review').reset();
  state.reviewStars = 0;
  $('review-panel').classList.add('hidden');
  toast(tr('review_saved'));
}

// ---------- আমার তালিকা ----------

// ---------- ফোন + পাসওয়ার্ড লগইন / অ্যাকাউন্ট (v10) ----------
// Firebase Email/Password — ফোন নম্বর থেকে সিনথেটিক ইমেইল বানানো হয়।
// কোনো আসল ইমেইল লাগে না; Google সাইন-ইন নেই, SMS OTP নেই।
const AUTH_EMAIL_DOMAIN = 'roktodata.app';

function phoneToAuthEmail(phone) {
  return normalizePhone(phone) + '@' + AUTH_EMAIL_DOMAIN;
}
function authEmailToPhone(email) {
  const suffix = '@' + AUTH_EMAIL_DOMAIN;
  return (email || '').endsWith(suffix) ? email.slice(0, -suffix.length) : (email || '');
}
// পাসওয়ার্ড অ্যাকাউন্টে লগইন করা কি না (অ্যানোনিমাস নয়, ইমেইল আছে)
function isPasswordAccount() {
  return !!(user && !user.isAnonymous && user.email);
}

// প্রোফাইল আছে কি না — ডোনার/ডাক্তার/হাসপাতাল তালিকা থাকলেই প্রোফাইল আছে
// (শুধু রক্তের অনুরোধ থাকলে প্রোফাইল ধরা হয় না)
function hasProfileListing() {
  return state.myListings.some(m => m.type === 'donor' || m.type === 'hospital' || m.type === 'doctor');
}

// প্রোফাইল থাকলে লগইন কার্ড লুকান; না থাকলে দেখান।
// (রেজিস্ট্রেশন কার্ডের দৃশ্যমানতা এখন ফ্লো-ই দেখে — অ্যাকাউন্ট
// খোলার পর বা এডিটের সময় খোলে, বাকি সময় লুকানো থাকে।)
function updateProfileVisibility() {
  const hasProfile = hasProfileListing();
  const acc = $('account-card'); if (acc) acc.classList.toggle('hidden', hasProfile);
  // প্রোফাইল না থাকলে খালি "আমার প্রোফাইল" কার্ড দেখানোর দরকার নেই
  const prof = $('my-profile-card'); if (prof) prof.classList.toggle('hidden', !hasProfile);
  // "আমার তালিকা" শুধু তখনই দেখান যখন কিছু আছে (তালিকা বা রক্তের অনুরোধ);
  // একদম নতুন ব্যবহারকারীর কাছে খালি কার্ড দেখানোর দরকার নেই
  const list = $('my-listings-card'); if (list) list.classList.toggle('hidden', !state.myListings.length);
  const row = $('logout-row');
  if (row) {
    const showLogout = hasProfile && isPasswordAccount();
    row.classList.toggle('hidden', !showLogout);
    if (showLogout) {
      const ph = $('settings-account-phone');
      if (ph) ph.textContent = '📱 ' + authEmailToPhone(user.email);
      const lb = $('btn-logout-settings');
      if (lb) lb.onclick = logoutAccount;
    }
  }
}

// প্রোফাইল ট্যাবের উপরে অ্যাকাউন্ট কার্ড আঁকুন
function renderAccount() {
  updateProfileVisibility();
  const box = $('account-body');
  if (!box) return;
  if (isPasswordAccount()) {
    box.innerHTML = `<div class="account-logged">
      <p><b>📱 ${esc(authEmailToPhone(user.email))}</b></p>
      <p class="muted small">${tr('account_logged_in_hint')}</p>
      ${!hasProfileListing() ? `<button class="btn" id="btn-create-profile" type="button" style="margin-bottom:8px">${tr('create_profile_btn')}</button>` : ''}
      <button class="btn secondary" id="btn-logout" type="button">${tr('logout_btn')}</button>
    </div>`;
    $('btn-logout').addEventListener('click', logoutAccount);
    const cp = $('btn-create-profile');
    if (cp) cp.addEventListener('click', showRegTypes);
  } else {
    box.innerHTML = `<p class="muted">${tr('account_desc')}</p>
      <button class="btn" id="btn-open-login" type="button">${tr('login_btn')}</button>
      <button class="btn secondary" id="btn-open-create" type="button" style="margin-top:8px">${tr('create_account_btn')}</button>
      <p class="muted small">${tr('account_create_hint')}</p>`;
    $('btn-open-login').addEventListener('click', () => openAuth('login'));
    $('btn-open-create').addEventListener('click', () => openAuth('create'));
  }
}

let authMode = 'login'; // 'login' | 'create'
function openAuth(mode) {
  authMode = mode;
  $('auth-title').textContent = tr(mode === 'create' ? 'auth_create_title' : 'auth_login_title');
  $('auth-submit').textContent = tr(mode === 'create' ? 'auth_submit_create' : 'login_btn');
  $('auth-confirm-wrap').classList.toggle('hidden', mode !== 'create');
  $('auth-hint').classList.toggle('hidden', mode !== 'create');
  $('auth-phone').value = '';
  $('auth-password').value = '';
  $('auth-confirm').value = '';
  $('auth-panel').classList.remove('hidden');
  setTimeout(() => $('auth-phone').focus(), 100);
}

// Firebase এরর কোড → বন্ধুত্বপূর্ণ বাংলা বার্তা (কাঁচা কোড কখনো দেখাবেন না)
function authErrorMessage(err) {
  const code = err && err.code;
  if (code === 'auth/wrong-password' || code === 'auth/invalid-credential') return tr('auth_err_wrong_password');
  if (code === 'auth/user-not-found') return tr('auth_err_no_account');
  if (code === 'auth/email-already-in-use' || code === 'auth/credential-already-in-use') return tr('auth_err_exists');
  if (code === 'auth/weak-password') return tr('auth_err_weak_password');
  if (code === 'auth/network-request-failed') return tr('auth_err_network');
  return tr('auth_err_generic');
}

async function submitAuth(e) {
  e.preventDefault();
  const phoneRaw = $('auth-phone').value.trim();
  const pw = $('auth-password').value;
  const phone = normalizePhone(phoneRaw);
  if (state.country === 'Bangladesh') {
    if (!isValidBdPhone(phone)) return toast(tr('err_phone'), true);
  } else if (!/^[0-9+ ]{7,15}$/.test(phoneRaw)) {
    return toast(tr('err_phone'), true);
  }
  if (pw.length < 6) return toast(tr('auth_err_short_password'), true);
  if (authMode === 'create' && pw !== $('auth-confirm').value) {
    return toast(tr('auth_err_password_mismatch'), true);
  }
  // Firebase তৈরি না থাকলে (নেট নেই / এখনো লোড হচ্ছে) — লোকেশনের
  // মেসেজ নয়, লগইনের উপযোগী মেসেজ দেখান
  if (!isFirebaseConfigured) return toast(tr('config_warning'), true);
  if (!user) return toast(tr('auth_not_ready'), true);
  const btn = $('auth-submit');
  btn.disabled = true;
  btn.textContent = tr(authMode === 'create' ? 'auth_create_working' : 'auth_login_working');
  try {
    const email = phoneToAuthEmail(phone);
    if (authMode === 'create') {
      // অ্যানোনিমাস ইউজারের সঙ্গে লিংক — UID একই থাকে, আগের তালিকা থেকে যায়
      const credential = fb.EmailAuthProvider.credential(email, pw);
      const cred = await fb.linkWithCredential(user, credential);
      user = cred.user;
      toast(tr('auth_created'));
    } else {
      const cred = await fb.signInWithEmailAndPassword(auth, email, pw);
      user = cred.user;
      await loadFirestoreData();
      await reloadMyListingsFromAccount();
      toast(tr('auth_logged_in'));
    }
    $('auth-panel').classList.add('hidden');
    renderAccount();
    renderMyListings();
    renderHome();
    // নতুন অ্যাকাউন্ট খুললে সরাসরি রেজিস্ট্রেশনে যান (প্রোফাইল না থাকলে)
    if (authMode === 'create' && !hasProfileListing()) showRegTypes();
  } catch (err) {
    console.error(err);
    toast(authErrorMessage(err), true);
  } finally {
    btn.disabled = false;
    btn.textContent = tr(authMode === 'create' ? 'auth_submit_create' : 'login_btn');
  }
}

// লগইনের পর অ্যাকাউন্টের তালিকা Firestore থেকে নতুন করে আনুন।
// সতর্কতা: এই ডিভাইসের অ্যানোনিমাস তালিকা অ্যাকাউন্টের তালিকা দিয়ে
// বদলে যাবে — নতুন ফোনে নিজের তালিকা ফেরত পাওয়ার এটাই পথ।
async function reloadMyListingsFromAccount() {
  if (!db || !user) return;
  const cols = [['donors', 'donor'], ['hospitals', 'hospital'], ['doctors', 'doctor'], ['requests', 'request']];
  const mine = [];
  for (const [col, type] of cols) {
    const q = fb.query(fb.collection(db, col), fb.where('ownerUid', '==', user.uid));
    const snap = await fb.getDocs(q);
    snap.forEach(d => {
      const data = d.data();
      mine.push({ type, id: d.id, name: data.name || data.hospital || '' });
    });
  }
  state.myListings = mine;
  saveMyListings();
}

async function logoutAccount() {
  if (!needFirebase()) return;
  try {
    await fb.signOut(auth);
    const cred = await fb.signInAnonymously(auth);
    user = cred.user;
    state.myListings = [];
    saveMyListings();
    renderAccount();
    renderMyListings();
    renderHome();
    toast(tr('auth_logged_out'));
  } catch (err) {
    console.error(err);
    toast(authErrorMessage(err), true);
  }
}

function saveMyListings() {
  localStorage.setItem('rb_my_listings', JSON.stringify(state.myListings));
}

// ---------- আমার প্রোফাইল (নিজের রেজিস্টার করা তথ্য) ----------

function renderMyProfile() {
  const box = $('my-profile');
  if (!box) return;
  const listings = state.myListings.filter(m => m.type !== 'request');
  if (!listings.length) {
    box.innerHTML = `<p class="muted">${tr('no_profile')}</p><p class="muted small">${tr('no_profile_hint')}</p>`;
    return;
  }
  // প্রাথমিক প্রোফাইল: ডোনার আগে, তারপর ডাক্তার, তারপর হাসপাতাল
  const order = { donor: 0, doctor: 1, hospital: 2 };
  const primary = [...listings].sort((a, b) => order[a.type] - order[b.type])[0];
  const pool = primary.type === 'donor' ? state.donors
    : primary.type === 'hospital' ? state.hospitals : state.doctors;
  const doc = pool.find(d => d.id === primary.id);
  const name = doc ? doc.name : primary.name;
  const paused = doc && doc.paused;
  const photo = doc && doc.photoUrl
    ? `<div class="avatar"><img src="${esc(doc.photoUrl)}" alt=""></div>`
    : `<div class="avatar red">${esc(initials(name))}</div>`;
  const typeLabel = tr('profile_type_' + primary.type);
  let details = '';
  if (primary.type === 'donor' && doc) {
    details = `<h3>${esc(name)} <span class="group-chip big">${esc(doc.bloodGroup || '')}</span></h3>
      <p>${typeLabel}${doc.profession ? ' • ' + esc(doc.profession) : ''}</p>
      <p>📞 ${esc(doc.phone || '')}</p>
      <p>${esc(doc.address || '')}</p>
      <p>${tr('f_age')}: ${doc.age != null ? num(doc.age) : '—'} • ${tr('last_donation_label')}: ${doc.lastDonation ? esc(doc.lastDonation) : tr('never_donated')}</p>`;
  } else if (primary.type === 'doctor' && doc) {
    details = `<h3>${esc(name)}</h3>
      <p>${typeLabel}${doc.specialty ? ' • ' + esc(doc.specialty) : ''}</p>
      <p>${esc(doc.degree || '')}</p>
      <p>${esc(doc.workplace || '')}</p>
      <p>📞 ${esc(doc.phone || '')}</p>`;
  } else if (primary.type === 'hospital' && doc) {
    details = `<h3>${esc(name)}</h3>
      <p>${typeLabel}</p>
      <p>${esc(doc.address || '')}</p>
      <p>📞 ${esc(doc.phone || '')}</p>`;
  } else {
    details = `<h3>${esc(name)}</h3><p>${typeLabel}</p>`;
  }
  box.innerHTML = `<div class="profile-head">${photo}${details}
    ${paused ? `<p><span class="badge warn">${tr('paused_badge')}</span></p>` : ''}
    <div class="profile-actions">
      <button class="btn small" data-edit="${primary.type}:${primary.id}">${tr('edit_profile')}</button>
      ${primary.type === 'donor' ? `<button class="btn small secondary" data-pause="donor:${primary.id}">${paused ? tr('resume_btn') : tr('pause_btn')}</button>` : ''}
    </div></div>`;
}

function renderMyListings() {
  updateProfileVisibility();
  renderMyProfile();
  const box = $('my-listings');
  if (!state.myListings.length) {
    box.innerHTML = `<p class="muted">${tr('no_my_listings')}</p>`;
    return;
  }
  box.innerHTML = state.myListings.map(m => {
    if (m.type === 'request') {
      const r = state.requests.find(x => x.id === m.id);
      const open = r && r.status !== 'fulfilled';
      return `<div class="row"><span><b>${esc(r?.group || m.name || '')} — ${esc(r?.hospital || '')}</b> (${tr('profile_type_request')}) ${open ? '' : `<span class="badge ok">${tr('request_fulfilled')}</span>`}</span>
        <span>
          ${open ? `<button class="btn small" data-fulfill="${m.id}">${tr('mark_fulfilled')}</button>` : ''}
          <button class="btn small" data-del="request:${m.id}">${tr('delete_btn')}</button>
        </span></div>`;
    }
    const pool = m.type === 'donor' ? state.donors
      : m.type === 'hospital' ? state.hospitals : state.doctors;
    const doc = pool.find(d => d.id === m.id);
    const name = doc ? doc.name : m.name;
    const paused = doc && doc.paused;
    // এডিট/থামান শুধু "আমার প্রোফাইল" কার্ডে থাকে — এখানে শুধু মুছুন
    return `<div class="row"><span><b>${esc(name)}</b> (${m.type}) ${paused ? `<span class="badge warn">${tr('paused_badge')}</span>` : ''}</span>
      <span>
        <button class="btn small" data-del="${m.type}:${m.id}">${tr('delete_btn')}</button>
      </span></div>`;
  }).join('');

  document.querySelectorAll('[data-fulfill]').forEach(b => b.addEventListener('click', async () => {
    if (!needFirebase()) return;
    const id = b.getAttribute('data-fulfill');
    await fb.updateDoc(fb.doc(db, 'requests', id), { status: 'fulfilled' });
    const r = state.requests.find(x => x.id === id);
    if (r) r.status = 'fulfilled';
    renderMyListings();
    renderUrgentCard();
    toast(tr('request_fulfilled'));
  }));

  document.querySelectorAll('[data-pause]').forEach(b => b.addEventListener('click', async () => {
    if (!needFirebase()) return;
    const [type, id] = b.getAttribute('data-pause').split(':');
    const col = type + 's';
    const ref = fb.doc(db, col, id);
    const snap = await fb.getDoc(ref);
    const paused = !(snap.data() && snap.data().paused);
    await fb.updateDoc(ref, { paused });
    const doc = state.donors.find(d => d.id === id);
    if (doc) doc.paused = paused;
    renderStats(); renderGroupTiles(); renderMyListings();
    toast(tr('listing_updated'));
  }));
  document.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', async () => {
    if (!needFirebase()) return;
    if (!confirm(tr('delete_confirm'))) return;
    const [type, id] = b.getAttribute('data-del').split(':');
    await fb.deleteDoc(fb.doc(db, type + 's', id));
    state.myListings = state.myListings.filter(m => !(m.type === type && m.id === id));
    saveMyListings();
    if (type === 'donor') state.donors = state.donors.filter(d => d.id !== id);
    if (type === 'hospital') state.hospitals = state.hospitals.filter(d => d.id !== id);
    if (type === 'doctor') state.doctors = state.doctors.filter(d => d.id !== id);
    if (type === 'request') { state.requests = state.requests.filter(d => d.id !== id); renderUrgentCard(); }
    renderStats(); renderGroupTiles(); renderMyListings();
    toast(tr('listing_deleted'));
  }));
  document.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', () => {
    const [type, id] = b.getAttribute('data-edit').split(':');
    startEdit(type, id);
  }));
}

// ---------- রেজিস্ট্রেশন বাছাই (প্রোফাইল ট্যাব — v10) ----------
// তিন ধাপ: entry (রেজিস্ট্রেশন বাটন) → types (৩ কার্ড) → form (একটাই ফর্ম)
function regResetForms() {
  ['form-donor', 'form-hospital', 'form-doctor'].forEach(id => $(id)?.reset());
  ['d-photo-preview', 'h-photo-preview', 'dr-photo-preview'].forEach(id => $(id)?.classList.add('hidden'));
  clearEditing();
}
function showRegEntry() {
  // রেজিস্ট্রেশন বাতিল/শেষ — পুরো কার্ড বন্ধ করুন
  $('reg-types').classList.add('hidden');
  $('reg-form-wrap').classList.add('hidden');
  $('register-card').classList.add('hidden');
  regResetForms();
}
function showRegTypes() {
  // এডিটের সময় পেছনে গেলে কার্ড বন্ধ করুন (কার্ড বাছাই দেখানো নয়)
  if (state.editing) {
    showRegEntry();
    return;
  }
  $('register-card').classList.remove('hidden');
  $('reg-types').classList.remove('hidden');
  $('reg-form-wrap').classList.add('hidden');
  regResetForms();
  $('register-card').scrollIntoView({ behavior: 'smooth' });
}
function showRegForm(type, isEdit = false) {
  if (!isEdit) regResetForms();
  // কার্ড লুকানো থাকে — ফর্ম দেখাতে হলে খুলতে হবে
  $('register-card').classList.remove('hidden');
  $('reg-types').classList.add('hidden');
  $('reg-form-wrap').classList.remove('hidden');
  ['donor', 'hospital', 'doctor'].forEach(t => {
    $('reg-form-' + t).classList.toggle('hidden', t !== type);
  });
  $('register-card').scrollIntoView({ behavior: 'smooth' });
}

function startEdit(type, id) {
  const pool = type === 'donor' ? state.donors
    : type === 'hospital' ? state.hospitals : state.doctors;
  const doc = pool.find(d => d.id === id);
  if (!doc) return;
  state.editing = { type, id };
  if (type === 'donor') {
    $('d-name').value = doc.name || ''; $('d-phone').value = doc.phone || '';
    $('d-address').value = doc.address || ''; $('d-age').value = doc.age || '';
    $('d-gender').value = doc.gender || 'male'; $('d-group').value = doc.bloodGroup || '';
    $('d-profession').value = doc.profession || ''; $('d-last').value = doc.lastDonation || '';
    $('d-consent').checked = true;
    $('d-terms').checked = true;
    const dp = $('d-photo-preview');
    if (doc.photoUrl) { dp.src = doc.photoUrl; dp.classList.remove('hidden'); }
    else dp.classList.add('hidden');
    document.querySelector('#form-donor button[type="submit"]').textContent = tr('update_btn');
    showRegForm('donor', true);
  } else if (type === 'hospital') {
    $('h-name').value = doc.name || ''; $('h-phone').value = doc.phone || '';
    $('h-address').value = doc.address || ''; $('h-facilities').value = doc.facilities || '';
    $('h-doctors').value = doc.doctorsHere || '';
    $('h-consent').checked = true;
    $('h-terms').checked = true;
    const hp = $('h-photo-preview');
    if (doc.photoUrl) { hp.src = doc.photoUrl; hp.classList.remove('hidden'); }
    else hp.classList.add('hidden');
    $('h-photo').required = false; $('h-licence').required = false;
    document.querySelector('#form-hospital button[type="submit"]').textContent = tr('update_btn');
    showRegForm('hospital', true);
  } else {
    $('dr-name').value = doc.name || ''; $('dr-phone').value = doc.phone || '';
    $('dr-degree').value = doc.degree || ''; $('dr-specialty').value = doc.specialty || '';
    $('dr-workplace').value = doc.workplace || ''; $('dr-address').value = doc.address || '';
    $('dr-govt').value = doc.workplaceType || 'private'; $('dr-regno').value = doc.regNumber || '';
    $('dr-consent').checked = true;
    $('dr-terms').checked = true;
    const rp = $('dr-photo-preview');
    if (doc.photoUrl) { rp.src = doc.photoUrl; rp.classList.remove('hidden'); }
    else rp.classList.add('hidden');
    $('dr-photo').required = false;
    document.querySelector('#form-doctor button[type="submit"]').textContent = tr('update_btn');
    showRegForm('doctor', true);
  }
  toast(tr('edit_btn'));
}

function clearEditing() {
  state.editing = null;
  document.querySelector('#form-donor button[type="submit"]').textContent = tr('submit_btn');
  document.querySelector('#form-hospital button[type="submit"]').textContent = tr('submit_btn');
  document.querySelector('#form-doctor button[type="submit"]').textContent = tr('submit_btn');
  $('h-photo').required = true; $('h-licence').required = true; $('dr-photo').required = true;
}

// ট্যাব বদলান (নিচের ৫-ট্যাব নেভিগেশন)
function switchTab(name) {
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  const panel = $('tab-' + name);
  if (panel) panel.classList.add('active');
  $('view-search')?.classList.remove('active');
  $('view-search')?.classList.add('hidden');
  syncBottomNav(name);
  if (name === 'profile') { renderAccount(); renderMyProfile(); renderMyListings(); }
  if (name === 'hospitals') setTimeout(initMap, 60);
  if (name === 'donors' && state.group && state.pos && !$('donor-results').innerHTML) searchDonors();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// নিচের নেভিগেশনের active চিহ্ন (null = কোনোটাই active নয়)
function syncBottomNav(name) {
  document.querySelectorAll('#bottom-nav .nav-item').forEach(b => {
    b.classList.toggle('active', !!name && b.getAttribute('data-nav') === name);
  });
}

// সার্চ ফলাফলের ভিউ দেখান
function showSearchView() {
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  $('view-search')?.classList.remove('hidden');
  $('view-search')?.classList.add('active');
  syncBottomNav(null);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// হোম ট্যাবে ফিরে যান
function goHome() {
  switchTab('home');
  window.scrollTo(0, 0);
}


// ---------- রেজিস্ট্রেশন ----------

// ঠিকানা থেকে অবস্থান: GPS থাকলে সেটা, না হলে ঠিকানা জিওকোড
async function positionForAddress(address, district) {
  if (state.pos) return { lat: state.pos.lat, lng: state.pos.lng, approx: false };
  try {
    const g = await geocodePlace(`${address}, ${district || ''}, ${state.country}`);
    return { lat: g.lat, lng: g.lng, approx: false };
  } catch (e) {
    const c = districtCenter(district);
    if (c) return { lat: c[0], lng: c[1], approx: true };
    return { lat: null, lng: null, approx: true };
  }
}

async function photoDataUrl(inputEl) {
  const file = inputEl.files && inputEl.files[0];
  if (!file) return null;
  return fileToCompressedDataUrl(file);
}

function bindPhotoPreview(inputId, previewId) {
  $(inputId).addEventListener('change', async () => {
    try {
      const url = await photoDataUrl($(inputId));
      const img = $(previewId);
      if (url) { img.src = url; img.classList.remove('hidden'); }
    } catch (e) { /* ভুল ছবি হলে সাবমিটে ধরা পড়বে */ }
  });
}

async function submitDonor(e) {
  e.preventDefault();
  if (!needFirebase()) return;
  const name = $('d-name').value.trim();
  const phone = $('d-phone').value.trim();
  const address = $('d-address').value.trim();
  const age = Number($('d-age').value);
  const profession = $('d-profession').value.trim();
  const group = $('d-group').value;
  const isEdit = state.editing && state.editing.type === 'donor';

  if (!name || !phone || !address || !age || !profession || !group) return toast(tr('err_required'), true);
  if (!isValidBdPhone(phone) && state.country === 'Bangladesh' && !/^[0-9+ ]{7,15}$/.test(phone)) return toast(tr('err_phone'), true);
  if (age < 18 || age > 70) return toast(tr('err_age'), true);
  if (!isEdit && !$('d-consent').checked) return toast(tr('err_consent'), true);
  if (!isEdit && !$('d-terms').checked) return toast(tr('err_terms'), true);

  const btn = document.querySelector('#form-donor button[type="submit"]');
  btn.disabled = true; btn.textContent = tr('saving');
  try {
    const pos = await positionForAddress(address, '');
    const photoUrl = await photoDataUrl($('d-photo'));
    const data = {
      name, phone: normalizePhone(phone), address, age,
      gender: $('d-gender').value, bloodGroup: group, profession,
      lastDonation: $('d-last').value || null,
      lat: pos.lat, lng: pos.lng, approxCoords: pos.approx,
      district: '', country: state.country,
      voluntaryFreeConsent: true,
      ownerUid: user.uid, ownerToken: state.ownerToken,
      updatedAt: fb.serverTimestamp()
    };
    if (photoUrl) data.photoUrl = photoUrl;
    if (isEdit) {
      await fb.updateDoc(fb.doc(db, 'donors', state.editing.id), data);
      Object.assign(state.donors.find(d => d.id === state.editing.id) || {}, data);
      toast(tr('listing_updated'));
    } else {
      data.paused = false;
      data.createdAt = fb.serverTimestamp();
      const ref = await fb.addDoc(fb.collection(db, 'donors'), data);
      state.donors.push({ id: ref.id, source: 'registered', ...data });
      state.myListings.push({ type: 'donor', id: ref.id, name });
      saveMyListings();
      toast(tr('saved_msg'));
    }
    $('form-donor').reset();
    $('d-photo-preview').classList.add('hidden');
    clearEditing();
    renderStats(); renderGroupTiles(); renderMyListings();
    showRegEntry(); // সফল হলে রেজিস্ট্রেশন কার্ড বন্ধ করুন
    if (!isEdit) goHome();
  } catch (err) {
    console.error(err);
    toast(err.message === 'image_only' ? tr('err_photo') : tr('err_required'), true);
  } finally {
    btn.disabled = false; btn.textContent = tr('submit_btn');
  }
}

async function submitHospital(e) {
  e.preventDefault();
  if (!needFirebase()) return;
  const name = $('h-name').value.trim();
  const phone = $('h-phone').value.trim();
  const address = $('h-address').value.trim();
  const facilities = $('h-facilities').value.trim();
  const isEdit = state.editing && state.editing.type === 'hospital';

  if (!name || !phone || !address || !facilities) return toast(tr('err_required'), true);
  if (!isEdit && !$('h-consent').checked) return toast(tr('err_consent'), true);
  if (!isEdit && !$('h-terms').checked) return toast(tr('err_terms'), true);
  if (!isEdit && !$('h-photo').files.length) return toast(tr('err_photo'), true);
  if (!isEdit && !$('h-licence').files.length) return toast(tr('err_licence'), true);

  const btn = document.querySelector('#form-hospital button[type="submit"]');
  btn.disabled = true; btn.textContent = tr('saving');
  try {
    const pos = await positionForAddress(address, '');
    const photoUrl = await photoDataUrl($('h-photo'));
    const licenceUrl = await photoDataUrl($('h-licence'));
    const data = {
      name, phone: normalizePhone(phone), address, facilities,
      doctorsHere: $('h-doctors').value.trim(),
      lat: pos.lat, lng: pos.lng, approxCoords: pos.approx,
      district: '', country: state.country,
      licenceProvided: true, infoTrue: true,
      ownerUid: user.uid, ownerToken: state.ownerToken,
      updatedAt: fb.serverTimestamp()
    };
    if (photoUrl) data.photoUrl = photoUrl;
    let id;
    if (isEdit) {
      id = state.editing.id;
      await fb.updateDoc(fb.doc(db, 'hospitals', id), data);
      Object.assign(state.hospitals.find(h => h.id === id) || {}, data);
      toast(tr('listing_updated'));
    } else {
      data.createdAt = fb.serverTimestamp();
      const ref = await fb.addDoc(fb.collection(db, 'hospitals'), data);
      id = ref.id;
      state.hospitals.push({ id, source: 'registered', ...data });
      state.myListings.push({ type: 'hospital', id, name });
      saveMyListings();
      toast(tr('saved_msg'));
    }
    // লাইসেন্সের কাগজ আলাদা owner-only জায়গায় (পাবলিক ডকুমেন্টে নয়)
    if (licenceUrl) {
      await fb.setDoc(fb.doc(db, 'hospitals', id, 'private', 'licence'), {
        dataUrl: licenceUrl, updatedAt: fb.serverTimestamp()
      });
    }
    $('form-hospital').reset();
    $('h-photo-preview').classList.add('hidden');
    clearEditing();
    renderMyListings();
    showRegEntry(); // সফল হলে রেজিস্ট্রেশন কার্ড বন্ধ করুন
    if (!isEdit) goHome();
  } catch (err) {
    console.error(err);
    toast(tr('err_required'), true);
  } finally {
    btn.disabled = false; btn.textContent = tr('submit_btn');
  }
}

async function submitDoctor(e) {
  e.preventDefault();
  if (!needFirebase()) return;
  const name = $('dr-name').value.trim();
  const phone = $('dr-phone').value.trim();
  const degree = $('dr-degree').value.trim();
  const specialty = $('dr-specialty').value.trim();
  const workplace = $('dr-workplace').value.trim();
  const address = $('dr-address').value.trim();
  const isEdit = state.editing && state.editing.type === 'doctor';

  if (!name || !phone || !degree || !specialty || !workplace || !address) return toast(tr('err_required'), true);
  if (!isEdit && !$('dr-consent').checked) return toast(tr('err_consent'), true);
  if (!isEdit && !$('dr-terms').checked) return toast(tr('err_terms'), true);
  if (!isEdit && !$('dr-photo').files.length) return toast(tr('err_photo'), true);

  const btn = document.querySelector('#form-doctor button[type="submit"]');
  btn.disabled = true; btn.textContent = tr('saving');
  try {
    const pos = await positionForAddress(address, workplace);
    const photoUrl = await photoDataUrl($('dr-photo'));
    const data = {
      name, phone: normalizePhone(phone), degree, specialty, workplace, address,
      workplaceType: $('dr-govt').value,
      regNumber: $('dr-regno').value.trim() || null,
      lat: pos.lat, lng: pos.lng, approxCoords: pos.approx,
      district: '', country: state.country,
      infoTrue: true,
      ownerUid: user.uid, ownerToken: state.ownerToken,
      updatedAt: fb.serverTimestamp()
    };
    if (photoUrl) data.photoUrl = photoUrl;
    if (isEdit) {
      await fb.updateDoc(fb.doc(db, 'doctors', state.editing.id), data);
      Object.assign(state.doctors.find(d => d.id === state.editing.id) || {}, data);
      toast(tr('listing_updated'));
    } else {
      data.createdAt = fb.serverTimestamp();
      const ref = await fb.addDoc(fb.collection(db, 'doctors'), data);
      state.doctors.push({ id: ref.id, source: 'registered', ...data });
      state.myListings.push({ type: 'doctor', id: ref.id, name });
      saveMyListings();
      toast(tr('saved_msg'));
    }
    $('form-doctor').reset();
    $('dr-photo-preview').classList.add('hidden');
    clearEditing();
    renderSpecialties(); renderMyListings();
    showRegEntry(); // সফল হলে রেজিস্ট্রেশন কার্ড বন্ধ করুন
    if (!isEdit) goHome();
  } catch (err) {
    console.error(err);
    toast(tr('err_required'), true);
  } finally {
    btn.disabled = false; btn.textContent = tr('submit_btn');
  }
}

// ---------- পাবলিক তালিকা থেকে নিজের তথ্য সরানো ----------

async function removePublicListing() {
  const phone = normalizePhone($('rm-phone').value.trim());
  if (!phone) return toast(tr('err_phone'), true);
  const found = SEED_DONORS.find(d => normalizePhone(d.phone) === phone);
  if (!found) return toast(tr('remove_not_found'), true);
  try {
    if (db && user) {
      await fb.setDoc(fb.doc(db, 'takedowns', phone), { phone, createdAt: fb.serverTimestamp() });
      state.takedowns.add(phone);
    }
  } catch (e) { /* Firebase না থাকলে localStorage ফলব্যাক */ }
  const local = localTakedowns();
  if (!local.includes(phone)) {
    local.push(phone);
    localStorage.setItem('rb_takedowns', JSON.stringify(local));
  }
  $('rm-phone').value = '';
  renderStats(); renderGroupTiles();
  $('donor-results').innerHTML = '';
  toast(tr('removed_msg'));
}

// ---------- ভাষা / দেশ ----------

function applyLang() {
  document.documentElement.lang = state.lang;
  document.documentElement.dir = langDir(state.lang);
  document.querySelectorAll('[data-i18n]').forEach(el => {
    el.textContent = tr(el.getAttribute('data-i18n'));
  });
  document.querySelectorAll('[data-i18n-ph]').forEach(el => {
    el.placeholder = tr(el.getAttribute('data-i18n-ph'));
  });
  $('lang-select').value = state.lang;
  $('country-select').value = state.country;
  renderStats(); renderGroupTiles();
  renderCompatChart(); renderOrgs(); renderSpecialties();
  renderHome(); renderRequestGroupTiles();
  renderAccount();
  renderMyListings();
}

// ---------- হোম ট্যাব ----------
function renderHome() {
  const label = $('home-location-label');
  if (label) {
    label.textContent = state.pos
      ? (nearestDistrict(state.pos.lat, state.pos.lng) || tr('home_set_location'))
      : tr('home_set_location');
  }
  const dCount = $('shortcut-doctors-count');
  if (dCount) {
    let n;
    if (state.pos) {
      n = allDoctors().filter(d => {
        const p = entryPos(d);
        return p && haversineMeters(state.pos.lat, state.pos.lng, p.lat, p.lng) <= state.radiusKm * 1000;
      }).length;
    } else {
      n = allDoctors().length;
    }
    dCount.textContent = `${num(n)} ${tr('shortcut_doctors_near')}`;
  }
  const hSub = $('shortcut-hospitals-sub');
  if (hSub) {
    if (state.pos) {
      let best = null;
      allHospitals().forEach(h => {
        const p = entryPos(h);
        if (!p) return;
        const dist = haversineMeters(state.pos.lat, state.pos.lng, p.lat, p.lng);
        if (best == null || dist < best) best = dist;
      });
      hSub.textContent = best != null ? fmtDistance(best, state.lang) : '—';
    } else {
      hSub.textContent = `${num(allHospitals().length)} ${tr('results_hospitals')}`;
    }
  }
  renderUrgentCard();
}

// ---------- জরুরি রক্তের অনুরোধ ----------
function renderUrgentCard() {
  const box = $('urgent-card');
  if (!box) return;
  const open = openRequests();
  const dot = $('bell-dot');
  if (dot) dot.classList.toggle('hidden', !open.length);
  if (!open.length) {
    box.innerHTML = `<div class="card urgent-card cta">
      <div class="urgent-icon">${SVG_DROP}</div>
      <div class="urgent-body">
        <h3>${tr('urgent_cta_title')}</h3>
        <button class="btn" id="btn-urgent-new" type="button">${tr('urgent_cta_btn')}</button>
      </div>
    </div>`;
    $('btn-urgent-new')?.addEventListener('click', () => $('request-panel').classList.remove('hidden'));
    return;
  }
  const r = open[0];
  box.innerHTML = `<div class="card urgent-card">
    <div class="urgent-icon">${SVG_DROP}</div>
    <div class="urgent-body">
      <h3>${tr('urgent_prefix')} ${esc(r.group)} ${tr('urgent_suffix')}</h3>
      <p>${esc(r.hospital)}${r.area ? ' • ' + esc(r.area) : ''}${r.district ? ' • ' + esc(r.district) : ''}</p>
      <button class="btn" id="btn-urgent-respond" type="button">${tr('respond_btn')}</button>
    </div>
  </div>`;
  $('btn-urgent-respond')?.addEventListener('click', openRequestsPanel);
}

function requestCard(r) {
  return `<div class="listing request-card">
    <div class="listing-main">
      <div class="group-badge">${esc(r.group)}</div>
      <div class="listing-body">
        <h3>${esc(r.hospital)}</h3>
        <p>${[r.area, r.district].filter(Boolean).map(esc).join(', ')}</p>
        ${r.patientName ? `<p>${esc(r.patientName)}</p>` : ''}
        ${r.neededBy ? `<p>${tr('needed_by_label')}: ${esc(r.neededBy)}</p>` : ''}
        ${r.notes ? `<p>${esc(r.notes)}</p>` : ''}
        <p class="donor-line">${SVG_PHONE}<span>${esc(maskPhone(r.phone))}</span></p>
      </div>
    </div>
    <div class="listing-foot">
      <div class="req-phone-reveal">
        <button class="btn" type="button" data-respond="${esc(r.phone)}">${tr('respond_btn')}</button>
      </div>
      ${cardTools('request', r)}
    </div>
  </div>`;
}

function renderRequestsList() {
  const box = $('requests-list');
  if (!box) return;
  const open = openRequests();
  if (!open.length) {
    box.innerHTML = `<div class="card empty"><b>${tr('no_requests')}</b><p class="muted">${tr('no_requests_hint')}</p></div>`;
    return;
  }
  box.innerHTML = open.map(requestCard).join('');
  bindRespondButtons();
  bindReportButtons();
}

// "সাড়া দিন" চাপলে নাম্বার দেখাবে + কল বাটন
function bindRespondButtons() {
  document.querySelectorAll('[data-respond]').forEach(b => {
    b.addEventListener('click', () => {
      const phone = b.getAttribute('data-respond');
      const wrap = b.closest('.req-phone-reveal');
      if (!wrap) return;
      const tel = esc(String(phone).replace(/[^0-9+]/g, ''));
      wrap.innerHTML = `<a class="req-phone" href="tel:${tel}">${esc(phone)}</a>
        <a class="btn" href="tel:${tel}">${SVG_PHONE} ${tr('respond_call')}</a>`;
    });
  });
}

function openRequestsPanel() {
  renderRequestsList();
  $('requests-panel').classList.remove('hidden');
}

function renderRequestGroupTiles() {
  const box = $('rq-group-tiles');
  if (!box) return;
  box.innerHTML = BLOOD_GROUPS.map(g =>
    `<button type="button" class="tile${state.reqGroup === g ? ' active' : ''}" data-group="${g}"><b>${g}</b></button>`).join('');
  box.querySelectorAll('.tile').forEach(b => b.addEventListener('click', () => {
    state.reqGroup = b.getAttribute('data-group');
    renderRequestGroupTiles();
  }));
}

async function submitRequest(e) {
  e.preventDefault();
  if (!needFirebase()) return;
  const hospital = $('rq-hospital').value.trim();
  const district = $('rq-district').value.trim();
  const phone = $('rq-phone').value.trim();
  const group = state.reqGroup;
  if (!group || !hospital || !district || !phone) return toast(tr('err_required'), true);
  if (!isValidBdPhone(phone) && state.country === 'Bangladesh' && !/^[0-9+ ]{7,15}$/.test(phone)) return toast(tr('err_phone'), true);
  if (!$('rq-consent').checked) return toast(tr('err_consent'), true);
  if (!$('rq-terms').checked) return toast(tr('err_terms'), true);
  const btn = document.querySelector('#form-request button[type="submit"]');
  btn.disabled = true; btn.textContent = tr('saving');
  try {
    const area = $('rq-area').value.trim();
    const pos = await positionForAddress(area || hospital, district);
    const data = {
      group, hospital, district, area: area || null,
      phone: normalizePhone(phone),
      patientName: $('rq-patient').value.trim() || null,
      neededBy: $('rq-needed').value || null,
      notes: $('rq-notes').value.trim() || null,
      status: 'open',
      lat: pos.lat, lng: pos.lng, approxCoords: pos.approx,
      country: state.country,
      ownerUid: user.uid, ownerToken: state.ownerToken,
      createdAt: fb.serverTimestamp()
    };
    const ref = await fb.addDoc(fb.collection(db, 'requests'), data);
    state.requests.push({ id: ref.id, ...data });
    state.myListings.push({ type: 'request', id: ref.id, name: `${group} — ${hospital}` });
    saveMyListings();
    $('form-request').reset();
    state.reqGroup = null;
    renderRequestGroupTiles();
    $('request-panel').classList.add('hidden');
    renderUrgentCard();
    renderMyListings();
    toast(tr('request_saved'));
    goHome();
  } catch (err) {
    console.error(err);
    toast(tr('err_required'), true);
  } finally {
    btn.disabled = false; btn.textContent = tr('request_submit');
  }
}

// ---------- মানচিত্র (Leaflet — অফলাইনে লুকিয়ে যাবে, তালিকা চলবে) ----------
let map = null, mapMarkers = [];
function initMap() {
  const wrap = $('map-wrap');
  if (!wrap) return;
  if (typeof L === 'undefined') { wrap.classList.add('hidden'); return; }
  wrap.classList.remove('hidden');
  if (map) { map.invalidateSize(); return; }
  const center = state.pos ? [state.pos.lat, state.pos.lng] : [23.8103, 90.4125];
  map = L.map('map').setView(center, 12);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap'
  }).addTo(map);
  updateMapMarkers(allHospitals().map(h => ({ lat: h.lat, lng: h.lng, name: h.name })));
}

function updateMapMarkers(items) {
  if (!map || typeof L === 'undefined') return;
  mapMarkers.forEach(m => m.remove());
  mapMarkers = [];
  const points = [];
  if (state.pos) {
    const me = L.circleMarker([state.pos.lat, state.pos.lng], {
      radius: 8, color: '#2563EB', fillColor: '#2563EB', fillOpacity: 0.9, weight: 2
    }).addTo(map);
    mapMarkers.push(me);
    points.push([state.pos.lat, state.pos.lng]);
  }
  items.forEach(it => {
    if (it.lat == null || it.lng == null) return;
    const m = L.circleMarker([it.lat, it.lng], {
      radius: 7, color: '#E11D48', fillColor: '#E11D48', fillOpacity: 0.9, weight: 2
    }).addTo(map);
    if (it.name) m.bindPopup(esc(it.name));
    mapMarkers.push(m);
    points.push([it.lat, it.lng]);
  });
  if (points.length) map.fitBounds(points, { padding: [24, 24] });
}

// ---------- ইভেন্ট ----------

function bindEvents() {
  // নিচের নেভিগেশন: ৫ ট্যাব (হোম / রক্ত / ডাক্তার / হাসপাতাল / প্রোফাইল)
  document.querySelectorAll('#bottom-nav .nav-item').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.getAttribute('data-nav')));
  });

  // ভাষা / দেশ
  $('lang-select').innerHTML = LANGUAGES.map(l =>
    `<option value="${l.code}">${l.name}</option>`).join('');
  $('country-select').innerHTML = COUNTRIES.map(c =>
    `<option value="${esc(c)}">${esc(c)}</option>`).join('');
  $('lang-select').addEventListener('change', () => {
    state.lang = $('lang-select').value;
    localStorage.setItem('rb_lang', state.lang);
    applyLang();
  });
  $('country-select').addEventListener('change', () => {
    state.country = $('country-select').value;
    localStorage.setItem('rb_country', state.country);
    state.pos = null;
  });

  // দূরত্ব পিল
  document.querySelectorAll('#radius-pills button').forEach(b => {
    b.addEventListener('click', () => {
      document.querySelectorAll('#radius-pills button').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      state.radiusKm = Number(b.getAttribute('data-radius'));
    });
  });

  // GPS বাটন (তিন ট্যাবে একই কাজ)
  async function useGeo(statusId) {
    try {
      if (statusId) $(statusId).textContent = tr('locating');
      const pos = await getPosition();
      state.pos = { lat: pos.coords.latitude, lng: pos.coords.longitude, label: 'GPS' };
      if (statusId) $(statusId).textContent = '';
      renderHome();
      toast('📍');
    } catch (e) {
      toast(tr('location_denied'), true);
    }
  }
  $('btn-geo').addEventListener('click', () => useGeo('search-status'));
  $('btn-geo-h').addEventListener('click', () => useGeo('search-status-h'));
  $('btn-geo-d').addEventListener('click', () => useGeo('search-status-d'));

  // রেজিস্টার ফর্মে লাইভ লোকেশন (positionForAddress state.pos-কে প্রাধান্য দেয়)
  async function useGeoForForm(statusId) {
    try {
      const pos = await getPosition();
      state.pos = { lat: pos.coords.latitude, lng: pos.coords.longitude, label: 'GPS' };
      $(statusId).textContent = tr('live_location_set');
      toast('📍');
    } catch (e) {
      toast(tr('location_denied'), true);
    }
  }
  $('btn-geo-donor').addEventListener('click', () => useGeoForForm('geo-status-donor'));
  $('btn-geo-hosp').addEventListener('click', () => useGeoForForm('geo-status-hosp'));
  $('btn-geo-dr').addEventListener('click', () => useGeoForForm('geo-status-dr'));

  // জেলা লিখলে GPS ভুলে যান (জেলাই অবস্থান)
  ['input-district', 'input-district-h', 'input-district-d'].forEach(id => {
    $(id).addEventListener('input', () => { state.pos = null; });
  });

  $('btn-search-donors').addEventListener('click', searchDonors);
  $('btn-search-hospitals').addEventListener('click', searchHospitals);
  $('btn-search-doctors').addEventListener('click', searchDoctors);
  $('btn-search-universal').addEventListener('click', searchUniversal);
  $('input-universal').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); searchUniversal(); }
  });
  document.querySelectorAll('#uni-chips button').forEach(chip => {
    chip.addEventListener('click', () => {
      $('input-universal').value = chip.getAttribute('data-q');
      searchUniversal();
    });
  });

  // হোম: গ্রুপ দিয়ে ডোনার খুঁজুন
  $('btn-find-donors').addEventListener('click', () => {
    if (!state.group) return toast(tr('choose_group_first'), true);
    switchTab('donors');
    searchDonors();
  });
  $('shortcut-doctors').addEventListener('click', () => {
    switchTab('doctors');
    if (state.pos) searchDoctors();
  });
  $('shortcut-hospitals').addEventListener('click', () => {
    switchTab('hospitals');
    if (state.pos) searchHospitals();
  });
  $('btn-bell').addEventListener('click', openRequestsPanel);
  $('btn-home-geo').addEventListener('click', () => useGeo());

  // রক্ত ট্যাবের ফিল্টার পিল
  document.querySelectorAll('#donor-filter-pills button').forEach(b => {
    b.addEventListener('click', () => {
      document.querySelectorAll('#donor-filter-pills button').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      state.donorFilter = b.getAttribute('data-filter');
      if (state.group && state.pos) searchDonors();
    });
  });

  // কমপ্যাটিবিলিটি চার্টের লিংক (প্রোফাইল ট্যাবে)
  $('compat-link-btn').addEventListener('click', () => {
    switchTab('profile');
    setTimeout(() => $('compat-card')?.scrollIntoView({ behavior: 'smooth' }), 100);
  });

  // সার্চ ফলাফল থেকে ফিরে যান
  $('search-back-btn').addEventListener('click', goHome);

  // জরুরি অনুরোধের ফর্ম + তালিকা
  $('form-request').addEventListener('submit', submitRequest);
  $('btn-close-request').addEventListener('click', () => $('request-panel').classList.add('hidden'));
  $('btn-close-requests').addEventListener('click', () => $('requests-panel').classList.add('hidden'));
  $('btn-new-request-2').addEventListener('click', () => {
    $('requests-panel').classList.add('hidden');
    $('request-panel').classList.remove('hidden');
  });
  ['request-panel', 'requests-panel', 'appointment-panel', 'auth-panel'].forEach(id => {
    $(id).addEventListener('click', e => {
      if (e.target === $(id)) $(id).classList.add('hidden');
    });
  });

  // রেজিস্ট্রেশন বাছাই: রেজিস্ট্রেশন → ৩ কার্ড → একটাই ফর্ম
  $('btn-reg-types-back').addEventListener('click', showRegEntry);
  $('btn-reg-form-back').addEventListener('click', showRegTypes);
  document.querySelectorAll('.reg-type-card').forEach(card => {
    card.addEventListener('click', () => showRegForm(card.getAttribute('data-regtype')));
  });

  // ফোন + পাসওয়ার্ড লগইন / অ্যাকাউন্ট
  $('form-auth').addEventListener('submit', submitAuth);
  $('btn-close-auth').addEventListener('click', () => $('auth-panel').classList.add('hidden'));

  // ফর্ম
  $('d-group').innerHTML = `<option value="">${tr('choose_group')}</option>` +
    BLOOD_GROUPS.map(g => `<option value="${g}">${g}</option>`).join('');
  $('form-donor').addEventListener('submit', submitDonor);
  $('form-hospital').addEventListener('submit', submitHospital);
  $('form-doctor').addEventListener('submit', submitDoctor);
  $('btn-remove-public').addEventListener('click', removePublicListing);
  bindPhotoPreview('d-photo', 'd-photo-preview');
  bindPhotoPreview('h-photo', 'h-photo-preview');
  bindPhotoPreview('dr-photo', 'dr-photo-preview');

  // রিভিউ
  document.querySelectorAll('#review-stars button').forEach(b => {
    b.addEventListener('click', () => {
      state.reviewStars = Number(b.getAttribute('data-star'));
      renderStars();
    });
  });
  $('form-review').addEventListener('submit', submitReview);
  $('btn-close-review').addEventListener('click', () => $('review-panel').classList.add('hidden'));
  $('btn-close-appt').addEventListener('click', () => $('appointment-panel').classList.add('hidden'));

  // টেক্সট সাইজ (প্রোফাইল > সেটিংস)
  syncTextSizeRow();
  document.querySelectorAll('#textsize-row button').forEach(b => {
    b.addEventListener('click', () => {
      textSize = b.getAttribute('data-textsize');
      localStorage.setItem('rb_textsize', textSize);
      applyTextSize();
      syncTextSizeRow();
    });
  });
  $('review-panel').addEventListener('click', e => {
    if (e.target === $('review-panel')) $('review-panel').classList.add('hidden');
  });

  // ক্লিক সাউন্ড: বাটন/ট্যাব/টাইল চাপলে হালকা শব্দ
  document.addEventListener('click', e => {
    if (e.target.closest('button, a.btn, input[type="checkbox"]')) playClick();
  });
  const soundBtn = $('btn-sound');
  const renderSoundBtn = () => {
    soundBtn.classList.toggle('on', state.soundOn);
    soundBtn.setAttribute('aria-checked', state.soundOn ? 'true' : 'false');
  };
  renderSoundBtn();
  soundBtn.addEventListener('click', () => {
    state.soundOn = !state.soundOn;
    localStorage.setItem('rb_sound', state.soundOn ? 'on' : 'off');
    renderSoundBtn();
  });

  // কপি-প্রতিরোধ: মূল কনটেন্টে রাইট-ক্লিক বন্ধ (ফর্মের ইনপুটে চলে)
  document.addEventListener('contextmenu', e => {
    if (!e.target.closest('input, select, textarea')) e.preventDefault();
  });
  document.addEventListener('selectstart', e => {
    if (!e.target.closest('input, select, textarea')) e.preventDefault();
  });
}

// ---------- শুরু ----------

async function init() {
  applyTextSize(); // সংরক্ষিত টেক্সট সাইজ প্রথমেই লাগান
  bindEvents();
  applyLang();
  renderDistrictList();
  if (!isFirebaseConfigured) {
    $('config-warning').classList.remove('hidden');
    return; // সিড-ডেটা দিয়েই খোঁজা চলবে
  }
  try {
    await initFirebase();
    await loadFirestoreData();
    renderStats(); renderGroupTiles(); renderSpecialties(); renderAccount(); renderMyListings();
    renderRequestGroupTiles(); renderHome();
  } catch (e) {
    console.error(e);
    toast(tr('config_warning'), true);
  }
}
init();
