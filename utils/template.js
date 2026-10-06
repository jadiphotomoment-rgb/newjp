'use strict';

const db = require('../database');

// ── Fetch template from DB by key, apply variables ─────────────
async function getWaTemplate(key, variables = {}) {
  try {
    const { rows } = await db.query(
      `SELECT template, is_active FROM wa_templates WHERE key = $1`,
      [key]
    );
    if (!rows[0] || !rows[0].is_active) return null;

    let msg = rows[0].template;

    // Replace all {{key}} placeholders
    for (const [k, v] of Object.entries(variables)) {
      const regex = new RegExp(`{{${k}}}`, 'g');
      msg = msg.replace(regex, v !== null && v !== undefined ? String(v) : '-');
    }

    // Clean up any remaining {{xxx}} that didn't match
    msg = msg.replace(/{{[^}]+}}/g, '-');

    return msg;
  } catch (err) {
    console.error('[template] getWaTemplate error:', err);
    return null;
  }
}

module.exports = { getWaTemplate };
