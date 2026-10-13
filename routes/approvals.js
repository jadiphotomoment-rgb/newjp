'use strict';

/**
 * routes/approvals.js
 * Endpoint manajemen approval requests (Inbox Owner, submit staf, detail, history)
 */

const express  = require('express');
const router   = express.Router();
const db       = require('../database');
const auth     = require('../middleware/auth');
const { requirePermission } = auth;
const approvalSvc = require('../services/approval');
const { withAudit } = require('../services/audit');

// ── GET /api/approvals ────────────────────────────────────────
// Owner: semua; Staff: hanya milik sendiri
router.get('/', auth, async (req, res) => {
  const { status, cursor, limit = 20 } = req.query;
  const isOwner = req.user.role === 'owner';

  const params = [];
  const conditions = [];

  if (!isOwner) {
    params.push(req.user.id);
    conditions.push(`ar.requested_by = $${params.length}`);
  }

  if (status) {
    params.push(status);
    conditions.push(`ar.status = $${params.length}`);
  }

  if (cursor) {
    params.push(cursor);
    conditions.push(`(ar.requested_at, ar.id) < ($${params.length}::timestamptz, 0)`);
  }

  const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
  const pageLimit = Math.min(parseInt(limit, 10) || 20, 100);
  params.push(pageLimit);

  try {
    const { rows } = await db.query(`
      SELECT
        ar.*,
        ur.nama AS requested_by_name,
        ud.nama AS decided_by_name
      FROM approval_requests ar
      LEFT JOIN users ur ON ar.requested_by = ur.id
      LEFT JOIN users ud ON ar.decided_by = ud.id
      ${where}
      ORDER BY ar.requested_at DESC, ar.id DESC
      LIMIT $${params.length}
    `, params);

    res.json({ items: rows, count: rows.length });
  } catch (err) {
    console.error('[approvals] GET error:', err);
    res.status(500).json({ error: 'Gagal mengambil daftar approval' });
  }
});

// ── GET /api/approvals/:id ─────────────────────────────────────
router.get('/:id', auth, async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT
        ar.*,
        ur.nama AS requested_by_name,
        ud.nama AS decided_by_name
      FROM approval_requests ar
      LEFT JOIN users ur ON ar.requested_by = ur.id
      LEFT JOIN users ud ON ar.decided_by = ud.id
      WHERE ar.id = $1
    `, [req.params.id]);

    if (!rows[0]) return res.status(404).json({ error: 'Permintaan tidak ditemukan' });

    const isOwner = req.user.role === 'owner';
    const ap = rows[0];
    if (!isOwner && ap.requested_by !== req.user.id) {
      return res.status(403).json({ error: 'Akses ditolak' });
    }

    res.json(ap);
  } catch (err) {
    console.error('[approvals] GET :id error:', err);
    res.status(500).json({ error: 'Gagal mengambil detail approval' });
  }
});

// ── POST /api/approvals ────────────────────────────────────────
// Staf mengajukan permintaan approval
router.post('/', auth, async (req, res) => {
  const { tipe, entitas, entitas_id, payload, base_version, alasan } = req.body;

  if (!tipe || !entitas || !entitas_id || payload === undefined) {
    return res.status(400).json({ error: 'Field tipe, entitas, entitas_id, dan payload wajib diisi' });
  }

  try {
    let result;
    await withAudit(async (tx, _recordAudit) => {
      result = await approvalSvc.ajukan(tx, {
        tipe,
        entitas,
        entitas_id: parseInt(entitas_id, 10),
        payload,
        base_version: parseInt(base_version, 10) || 1,
        alasan,
        requested_by: req.user.id,
        req
      });
    }, { req });

    res.status(201).json({ message: 'Permintaan persetujuan berhasil diajukan', approval: result });
  } catch (err) {
    console.error('[approvals] POST error:', err);
    const status = err.status || 500;
    res.status(status).json({ error: err.message });
  }
});

// ── POST /api/approvals/:id/approve ───────────────────────────
// Owner menyetujui; applyFn tidak dieksekusi di sini (handler booking/pelunasan yang memanggil)
router.post('/:id/approve', auth, requirePermission('approval.decide'), async (req, res) => {
  const { decision_note } = req.body;
  const approval_id = parseInt(req.params.id, 10);

  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    // Ambil detail approval untuk menentukan handler domain
    const { rows } = await client.query(
      'SELECT * FROM approval_requests WHERE id = $1',
      [approval_id]
    );
    if (!rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Permintaan tidak ditemukan' });
    }

    const approval = rows[0];

    // applyFn generik berdasarkan tipe approval
    const applyFn = buildApplyFn(approval.tipe);

    const result = await approvalSvc.setujui(client, {
      approval_id,
      decided_by: req.user.id,
      decision_note,
      req,
      applyFn
    });

    await client.query('COMMIT');

    // Efek samping (misal kirim WA) setelah commit – outbox pattern
    triggerAfterCommitEffects(result).catch(e =>
      console.warn('[approvals] after-commit effect error:', e.message)
    );

    res.json({ message: 'Permintaan berhasil disetujui', approval: result });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[approvals] approve error:', err);
    // Jika stale, tandai di luar transaksi
    if (err.code === 'STALE' && err.staleApprovalId) {
      try { await approvalSvc.markStale(err.staleApprovalId); } catch (_) {}
    }
    const status = err.status || 500;
    res.status(status).json({ error: err.message });

  } finally {
    client.release();
  }
});

// ── POST /api/approvals/:id/reject ────────────────────────────
router.post('/:id/reject', auth, requirePermission('approval.decide'), async (req, res) => {
  const { decision_note } = req.body;
  const approval_id = parseInt(req.params.id, 10);

  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const result = await approvalSvc.tolak(client, {
      approval_id,
      decided_by: req.user.id,
      decision_note,
      req
    });
    await client.query('COMMIT');
    res.json({ message: 'Permintaan berhasil ditolak', approval: result });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[approvals] reject error:', err);
    res.status(err.status || 500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ── POST /api/approvals/:id/cancel ────────────────────────────
// Pemohon bisa membatalkan permintaan miliknya; Owner bisa membatalkan semua
router.post('/:id/cancel', auth, async (req, res) => {
  const approval_id = parseInt(req.params.id, 10);

  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      'SELECT requested_by FROM approval_requests WHERE id = $1',
      [approval_id]
    );
    if (!rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Permintaan tidak ditemukan' });
    }

    const isOwner = req.user.role === 'owner';
    const isPemohon = rows[0].requested_by === req.user.id;
    if (!isOwner && !isPemohon) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Hanya pemohon atau Owner yang dapat membatalkan permintaan' });
    }

    const result = await approvalSvc.batalkan(client, {
      approval_id,
      cancelled_by: req.user.id,
      req
    });

    await client.query('COMMIT');
    res.json({ message: 'Permintaan berhasil dibatalkan', approval: result });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[approvals] cancel error:', err);
    res.status(err.status || 500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ── GET/PUT /api/settings/approval-rules ─────────────────────
router.get('/settings/rules', auth, requirePermission('user.manage'), async (req, res) => {
  try {
    const { rows } = await db.query('SELECT * FROM approval_rules ORDER BY tipe');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Gagal mengambil aturan approval' });
  }
});

router.put('/settings/rules/:tipe', auth, requirePermission('user.manage'), async (req, res) => {
  const { requires_owner, expires_days } = req.body;
  const { tipe } = req.params;

  try {
    const { rows } = await db.query(`
      UPDATE approval_rules
      SET requires_owner = $1, expires_days = $2
      WHERE tipe = $3
      RETURNING *
    `, [requires_owner, expires_days || 7, tipe]);

    if (!rows[0]) return res.status(404).json({ error: 'Tipe tidak ditemukan' });

    approvalSvc.invalidateRulesCache();
    res.json({ message: 'Aturan berhasil diperbarui', rule: rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Gagal memperbarui aturan' });
  }
});

// ── Helper: Pilih applyFn berdasarkan tipe approval ───────────
function buildApplyFn(tipe) {
  return async (tx, payload, entitas_id) => {
    if (tipe === 'booking.cancel_with_dp' || tipe === 'booking.delete') {
      const { rows: before } = await tx.query('SELECT * FROM bookings WHERE id = $1', [entitas_id]);
      await tx.query(
        `UPDATE bookings SET status = 'cancelled', deleted_at = now(), updated_by = NULL,
          version = version + 1 WHERE id = $1`,
        [entitas_id]
      );
      const { rows: after } = await tx.query('SELECT status, version FROM bookings WHERE id = $1', [entitas_id]);
      return { before: before[0] ? { status: before[0].status } : null, after: after[0] || null };
    }

    if (tipe === 'booking.discount' || tipe === 'tagihan.override_amount') {
      const { rows: before } = await tx.query(
        'SELECT package_price, dp_amount, version FROM bookings WHERE id = $1',
        [entitas_id]
      );
      const updates = {};
      if (payload.package_price !== undefined) updates.package_price = payload.package_price;
      if (payload.dp_amount !== undefined) updates.dp_amount = payload.dp_amount;
      if (payload.discount !== undefined) updates.discount = payload.discount;

      const setClauses = Object.keys(updates).map((k, i) => `${k} = $${i + 2}`).join(', ');
      const vals = Object.values(updates);
      if (setClauses) {
        await tx.query(
          `UPDATE bookings SET ${setClauses}, version = version + 1 WHERE id = $1`,
          [entitas_id, ...vals]
        );
      }
      const { rows: after } = await tx.query(
        'SELECT package_price, dp_amount, version FROM bookings WHERE id = $1',
        [entitas_id]
      );
      return { before: before[0] || null, after: after[0] || null };
    }

    return { before: null, after: payload };
  };
}

// ── Efek samping after-commit (WA / notifikasi) ────────────────
async function triggerAfterCommitEffects(approval) {
  // Implementasi bisa mengirim WA ke pemohon saat approval disetujui
  // Dipanggil setelah commit, tidak di dalam transaksi
  // Untuk sekarang: cukup log; integrasi WA dilakukan di Fase 5
  console.log(`[approval] After-commit effect: tipe=${approval.tipe} id=${approval.id}`);
}

module.exports = router;
