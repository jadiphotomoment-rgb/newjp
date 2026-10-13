'use strict';

require('dotenv').config();
const bcrypt = require('bcryptjs');
const db = require('../database');
const approvalSvc = require('../services/approval');

async function getClient() {
  const c = await db.getClient();
  return c;
}

async function withTx(fn) {
  const c = await getClient();
  try {
    await c.query('BEGIN');
    const result = await fn(c);
    await c.query('COMMIT');
    return result;
  } catch (e) {
    try { await c.query('ROLLBACK'); } catch (_) {}
    throw e;
  } finally {
    c.release();
  }
}

async function run() {
  console.log('--- [TEST FASE 4] Memulai Uji Approval Engine ---');

  const hash = bcrypt.hashSync('PasswordTest1234!', 10);
  const ts = Date.now();

  // Setup users
  const { rows: [owner] } = await db.query(
    `INSERT INTO users (nama, email, password_hash, role, is_active, must_change_password)
     VALUES ('Owner F4', $1, $2, 'owner', true, false) RETURNING id, role`,
    [`owner_f4_${ts}@test.com`, hash]
  );
  const { rows: [staff] } = await db.query(
    `INSERT INTO users (nama, email, password_hash, role, is_active, must_change_password)
     VALUES ('Staff F4', $1, $2, 'staff', true, false) RETURNING id, role`,
    [`staff_f4_${ts}@test.com`, hash]
  );

  // Setup booking test category & booking
  const { rows: [cat] } = await db.query(
    `INSERT INTO booking_categories (name, slug, is_active, dp_type, dp_value)
     VALUES ('Test Cat F4', $1, true, 'flat', 0) RETURNING id`,
    [`test-cat-f4-${ts}`]
  );
  const { rows: [booking] } = await db.query(
    `INSERT INTO bookings (client_name, client_phone, event_date, category_id, package_price, dp_amount, status, created_by, version)
     VALUES ('Test Client F4', '08120000001', CURRENT_DATE, $1, 500000, 100000, 'pending', $2, 1) RETURNING id, version`,
    [cat.id, owner.id]
  );
  const bookingId = booking.id;
  const bookingVersion = booking.version;

  const fakeReq = { user: staff, requestId: `req-f4-${ts}`, ip: '127.0.0.1' };
  const ownerReq = { user: owner, requestId: `req-f4-o-${ts}`, ip: '127.0.0.1' };

  let currentVersion = bookingVersion;
  let testApproval;

  const cleanup = async () => {
    await db.query('DELETE FROM approval_requests WHERE entitas_id = $1', [bookingId]);
    await db.query('DELETE FROM bookings WHERE id = $1', [bookingId]);
    await db.query('DELETE FROM booking_categories WHERE id = $1', [cat.id]);
    await db.query('DELETE FROM refresh_tokens WHERE user_id IN ($1, $2)', [owner.id, staff.id]);
    await db.query('DELETE FROM users WHERE id IN ($1, $2)', [owner.id, staff.id]);
  };

  try {
    // 1. Ajukan approval
    console.log('1. Uji Ajukan Approval Request (Staff)...');
    testApproval = await withTx(async (tx) => {
      return approvalSvc.ajukan(tx, {
        tipe: 'booking.discount', entitas: 'booking', entitas_id: bookingId,
        payload: { discount: 50000 }, base_version: currentVersion,
        alasan: 'Diskon loyalitas', requested_by: staff.id, req: fakeReq
      });
    });
    if (testApproval.status !== 'pending') throw new Error('Status harus pending!');
    console.log(`   ✅ Diajukan: ID ${testApproval.id}, status=${testApproval.status}`);

    // 2. Duplikat pending ditolak
    console.log('2. Uji Penolakan Duplikat Pending...');
    let dupErr;
    try {
      await withTx(async (tx) => approvalSvc.ajukan(tx, {
        tipe: 'booking.discount', entitas: 'booking', entitas_id: bookingId,
        payload: { discount: 1 }, base_version: currentVersion,
        alasan: 'Coba duplikat', requested_by: staff.id, req: fakeReq
      }));
    } catch (e) { dupErr = e; }
    if (!dupErr || dupErr.code !== 'DUPLICATE_PENDING') throw new Error('Harus tolak duplikat!');
    console.log('   ✅ Duplikat pending ditolak (409).');

    // 3. Self-approval dilarang
    console.log('3. Uji Pencegahan Self-Approval...');
    let selfErr;
    try {
      await withTx(async (tx) => approvalSvc.setujui(tx, {
        approval_id: testApproval.id, decided_by: staff.id,
        decision_note: 'Coba sendiri', req: ownerReq, applyFn: null
      }));
    } catch (e) { selfErr = e; }
    if (!selfErr || selfErr.code !== 'SELF_APPROVAL') throw new Error('Self-approval harus dilarang!');
    console.log('   ✅ Self-approval berhasil diblokir.');

    // 4. Setujui oleh Owner
    console.log('4. Uji Setujui (Owner) + Optimistic Lock...');
    const approved = await withTx(async (tx) => approvalSvc.setujui(tx, {
      approval_id: testApproval.id, decided_by: owner.id,
      decision_note: 'OK', req: ownerReq,
      applyFn: async (tx2, payload, eid) => {
        const { rows: [b] } = await tx2.query('SELECT version FROM bookings WHERE id=$1', [eid]);
        await tx2.query('UPDATE bookings SET version=version+1 WHERE id=$1', [eid]);
        const { rows: [a] } = await tx2.query('SELECT version FROM bookings WHERE id=$1', [eid]);
        currentVersion = a.version;
        return { before: b, after: a };
      }
    }));
    if (approved.status !== 'approved') throw new Error('Status harus approved!');
    console.log(`   ✅ Setujui sukses (status=${approved.status}).`);

    // 5. Tolak approval baru
    console.log('5. Uji Tolak Approval...');
    const ap2 = await withTx(async (tx) => approvalSvc.ajukan(tx, {
      tipe: 'booking.discount', entitas: 'booking', entitas_id: bookingId,
      payload: { discount: 20000 }, base_version: currentVersion,
      alasan: 'Test tolak', requested_by: staff.id, req: fakeReq
    }));
    const rejected = await withTx(async (tx) => approvalSvc.tolak(tx, {
      approval_id: ap2.id, decided_by: owner.id, decision_note: 'Tidak sesuai', req: ownerReq
    }));
    if (rejected.status !== 'rejected') throw new Error('Status harus rejected!');
    console.log('   ✅ Tolak sukses.');

    // 6. Expire
    console.log('6. Uji expireAll()...');
    const ap3 = await withTx(async (tx) => approvalSvc.ajukan(tx, {
      tipe: 'booking.discount', entitas: 'booking', entitas_id: bookingId,
      payload: { discount: 10000 }, base_version: currentVersion,
      alasan: 'Test expire', requested_by: staff.id, req: fakeReq
    }));
    await db.query("UPDATE approval_requests SET expires_at = now() - interval '1 second' WHERE id=$1", [ap3.id]);
    const expCount = await approvalSvc.expireAll();
    if (expCount < 1) throw new Error('expireAll harus expire >=1!');
    const { rows: [expCheck] } = await db.query('SELECT status FROM approval_requests WHERE id=$1', [ap3.id]);
    if (expCheck.status !== 'expired') throw new Error('Status harus expired!');
    console.log(`   ✅ expireAll ok (${expCount} expired).`);

    // 7. Stale detection
    console.log('7. Uji Stale Detection...');
    const ap4 = await withTx(async (tx) => approvalSvc.ajukan(tx, {
      tipe: 'booking.discount', entitas: 'booking', entitas_id: bookingId,
      payload: { discount: 5000 }, base_version: currentVersion,
      alasan: 'Test stale', requested_by: staff.id, req: fakeReq
    }));
    // Ubah version booking seolah ada perubahan lain
    await db.query('UPDATE bookings SET version=version+1 WHERE id=$1', [bookingId]);
    let staleErr;
    try {
      await withTx(async (tx) => approvalSvc.setujui(tx, {
        approval_id: ap4.id, decided_by: owner.id, decision_note: 'Coba stale', req: ownerReq, applyFn: null
      }));
    } catch (e) {
      staleErr = e;
      if (e.staleApprovalId) await approvalSvc.markStale(e.staleApprovalId);
    }
    if (!staleErr || staleErr.code !== 'STALE') throw new Error('Harus STALE!');
    const { rows: [sc] } = await db.query('SELECT status FROM approval_requests WHERE id=$1', [ap4.id]);
    if (sc.status !== 'stale') throw new Error('Status DB harus stale!');
    console.log('   ✅ Stale detection aktif.');

    // 8. Race condition: dua setujui bersamaan → hanya 1 sukses
    console.log('8. Uji Race Condition (2 setujui bersamaan)...');
    const { rows: [bkNow] } = await db.query('SELECT version FROM bookings WHERE id=$1', [bookingId]);
    currentVersion = bkNow.version;

    const ap5 = await withTx(async (tx) => approvalSvc.ajukan(tx, {
      tipe: 'booking.discount', entitas: 'booking', entitas_id: bookingId,
      payload: { discount: 1000 }, base_version: currentVersion,
      alasan: 'Test race', requested_by: staff.id, req: fakeReq
    }));

    const doApprove = async (note) => {
      const c = await getClient();
      try {
        await c.query('BEGIN');
        const r = await approvalSvc.setujui(c, {
          approval_id: ap5.id, decided_by: owner.id, decision_note: note, req: ownerReq,
          applyFn: async (tx2, _, eid) => {
            await tx2.query('UPDATE bookings SET version=version+1 WHERE id=$1', [eid]);
            return {};
          }
        });
        await c.query('COMMIT');
        return r;
      } catch (e) {
        try { await c.query('ROLLBACK'); } catch (_) {}
        throw e;
      } finally { c.release(); }
    };

    const results = await Promise.allSettled([doApprove('Race A'), doApprove('Race B')]);
    const successes = results.filter(r => r.status === 'fulfilled');
    const failures  = results.filter(r => r.status === 'rejected');
    if (successes.length !== 1 || failures.length !== 1) {
      throw new Error(`Race: diharapkan 1 sukses 1 gagal, dapat ${successes.length} sukses ${failures.length} gagal`);
    }
    console.log('   ✅ Race condition: tepat 1 sukses, 1 gagal.');

    console.log('--- [TEST FASE 4] SEMUA UJI LULUS (100% SUKSES) ---');
  } finally {
    await cleanup();
  }

  process.exit(0);
}

run().catch(err => {
  console.error('❌ Uji Fase 4 Gagal:', err);
  process.exit(1);
});
