'use strict';

const db = require('../database');

/**
 * Redaksi field sensitif (password, token, hash, dan nomor WhatsApp)
 */
function maskValue(key, val) {
  if (val === null || val === undefined) return val;

  const lowerKey = String(key).toLowerCase();

  // Redaksi password, token, hash, secret
  if (/(password|token|secret|hash|credential)/i.test(lowerKey)) {
    return '[REDACTED]';
  }

  // Redaksi nomor WhatsApp / telepon (pertahankan 4 digit awal & 4 digit akhir)
  if (/(phone|wa|telepon|whatsapp|target)/i.test(lowerKey)) {
    const str = String(val).replace(/\s+/g, '');
    if (str.length >= 8) {
      return str.slice(0, 4) + '****' + str.slice(-4);
    }
    return '[REDACTED]';
  }

  // Rekursif jika object/array
  if (typeof val === 'object') {
    return sanitizeObject(val);
  }

  return val;
}

function sanitizeObject(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) {
    return obj.map((item, idx) => maskValue(idx, item));
  }
  const clean = {};
  for (const [k, v] of Object.entries(obj)) {
    clean[k] = maskValue(k, v);
  }
  return clean;
}

/**
 * Hitung perbedaan (diff) antara objek sebelum dan sesudah.
 * Hanya menyimpan field yang nilainya berubah.
 */
function computeDiff(sebelum, sesudah) {
  if (!sebelum && !sesudah) {
    return { diffBefore: null, diffAfter: null };
  }
  if (!sebelum) {
    return { diffBefore: null, diffAfter: sanitizeObject(sesudah) };
  }
  if (!sesudah) {
    return { diffBefore: sanitizeObject(sebelum), diffAfter: null };
  }

  const cleanBefore = sanitizeObject(sebelum);
  const cleanAfter = sanitizeObject(sesudah);

  const diffBefore = {};
  const diffAfter = {};

  const allKeys = new Set([...Object.keys(cleanBefore), ...Object.keys(cleanAfter)]);
  let hasChange = false;

  for (const key of allKeys) {
    const valBefore = cleanBefore[key];
    const valAfter = cleanAfter[key];

    const strBefore = JSON.stringify(valBefore);
    const strAfter = JSON.stringify(valAfter);

    if (strBefore !== strAfter) {
      hasChange = true;
      if (key in cleanBefore) diffBefore[key] = valBefore;
      if (key in cleanAfter) diffAfter[key] = valAfter;
    }
  }

  return {
    diffBefore: hasChange ? diffBefore : {},
    diffAfter: hasChange ? diffAfter : {}
  };
}

/**
 * Format IP agar aman untuk tipe INET PostgreSQL
 */
function formatIp(ip) {
  if (!ip || typeof ip !== 'string') return null;
  const cleanIp = ip.trim();
  // Tangani IPv4 atau IPv6 valid
  if (cleanIp === '::1' || cleanIp === '127.0.0.1') return cleanIp;
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(cleanIp)) return cleanIp;
  if (/^[a-fA-F0-9:]+$/.test(cleanIp)) return cleanIp;
  return null;
}

/**
 * Catat audit log di dalam transaksi database yang sedang berjalan (tx)
 */
async function record(tx, { actor, aksi, entitas, entitas_id, sebelum, sesudah, approval_id, req } = {}) {
  if (!tx || typeof tx.query !== 'function') {
    throw new Error('Audit record requires an active database transaction client (tx)');
  }

  const effectiveActor = actor || (req && req.user ? { id: req.user.id, role: req.user.role } : null);
  const actorId = effectiveActor ? effectiveActor.id : null;
  const actorRole = effectiveActor ? effectiveActor.role : null;

  const requestId = req?.requestId || req?.headers?.['x-request-id'] || null;
  const rawIp = req?.ip || req?.connection?.remoteAddress || null;
  const ip = formatIp(rawIp);

  const { diffBefore, diffAfter } = computeDiff(sebelum, sesudah);

  const sql = `
    INSERT INTO audit_log (
      actor_id, actor_role, aksi, entitas, entitas_id,
      sebelum, sesudah, approval_id, ip, request_id
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::inet, $10)
    RETURNING id, created_at
  `;

  const params = [
    actorId,
    actorRole,
    aksi,
    entitas,
    entitas_id || null,
    diffBefore ? JSON.stringify(diffBefore) : null,
    diffAfter ? JSON.stringify(diffAfter) : null,
    approval_id || null,
    ip,
    requestId
  ];

  const res = await tx.query(sql, params);
  return res.rows[0];
}

/**
 * Helper withAudit: Membungkus eksekusi fungsi dalam satu transaksi DB dengan audit log otomatis
 */
async function withAudit(fn, { req, actor } = {}) {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    const recordAudit = (auditParams) => {
      return record(client, {
        req,
        actor,
        ...auditParams
      });
    };

    const result = await fn(client, recordAudit);

    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  record,
  withAudit,
  computeDiff,
  maskValue,
  sanitizeObject
};
