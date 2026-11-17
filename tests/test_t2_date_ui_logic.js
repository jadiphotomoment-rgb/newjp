'use strict';

const assert = require('assert');

// Test the pure functions from T2 UI logic
function getTodayWIB(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' }).format(d);
}

function addDaysWIB(ymdStr, days) {
  const [y, m, d] = ymdStr.split('-').map(Number);
  const utc = Date.UTC(y, m - 1, d) + (days * 86400000);
  const dObj = new Date(utc);
  const ny = dObj.getUTCFullYear();
  const nm = String(dObj.getUTCMonth() + 1).padStart(2, '0');
  const nd = String(dObj.getUTCDate()).padStart(2, '0');
  return `${ny}-${nm}-${nd}`;
}

function formatIndoDate(ymdStr) {
  if (!ymdStr) return '';
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
  const [y, m, d] = ymdStr.split('-').map(Number);
  return `${d} ${months[m - 1]} ${y}`;
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function calculatePresets(todayStr) {
  const today = todayStr;
  const tomorrow = addDaysWIB(today, 1);

  const [y, m, d] = today.split('-').map(Number);
  const dayOfWeek = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  const diffToMonday = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
  const monday = addDaysWIB(today, diffToMonday);
  const sunday = addDaysWIB(monday, 6);

  const firstDay = `${y}-${String(m).padStart(2, '0')}-01`;
  const lastDayDate = new Date(Date.UTC(y, m, 0));
  const lastDay = `${y}-${String(m).padStart(2, '0')}-${String(lastDayDate.getUTCDate()).padStart(2, '0')}`;

  const next7 = { from: today, to: addDaysWIB(today, 6) };
  const next30 = { from: today, to: addDaysWIB(today, 29) };

  return {
    today,
    tomorrow,
    this_week: { from: monday, to: sunday },
    this_month: { from: firstDay, to: lastDay },
    next_7: next7,
    next_30: next30
  };
}

console.log('Testing T2 UI Logic...');

// 1. Timezone tests (WIB is UTC+7)
{
  // 2026-11-17 18:00:00 UTC is 2026-11-18 01:00:00 WIB
  const lateUtc = new Date(Date.UTC(2026, 10, 17, 18, 0, 0));
  assert.strictEqual(getTodayWIB(lateUtc), '2026-11-18', '18:00 UTC should be next day in WIB');

  // 2026-11-17 16:59:00 UTC is 2026-11-17 23:59:00 WIB
  const beforeMidnightUtc = new Date(Date.UTC(2026, 10, 17, 16, 59, 0));
  assert.strictEqual(getTodayWIB(beforeMidnightUtc), '2026-11-17', '16:59 UTC should be same day in WIB');
  console.log('  ✓ WIB timezone calculations immune to UTC offset');
}

// 2. Presets calculation & boundary tests
{
  // Test mid-month Tuesday (2026-11-17)
  const p1 = calculatePresets('2026-11-17');
  assert.strictEqual(p1.today, '2026-11-17');
  assert.strictEqual(p1.tomorrow, '2026-11-18');
  assert.strictEqual(p1.this_week.from, '2026-11-16', 'Monday');
  assert.strictEqual(p1.this_week.to, '2026-11-22', 'Sunday');
  assert.strictEqual(p1.this_month.from, '2026-11-01');
  assert.strictEqual(p1.this_month.to, '2026-11-30');
  assert.strictEqual(p1.next_7.from, '2026-11-17');
  assert.strictEqual(p1.next_7.to, '2026-11-23');
  assert.strictEqual(p1.next_30.from, '2026-11-17');
  assert.strictEqual(p1.next_30.to, '2026-12-16');
  console.log('  ✓ Presets for standard dates correct');

  // Test month boundary (Jan 31 -> Feb 01)
  const pJan31 = calculatePresets('2026-01-31');
  assert.strictEqual(pJan31.tomorrow, '2026-02-01');
  console.log('  ✓ Month boundary crossing handled cleanly');

  // Test year boundary (Dec 31 -> Jan 01)
  const pDec31 = calculatePresets('2026-12-31');
  assert.strictEqual(pDec31.tomorrow, '2027-01-01');
  console.log('  ✓ Year boundary crossing handled cleanly');
}

// 3. Formatting Indonesian date
{
  assert.strictEqual(formatIndoDate('2026-11-20'), '20 Nov 2026');
  assert.strictEqual(formatIndoDate('2026-01-01'), '1 Jan 2026');
  assert.strictEqual(formatIndoDate('2026-08-17'), '17 Agu 2026');
  console.log('  ✓ Indonesian date formatting verified');
}

// 4. HTML Escaping
{
  const unsafe = '<script>alert("xss")</script>&\'';
  const safe = escapeHtml(unsafe);
  assert(!safe.includes('<'), 'No unescaped <');
  assert(!safe.includes('>'), 'No unescaped >');
  assert(safe.includes('&lt;script&gt;'), 'Properly entity escaped');
  console.log('  ✓ HTML escaping verified');
}

// 5. URL query params persistence simulation
{
  const qs = new URLSearchParams();
  qs.set('date', '2026-11-20');
  qs.set('status', 'confirmed');
  assert.strictEqual(qs.toString(), 'date=2026-11-20&status=confirmed');

  const parsed = new URLSearchParams('date=2026-11-20&status=confirmed');
  assert.strictEqual(parsed.get('date'), '2026-11-20');
  assert.strictEqual(parsed.get('status'), 'confirmed');
  console.log('  ✓ URL params serialization & parsing verified');
}

console.log('All T2 UI Logic tests passed successfully! ✅');
