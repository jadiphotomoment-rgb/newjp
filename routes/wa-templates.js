'use strict';

const express = require('express');
const router  = express.Router();
const db      = require('../database');
const auth    = require('../middleware/auth');

// ── GET /api/wa-templates — list all templates ─────────────────
router.get('/', auth, auth.requirePermission('wa_template.manage'), async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id, key, label, description, template, variables, category, is_active, updated_at
       FROM wa_templates ORDER BY category, id`
    );
    res.json(rows);
  } catch (err) {
    console.error('[wa-templates] GET error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// ── GET /api/wa-templates/:key — get single template by key ────
router.get('/:key', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id, key, label, description, template, variables, category, is_active, updated_at
       FROM wa_templates WHERE key = $1`,
      [req.params.key]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Template tidak ditemukan' });
    res.json(rows[0]);
  } catch (err) {
    console.error('[wa-templates] GET key error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// ── PATCH /api/wa-templates/:key — update template ─────────────
router.patch('/:key', auth, auth.requirePermission('wa_template.manage'), async (req, res) => {
  const { template, label, description, is_active } = req.body;

  if (!template || !template.trim()) {
    return res.status(400).json({ error: 'Isi template tidak boleh kosong' });
  }

  try {
    const { rows } = await db.query(
      `UPDATE wa_templates
       SET template   = $1,
           label      = COALESCE($2, label),
           description = COALESCE($3, description),
           is_active  = COALESCE($4, is_active),
           updated_at = now()
       WHERE key = $5
       RETURNING id, key, label, template, is_active, updated_at`,
      [template.trim(), label || null, description || null, is_active ?? null, req.params.key]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Template tidak ditemukan' });
    res.json({ message: 'Template berhasil diperbarui', template: rows[0] });
  } catch (err) {
    console.error('[wa-templates] PATCH error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// ── POST /api/wa-templates/:key/reset — reset template ke default ──
router.post('/:key/reset', auth, auth.requirePermission('wa_template.manage'), async (req, res) => {
  const defaults = {
    booking_confirmed: {
      template: `✅ *Booking Dikonfirmasi — Jadiphoto.Moment*

Halo {{client_name}},

Booking Anda untuk tanggal *{{event_date}}* pukul *{{event_time}}* telah dikonfirmasi. DP sebesar *{{dp_amount}}* sudah kami terima dan tanggal resmi terkunci. 🎉

📍 *Lokasi:* {{location}}
💰 *Total Paket:* {{package_price}}

Terima kasih telah mempercayai Jadiphoto.Moment! Kami siap mengabadikan momen terbaik Anda. 📸`,
    },
    dp_rejected: {
      template: `❌ *Bukti Transfer Ditolak*

Halo {{client_name}},

Bukti transfer DP Anda tidak dapat diverifikasi.{{reason_text}}

Silakan upload ulang bukti transfer yang valid melalui link yang telah dikirimkan sebelumnya.

Terima kasih atas pengertiannya. 🙏`,
    },
    sortir_selesai_admin: {
      template: `📸 *NOTIFIKASI SORTIR FOTO BARU — JADIPHOTO.MOMENT*
------------------------------------
*Nama Klien / Folder:* {{client_name}}
*Tanggal Seleksi:* {{selection_date}}
*Total Foto Dipilih:* {{total_selected}} Foto (Limit Maks: {{photo_limit}})

*DAFTAR FILE FOTO:*
{{file_list}}
------------------------------------
_Pesan ini dikirim otomatis oleh System Jadiphoto.Moment._`,
    },
    foto_selesai_edit: {
      template: `📸 *Hasil Foto Selesai Diedit — Jadiphoto.Moment*

Halo *{{client_name}}*,
Kabar gembira! Foto-foto pilihan Anda telah selesai diedit dan siap untuk diunduh. 🎉

📁 *Link Google Drive:*
{{drive_url}}
{{note_section}}
Terima kasih telah mempercayai layanan fotografi Jadiphoto.Moment! Silakan beri tahu kami jika ada pertanyaan atau kendala unduhan. 📸✨`,
    },
    dp_uploaded_admin: {
      template: `📸 *Booking Baru (Jadiphoto.Moment) — DP Masuk!*

Klien: *{{client_name}}*
No. HP: {{client_phone}}

Bukti transfer sudah diupload dan menunggu verifikasi Anda.

Cek dashboard admin untuk approve/reject.`,
    },
    session_expired: {
      template: `⚠️ *Pemberitahuan: Sesi Sortir Foto Kadaluarsa*

Halo *{{client_name}}*,

Mohon maaf, batas waktu untuk pemilihan foto Anda telah habis dan sesi sortir saat ini telah dinonaktifkan.

Jika Anda masih ingin melanjutkan proses pemilihan foto, silakan hubungi admin Jadiphoto.Moment untuk membuka kembali akses galeri Anda.

Terima kasih. 🙏`,
    },
  };

  const def = defaults[req.params.key];
  if (!def) return res.status(404).json({ error: 'Template tidak ditemukan atau tidak bisa direset' });

  try {
    const { rows } = await db.query(
      `UPDATE wa_templates SET template = $1, updated_at = now() WHERE key = $2
       RETURNING id, key, label, template, updated_at`,
      [def.template, req.params.key]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Template tidak ditemukan' });
    res.json({ message: 'Template berhasil direset ke default', template: rows[0] });
  } catch (err) {
    console.error('[wa-templates] reset error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

module.exports = router;
