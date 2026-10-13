'use strict';

const express = require('express');
const router = express.Router();
const db = require('../database');
const auth = require('../middleware/auth');

router.use(auth);

// GET /api/audit — Riwayat audit log dengan keyset pagination & RBAC filtering
router.get('/', async (req, res) => {
  const isOwner = req.user.role === 'owner';
  const {
    actor_id,
    aksi,
    entitas,
    entitas_id,
    from,
    to,
    cursor,
    limit: queryLimit
  } = req.query;

  const limit = Math.min(Math.max(parseInt(queryLimit, 10) || 20, 1), 100);

  const conditions = [];
  const params = [];

  // RBAC scope: Staff hanya bisa melihat miliknya sendiri
  if (!isOwner) {
    params.push(req.user.id);
    conditions.push(`a.actor_id = $${params.length}`);
  } else if (actor_id) {
    params.push(parseInt(actor_id, 10));
    conditions.push(`a.actor_id = $${params.length}`);
  }

  if (aksi) {
    params.push(aksi.trim());
    conditions.push(`a.aksi = $${params.length}`);
  }

  if (entitas) {
    params.push(entitas.trim());
    conditions.push(`a.entitas = $${params.length}`);
  }

  if (entitas_id) {
    params.push(entitas_id.toString().trim());
    conditions.push(`a.entitas_id = $${params.length}`);
  }

  if (from) {
    params.push(new Date(from));
    conditions.push(`a.created_at >= $${params.length}`);
  }

  if (to) {
    params.push(new Date(to));
    conditions.push(`a.created_at <= $${params.length}`);
  }

  // Keyset pagination: cursor format base64(created_at_iso + '|' + id)
  if (cursor) {
    try {
      const decoded = Buffer.from(cursor, 'base64').toString('utf8');
      const [cursorTime, cursorId] = decoded.split('|');
      if (cursorTime && cursorId) {
        params.push(new Date(cursorTime));
        const timeParamIdx = params.length;
        params.push(parseInt(cursorId, 10));
        const idParamIdx = params.length;

        conditions.push(`(a.created_at, a.id) < ($${timeParamIdx}, $${idParamIdx})`);
      }
    } catch (_) {
      // Abaikan cursor yang invalid
    }
  }

  const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

  params.push(limit + 1);
  const limitIdx = params.length;

  const query = `
    SELECT 
      a.id, a.request_id, a.actor_id, a.actor_role, a.aksi,
      a.entitas, a.entitas_id, a.sebelum, a.sesudah, a.approval_id,
      a.ip, a.created_at,
      u.nama AS actor_name, u.email AS actor_email
    FROM audit_log a
    LEFT JOIN users u ON a.actor_id = u.id
    ${whereClause}
    ORDER BY a.created_at DESC, a.id DESC
    LIMIT $${limitIdx}
  `;

  try {
    const { rows } = await db.query(query, params);

    let hasMore = false;
    let nextCursor = null;

    if (rows.length > limit) {
      hasMore = true;
      rows.pop(); // Hapus item ke limit + 1
    }

    if (hasMore && rows.length > 0) {
      const lastItem = rows[rows.length - 1];
      const rawCursor = `${new Date(lastItem.created_at).toISOString()}|${lastItem.id}`;
      nextCursor = Buffer.from(rawCursor, 'utf8').toString('base64');
    }

    res.json({
      items: rows,
      has_more: hasMore,
      next_cursor: nextCursor
    });
  } catch (err) {
    console.error('[audit-log] GET error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

module.exports = router;
