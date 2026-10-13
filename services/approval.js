'use strict';

/**
 * services/approval.js – Approval Engine
 *
 * Operasi:
 *  - ajukan(tx, { tipe, entitas, entitas_id, payload, base_version, alasan, requested_by, req })
 *  - setujui(tx, { approval_id, decided_by, decision_note, req, applyFn })
 *  - tolak(tx, { approval_id, decided_by, decision_note, req })
 *  - batalkan(tx, { approval_id, cancelled_by, req })
 *  - expireAll()  – dipanggil oleh cron periodik
 *  - getAturan(tipe) – resolver aturan dengan cache singkat
 */

const db    = require('../database');
const audit = require('./audit');

// ── Cache singkat approval_rules (15 detik) ──────────────────────
const rulesCache = { data: null, expiresAt: 0 };
const RULES_TTL = 15_000;

async function getAllRules() {
  const now = Date.now();
  if (rulesCache.data && rulesCache.expiresAt > now) return rulesCache.data;
  const { rows } = await db.query('SELECT tipe, requires_owner, expires_days FROM approval_rules');
  rulesCache.data = Object.fromEntries(rows.map(r => [r.tipe, r]));
  rulesCache.expiresAt = now + RULES_TTL;
  return rulesCache.data;
}

async function getAturan(tipe) {
  const rules = await getAllRules();
  return rules[tipe] || null;
}

function invalidateRulesCache() {
  rulesCache.data = null;
  rulesCache.expiresAt = 0;
}

/**
 * Ajukan approval request baru (harus dipanggil dalam transaksi tx).
 * Cegah duplikat via unique index ux_approval_pending.
 */
async function ajukan(tx, {
  tipe, entitas, entitas_id, payload, base_version,
  alasan, requested_by, req
}) {
  const rule = await getAturan(tipe);
  if (!rule) {
    throw Object.assign(new Error(`Tipe approval tidak dikenal: '${tipe}'`), { code: 'UNKNOWN_TYPE', status: 400 });
  }

  const expiresAt = new Date(Date.now() + rule.expires_days * 24 * 60 * 60 * 1000);

  let newApproval;
  try {
    const { rows } = await tx.query(`
      INSERT INTO approval_requests
        (tipe, entitas, entitas_id, payload, base_version, alasan, requested_by, expires_at)
      VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8)
      RETURNING *
    `, [
      tipe, entitas, entitas_id,
      JSON.stringify(payload), base_version,
      alasan || null, requested_by, expiresAt
    ]);
    newApproval = rows[0];
  } catch (err) {
    if (err.code === '23505') {
      throw Object.assign(
        new Error('Sudah ada permintaan persetujuan pending untuk entitas dan jenis aksi ini. Tunggu keputusan Owner.'),
        { code: 'DUPLICATE_PENDING', status: 409 }
      );
    }
    throw err;
  }

  await audit.record(tx, {
    actor: { id: requested_by, role: req?.user?.role || 'staff' },
    aksi: `approval.ajukan.${tipe}`,
    entitas,
    entitas_id,
    sebelum: null,
    sesudah: { approval_id: newApproval.id, tipe, alasan, base_version },
    req
  });

  return newApproval;
}

/**
 * Setujui permintaan – SATU transaksi atomik:
 *  1. UPDATE approval SET status='approved' WHERE id=$1 AND status='pending' (cek rows=1)
 *  2. Cek base_version vs version baris terkini
 *  3. Terapkan perubahan via applyFn(tx, payload, entitas_id)
 *  4. Catat audit log
 *  5. COMMIT
 *
 * Efek samping (WA) dikembalikan ke pemanggil untuk dieksekusi SETELAH commit (outbox).
 */
async function setujui(tx, { approval_id, decided_by, decision_note, req, applyFn }) {
  // 0. Ambil dulu untuk validasi (before locking)
  const { rows: check } = await tx.query(
    'SELECT id, status, requested_by FROM approval_requests WHERE id = $1',
    [approval_id]
  );
  const ap = check[0];
  if (!ap) throw Object.assign(new Error('Permintaan tidak ditemukan'), { code: 'NOT_FOUND', status: 404 });
  if (ap.requested_by === decided_by)
    throw Object.assign(new Error('Pemohon tidak dapat menyetujui permintaan miliknya sendiri'), { code: 'SELF_APPROVAL', status: 403 });
  if (ap.status !== 'pending')
    throw Object.assign(new Error(`Permintaan sudah ${ap.status}, tidak bisa disetujui`), { code: 'NOT_PENDING', status: 409 });

  // 1. Kunci & update status dalam satu UPDATE atomik
  const { rows: updated } = await tx.query(`
    UPDATE approval_requests
    SET status = 'approved', decided_by = $1, decided_at = now(),
        decision_note = $2, applied_at = now()
    WHERE id = $3 AND status = 'pending'
    RETURNING *
  `, [decided_by, decision_note || null, approval_id]);

  if (updated.length === 0) {
    throw Object.assign(new Error('Gagal mengunci permintaan (race condition)'), { code: 'LOCK_FAIL', status: 409 });
  }

  const approval = updated[0];

  // 2. Verifikasi base_version vs version saat ini
  const entitasTable = tableFromEntitas(approval.entitas);
  if (entitasTable) {
    const { rows: current } = await tx.query(
      `SELECT version FROM ${entitasTable} WHERE id = $1`,
      [approval.entitas_id]
    );
    if (current.length === 0) {
      throw Object.assign(
        new Error(`Entitas ${approval.entitas}#${approval.entitas_id} tidak lagi ada (sudah dihapus?)`),
        { code: 'ENTITY_GONE', status: 409 }
      );
    }
    if (current[0].version !== approval.base_version) {
      // Tandai stale di LUAR transaksi (tx akan di-rollback oleh pemanggil).
      // Pemanggil harus panggil markStale(approval_id) setelah ROLLBACK.
      const err = Object.assign(
        new Error('Data telah berubah sejak permintaan diajukan. Permintaan menjadi stale; mohon ajukan ulang.'),
        { code: 'STALE', status: 409, staleApprovalId: approval_id }
      );
      throw err;
    }
  }

  // 3. Terapkan perubahan via applyFn (implementasi domain dari pemanggil)
  let beforeState = null;
  let afterState = null;
  if (typeof applyFn === 'function') {
    const applyResult = await applyFn(tx, approval.payload, approval.entitas_id, approval);
    beforeState = applyResult?.before || null;
    afterState  = applyResult?.after  || null;
  }

  // 4. Audit log
  await audit.record(tx, {
    actor: { id: decided_by, role: req?.user?.role || 'owner' },
    aksi: `approval.setujui.${approval.tipe}`,
    entitas: approval.entitas,
    entitas_id: approval.entitas_id,
    sebelum: beforeState,
    sesudah: afterState,
    approval_id: approval.id,
    req
  });

  return approval;
}

/**
 * Tolak permintaan – atomik dalam transaksi tx
 */
async function tolak(tx, { approval_id, decided_by, decision_note, req }) {
  const { rows: updated } = await tx.query(`
    UPDATE approval_requests
    SET status = 'rejected', decided_by = $1, decided_at = now(), decision_note = $2
    WHERE id = $3 AND status = 'pending'
    RETURNING *
  `, [decided_by, decision_note || null, approval_id]);

  if (updated.length === 0) {
    const { rows } = await tx.query('SELECT status FROM approval_requests WHERE id = $1', [approval_id]);
    if (!rows[0]) throw Object.assign(new Error('Permintaan tidak ditemukan'), { code: 'NOT_FOUND', status: 404 });
    throw Object.assign(new Error(`Permintaan sudah ${rows[0].status}, tidak bisa ditolak`), { code: 'NOT_PENDING', status: 409 });
  }

  const approval = updated[0];

  await audit.record(tx, {
    actor: { id: decided_by, role: req?.user?.role || 'owner' },
    aksi: `approval.tolak.${approval.tipe}`,
    entitas: approval.entitas,
    entitas_id: approval.entitas_id,
    sebelum: null,
    sesudah: { decision_note: decision_note || null },
    approval_id: approval.id,
    req
  });

  return approval;
}

/**
 * Batalkan permintaan (oleh pemohon sendiri atau Owner)
 */
async function batalkan(tx, { approval_id, cancelled_by, req }) {
  const { rows: updated } = await tx.query(`
    UPDATE approval_requests
    SET status = 'cancelled', decided_by = $1, decided_at = now()
    WHERE id = $2 AND status = 'pending'
    RETURNING *
  `, [cancelled_by, approval_id]);

  if (updated.length === 0) {
    const { rows } = await tx.query('SELECT status FROM approval_requests WHERE id = $1', [approval_id]);
    if (!rows[0]) throw Object.assign(new Error('Permintaan tidak ditemukan'), { code: 'NOT_FOUND', status: 404 });
    throw Object.assign(new Error(`Permintaan sudah ${rows[0].status}, tidak bisa dibatalkan`), { code: 'NOT_PENDING', status: 409 });
  }

  const approval = updated[0];

  await audit.record(tx, {
    actor: { id: cancelled_by, role: req?.user?.role },
    aksi: `approval.batalkan.${approval.tipe}`,
    entitas: approval.entitas,
    entitas_id: approval.entitas_id,
    sebelum: null,
    sesudah: { cancelled_by },
    approval_id: approval.id,
    req
  });

  return approval;
}

/**
 * Expire semua approval_requests yang lewat batas waktu.
 * Dipanggil oleh cron periodik (misalnya setiap jam).
 */
async function expireAll() {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    const { rows: expired } = await client.query(`
      UPDATE approval_requests
      SET status = 'expired'
      WHERE status = 'pending' AND expires_at < now()
      RETURNING id, tipe, entitas, entitas_id, requested_by
    `);

    if (expired.length > 0) {
      console.log(`[approval] Expired ${expired.length} permintaan persetujuan lewat waktu.`);
      // Catat audit log untuk setiap yang expired
      for (const ap of expired) {
        await audit.record(client, {
          actor: null,
          aksi: `approval.expired.${ap.tipe}`,
          entitas: ap.entitas,
          entitas_id: ap.entitas_id,
          sebelum: { status: 'pending' },
          sesudah: { status: 'expired' },
          approval_id: ap.id,
          req: null
        });
      }
    }

    await client.query('COMMIT');
    return expired.length;
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[approval] expireAll error:', err);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Resolver aturan: apakah aksi ini perlu approval, langsung, atau dilarang?
 * Kembalikan: 'direct' | 'approval' | 'forbidden'
 */
async function resolveAksi(tipe, actorRole) {
  const rule = await getAturan(tipe);
  if (!rule) return 'direct'; // Tidak ada aturan = tidak perlu approval

  if (!rule.requires_owner) return 'direct'; // Semua role boleh langsung
  if (actorRole === 'owner') return 'direct'; // Owner selalu langsung
  return 'approval'; // Staff harus minta approval
}

/**
 * Mapping entitas -> nama tabel untuk cek version
 */
function tableFromEntitas(entitas) {
  const map = {
    booking:   'bookings',
    pelunasan: 'pelunasan',
    payment:   'payments'
  };
  return map[entitas] || null;
}

/**
 * Tandai approval sebagai stale di luar transaksi (setelah rollback setujui).
 */
async function markStale(approval_id) {
  await db.query(
    "UPDATE approval_requests SET status='stale' WHERE id=$1 AND status='pending'",
    [approval_id]
  );
}

module.exports = {
  ajukan,
  setujui,
  tolak,
  batalkan,
  expireAll,
  markStale,
  getAturan,
  getAllRules,
  resolveAksi,
  invalidateRulesCache
};
