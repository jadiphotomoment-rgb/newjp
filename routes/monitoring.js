'use strict';

const express = require('express');
const router = express.Router();
const db = require('../database');
const auth = require('../middleware/auth');

router.use(auth);
router.use(auth.requirePermission('user.manage'));

// GET /api/monitoring/staff — Metrik aktivitas staf (Owner only)
router.get('/staff', async (req, res) => {
  const { from, to } = req.query;

  const conditions = [];
  const params = [];

  if (from) {
    params.push(new Date(from));
    conditions.push(`a.created_at >= $${params.length}`);
  }
  if (to) {
    params.push(new Date(to));
    conditions.push(`a.created_at <= $${params.length}`);
  }

  const dateFilter = conditions.length > 0 ? ' AND ' + conditions.join(' AND ') : '';

  try {
    // 1. Ambil semua user staf
    const staffRes = await db.query(
      `SELECT id, nama, nama AS name, email, role, is_active, created_at
       FROM users
       WHERE role = 'staff'
       ORDER BY nama ASC`
    );
    const staffList = staffRes.rows;

    // 2. Agregasi aksi per staff dari audit_log
    const activityQuery = `
      SELECT 
        a.actor_id,
        COUNT(*)::int AS total_actions,
        MAX(a.created_at) AS last_action_at
      FROM audit_log a
      WHERE a.actor_id IS NOT NULL ${dateFilter}
      GROUP BY a.actor_id
    `;
    const activityRes = await db.query(activityQuery, params);
    const activityMap = new Map();
    activityRes.rows.forEach(r => activityMap.set(r.actor_id, r));

    // 3. Breakdown aksi per user
    const breakdownQuery = `
      SELECT 
        a.actor_id,
        a.aksi,
        COUNT(*)::int AS count
      FROM audit_log a
      WHERE a.actor_id IS NOT NULL ${dateFilter}
      GROUP BY a.actor_id, a.aksi
      ORDER BY count DESC
    `;
    const breakdownRes = await db.query(breakdownQuery, params);
    const breakdownMap = new Map();
    breakdownRes.rows.forEach(r => {
      if (!breakdownMap.has(r.actor_id)) {
        breakdownMap.set(r.actor_id, {});
      }
      breakdownMap.get(r.actor_id)[r.aksi] = r.count;
    });

    // 4. Hitung approval requests per staff
    const approvalRes = await db.query(
      `SELECT requested_by,
              COUNT(*)::int AS total_requested,
              COUNT(CASE WHEN status = 'approved' THEN 1 END)::int AS approved_count,
              COUNT(CASE WHEN status = 'rejected' THEN 1 END)::int AS rejected_count,
              COUNT(CASE WHEN status = 'pending' THEN 1 END)::int AS pending_count
       FROM approval_requests
       GROUP BY requested_by`
    );
    const approvalMap = new Map();
    approvalRes.rows.forEach(r => approvalMap.set(r.requested_by, r));

    // 5. Gabungkan metrik
    const metrics = staffList.map(s => {
      const act = activityMap.get(s.id) || { total_actions: 0, last_action_at: null };
      const app = approvalMap.get(s.id) || {
        total_requested: 0,
        approved_count: 0,
        rejected_count: 0,
        pending_count: 0
      };
      return {
        id: s.id,
        nama: s.nama,
        name: s.nama,
        email: s.email,
        is_active: s.is_active,
        total_actions: act.total_actions,
        last_action_at: act.last_action_at,
        actions_breakdown: breakdownMap.get(s.id) || {},
        approval_stats: app
      };
    });

    res.json({
      period: { from: from || null, to: to || null },
      total_staff: staffList.length,
      staff_metrics: metrics
    });
  } catch (err) {
    console.error('[monitoring] staff error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// GET /api/monitoring/daily-approvals — Ringkasan harian approval staf & deteksi anomali (Owner only)
router.get('/daily-approvals', async (req, res) => {
  const { date, cursor, limit = 20 } = req.query;
  const targetLimit = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);

  // Tanggal default Asia/Jakarta (WIB)
  let dateStr = date;
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    dateStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jakarta' });
  }

  try {
    // 1. Agregat ringkasan hari tersebut
    const summaryQuery = `
      SELECT 
        COUNT(*)::int AS total_approvals,
        COALESCE(SUM((a.sesudah->>'nominal_diterima')::numeric), 0)::numeric AS total_dp,
        COUNT(CASE WHEN (a.sesudah->>'anomali')::boolean = true THEN 1 END)::int AS total_anomali
      FROM audit_log a
      WHERE a.aksi = 'booking.approve'
        AND (a.created_at AT TIME ZONE 'Asia/Jakarta')::date = $1::date
    `;
    const { rows: summaryRows } = await db.query(summaryQuery, [dateStr]);
    const summary = summaryRows[0] || { total_approvals: 0, total_dp: 0, total_anomali: 0 };

    // 2. Breakdown per staf
    const perStaffQuery = `
      SELECT 
        u.id AS staff_id,
        COALESCE(u.nama, 'Unknown') AS staff_nama,
        COUNT(*)::int AS total_approvals,
        COALESCE(SUM((a.sesudah->>'nominal_diterima')::numeric), 0)::numeric AS total_dp,
        COUNT(CASE WHEN (a.sesudah->>'anomali')::boolean = true THEN 1 END)::int AS anomali_count
      FROM audit_log a
      LEFT JOIN users u ON a.actor_id = u.id
      WHERE a.aksi = 'booking.approve'
        AND (a.created_at AT TIME ZONE 'Asia/Jakarta')::date = $1::date
      GROUP BY u.id, u.nama
      ORDER BY total_approvals DESC
    `;
    const { rows: perStaff } = await db.query(perStaffQuery, [dateStr]);

    // 3. Daftar approval dengan Keyset Pagination
    const params = [dateStr];
    let cursorClause = '';
    if (cursor) {
      params.push(parseInt(cursor, 10));
      cursorClause = `AND a.id < $${params.length}`;
    }
    params.push(targetLimit + 1);

    const listQuery = `
      SELECT 
        a.id,
        a.actor_id AS staff_id,
        COALESCE(u.nama, 'Unknown') AS staff_nama,
        a.entitas_id AS booking_id,
        b.client_name,
        (a.sesudah->>'nominal_diterima')::numeric AS nominal_diterima,
        (a.sesudah->>'dp_diminta')::numeric AS dp_diminta,
        (a.sesudah->>'selisih')::numeric AS selisih,
        a.sesudah->>'alasan_selisih' AS alasan_selisih,
        (a.sesudah->>'anomali')::boolean AS is_anomali,
        a.sesudah->>'calendar_warning' AS calendar_warning,
        a.created_at AS approved_at,
        EXTRACT(HOUR FROM a.created_at AT TIME ZONE 'Asia/Jakarta')::int AS hour_wib,
        (
          SELECT a_prev.created_at 
          FROM audit_log a_prev 
          WHERE a_prev.actor_id = a.actor_id 
            AND a_prev.aksi = 'booking.approve' 
            AND a_prev.id < a.id 
          ORDER BY a_prev.id DESC 
          LIMIT 1
        ) AS prev_approved_at
      FROM audit_log a
      LEFT JOIN users u ON a.actor_id = u.id
      LEFT JOIN bookings b ON a.entitas_id = b.id
      WHERE a.aksi = 'booking.approve'
        AND (a.created_at AT TIME ZONE 'Asia/Jakarta')::date = $1::date
        ${cursorClause}
      ORDER BY a.id DESC
      LIMIT $${params.length}
    `;

    const { rows: itemsRows } = await db.query(listQuery, params);
    const hasMore = itemsRows.length > targetLimit;
    const items = hasMore ? itemsRows.slice(0, targetLimit) : itemsRows;
    const nextCursor = hasMore && items.length > 0 ? items[items.length - 1].id : null;

    // Evaluasi flags anomali
    const enrichedItems = items.map(item => {
      const flags = [];
      if (item.nominal_diterima !== null && item.dp_diminta !== null && Number(item.nominal_diterima) !== Number(item.dp_diminta)) {
        flags.push('nominal_berbeda');
      }
      if (item.hour_wib < 8 || item.hour_wib >= 21) {
        flags.push('di_luar_jam_kerja');
      }
      if (item.prev_approved_at) {
        const diffSec = Math.abs(new Date(item.approved_at) - new Date(item.prev_approved_at)) / 1000;
        if (diffSec < 10) {
          flags.push('beruntun_sangat_cepat');
        }
      }

      return {
        id: item.id,
        booking_id: item.booking_id,
        client_name: item.client_name,
        staff: {
          id: item.staff_id,
          nama: item.staff_nama
        },
        nominal_diterima: Number(item.nominal_diterima || 0),
        dp_diminta: Number(item.dp_diminta || 0),
        selisih: Number(item.selisih || 0),
        alasan_selisih: item.alasan_selisih,
        calendar_warning: item.calendar_warning,
        approved_at: item.approved_at,
        anomali_flags: flags,
        has_anomali: flags.length > 0
      };
    });

    res.json({
      date: dateStr,
      summary: {
        total_approvals: summary.total_approvals,
        total_dp: Number(summary.total_dp),
        total_anomali: summary.total_anomali
      },
      per_staff: perStaff.map(s => ({
        staff_id: s.staff_id,
        staff_nama: s.staff_nama,
        total_approvals: s.total_approvals,
        total_dp: Number(s.total_dp),
        anomali_count: s.anomali_count
      })),
      items: enrichedItems,
      pagination: {
        limit: targetLimit,
        next_cursor: nextCursor,
        has_more: hasMore
      }
    });
  } catch (err) {
    console.error('[monitoring] daily-approvals error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

module.exports = router;

