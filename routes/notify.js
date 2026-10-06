'use strict';

const express = require('express');
const router  = express.Router();
const https   = require('https');
const db      = require('../database');
const { getWaTemplate } = require('../utils/template');

// ── Send message via Fonnte API ───────────────────────────────
function sendWhatsApp(target, message) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ target, message, countryCode: '62' });

    const options = {
      hostname: 'api.fonnte.com',
      path:     '/send',
      method:   'POST',
      headers:  {
        'Authorization': process.env.FONNTE_TOKEN || '',
        'Content-Type':  'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        try { resolve(JSON.parse(raw)); }
        catch (_) { resolve({ status: res.statusCode >= 200 && res.statusCode < 300, raw }); }
      });
    });

    req.setTimeout(15000, () => { req.destroy(); reject(new Error('WhatsApp API timeout')); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Format WIB datetime string ────────────────────────────────
function formatDateWIB(date = new Date()) {
  const opts = { timeZone: 'Asia/Jakarta', hour12: false };
  const d = date.toLocaleDateString('id-ID', { ...opts, day: '2-digit', month: '2-digit', year: 'numeric' });
  const t = date.toLocaleTimeString('id-ID', { ...opts, hour: '2-digit', minute: '2-digit' });
  return `${d} ${t} WIB`;
}

// ── POST /api/notify ──────────────────────────────────────────
router.post('/', async (req, res) => {
  const { sessionUuid, selectedFiles } = req.body;

  // ── Validate input ────────────────────────────────────────
  if (!sessionUuid || !Array.isArray(selectedFiles) || selectedFiles.length === 0) {
    return res.status(400).json({ error: 'sessionUuid dan selectedFiles (array) wajib diisi' });
  }

  // ── Get session from DB ───────────────────────────────────
  let session;
  try {
    const { rows } = await db.query(
      "SELECT * FROM sessions WHERE uuid = $1 AND status = 'active'",
      [sessionUuid]
    );
    session = rows[0];
  } catch (err) {
    console.error('[notify] db error:', err);
    return res.status(500).json({ error: 'Database error' });
  }

  if (!session) {
    return res.status(404).json({ error: 'Sesi tidak ditemukan atau sudah selesai' });
  }

  // ── Validate limit ────────────────────────────────────────
  if (selectedFiles.length > session.photo_limit) {
    return res.status(400).json({
      error: `Pilihan melebihi batas maksimal (${session.photo_limit} foto)`,
    });
  }

  // Validate each file has id and name
  for (const f of selectedFiles) {
    if (!f.id || !f.name) {
      return res.status(400).json({ error: 'Setiap file harus memiliki id dan name' });
    }
  }

  // ── Save selections to DB (Transaction) ───────────────────
  let client;
  try {
    client = await db.getClient();
    await client.query('BEGIN');
    
    for (const f of selectedFiles) {
      await client.query(
        'INSERT INTO selections (session_id, file_id, file_name, note) VALUES ($1, $2, $3, $4)',
        [session.id, f.id, f.name, f.note || null]
      );
    }

    // ── Mark session as completed ─────────────────────────────
    await client.query(
      "UPDATE sessions SET status = 'completed', completed_at = CURRENT_TIMESTAMP WHERE id = $1",
      [session.id]
    );

    await client.query('COMMIT');
  } catch (err) {
    if (client) await client.query('ROLLBACK');
    console.error('[notify] transaction error:', err);
    return res.status(500).json({ error: 'Gagal menyimpan pilihan ke database' });
  } finally {
    if (client) client.release();
  }

  const fileList = selectedFiles
    .map((f, i) => {
      let line = `${f.name}`;
      if (f.note && f.note.trim()) line += `\n   _Catatan: ${f.note.trim()}_`;
      return line;
    })
    .join('\n');

  // Coba ambil template dari DB, fallback ke hardcode jika tidak ada
  let message = await getWaTemplate('sortir_selesai_admin', {
    client_name: session.client_name,
    selection_date: formatDateWIB(),
    total_selected: selectedFiles.length,
    photo_limit: session.photo_limit,
    file_list: fileList,
  });

  if (!message) {
    message = [
      '*NOTIFIKASI SORTIR FOTO BARU — JADIPHOTO.MOMENT*',
      '------------------------------------',
      `*Nama Klien / Folder:* ${session.client_name}`,
      `*Tanggal Seleksi:* ${formatDateWIB()}`,
      `*Total Foto Dipilih:* ${selectedFiles.length} Foto (Limit Maks: ${session.photo_limit})`,
      '',
      '*DAFTAR FILE FOTO:*',
      fileList,
      '------------------------------------',
      '_Pesan ini dikirim otomatis oleh System Jadiphoto.Moment._',
    ].join('\n');
  }

  // ── Send WhatsApp (skip if not configured) ────────────────
  const token  = process.env.FONNTE_TOKEN;
  const target = process.env.ADMIN_WHATSAPP;

  if (!token || !target || token === 'token_fonnte_anda_disini') {
    console.warn('⚠️  WhatsApp tidak dikonfigurasi – notifikasi dilewati');
    return res.json({
      success:   true,
      waSkipped: true,
      message:   'Pilihan berhasil disimpan. (Notifikasi WhatsApp dilewati – token belum dikonfigurasi)',
    });
  }

  try {
    const waResult = await sendWhatsApp(target, message);
    const waOk = waResult.status === true || waResult.status === 'true';
    res.json({
      success:  true,
      waSent:   waOk,
      message:  waOk
        ? 'Pilihan berhasil dikirim! Admin sudah mendapatkan notifikasi WhatsApp.'
        : 'Pilihan tersimpan, namun notifikasi WhatsApp gagal dikirim.',
      waResult,
    });
  } catch (err) {
    console.error('[notify] WA error:', err.message);
    // Still return 200 because DB save succeeded
    res.json({
      success:  true,
      waSent:   false,
      message:  'Pilihan berhasil disimpan, tetapi notifikasi WhatsApp gagal: ' + err.message,
    });
  }
});

module.exports = router;
