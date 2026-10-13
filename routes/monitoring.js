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

module.exports = router;
