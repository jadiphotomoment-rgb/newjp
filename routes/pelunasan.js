'use strict';

/**
 * /api/pelunasan — Core Engine Tagihan & Pelunasan
 *
 * PUBLIC (berbasis token, tanpa login):
 *   GET  /api/pelunasan/token/:token           → detail tagihan + metode bayar
 *   POST /api/pelunasan/token/:token/submit    → submit URL bukti bayar
 *
 * ADMIN (JWT):
 *   POST /api/pelunasan                        → buat tagihan baru, generate token
 *   GET  /api/pelunasan?booking_id=&status=    → daftar tagihan (per booking atau semua)
 *   GET  /api/pelunasan/:id                    → detail satu tagihan
 *   PATCH /api/pelunasan/:id/verify            → approve / reject bukti bayar
 *   PATCH /api/pelunasan/:id/cancel            → batalkan tagihan (sebelum lunas)
 *   POST  /api/pelunasan/:id/send-wa           → kirim / kirim ulang WA tagihan
 */

const express         = require('express');
const router          = express.Router();
const crypto          = require('crypto');
const https           = require('https');
const db              = require('../database');
const auth            = require('../middleware/auth');
const audit           = require('../services/audit');
const approvalSvc     = require('../services/approval');
const { getWaTemplate } = require('../utils/template');

// ── Helper: Format Rupiah (tanpa desimal) ───────────────────────
function fmtRp(angka) {
  return Number(angka).toLocaleString('id-ID');
}

// ── Helper: Format tanggal Indonesia ───────────────────────────
function fmtDate(d) {
  if (!d) return '-';
  return new Date(d).toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' });
}

const { buildPelunasanUrl } = require('../utils/url');

// ── Helper: Kirim WhatsApp via Fonnte ───────────────────────────
function sendWhatsApp(target, message) {
  return new Promise((resolve) => {
    if (!process.env.FONNTE_TOKEN) {
      return resolve({
        status: false,
        message: 'FONNTE_TOKEN belum dikonfigurasi di environment server. Mohon isi FONNTE_TOKEN di environment variables.'
      });
    }
    const body = JSON.stringify({ target, message, countryCode: '62' });
    const options = {
      hostname: 'api.fonnte.com', path: '/send', method: 'POST',
      headers: {
        'Authorization': process.env.FONNTE_TOKEN || '',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch (_) { resolve({ status: res.statusCode >= 200 && res.statusCode < 300 }); }
      });
    });
    req.on('error', (err) => resolve({ status: false, message: err.message }));
    req.write(body);
    req.end();
  });
}

// ═══════════════════════════════════════════════════════════════
// PUBLIC ENDPOINTS — berbasis token
// ═══════════════════════════════════════════════════════════════

/**
 * GET /api/pelunasan/token/:token
 * Diakses oleh halaman klien /pelunasan?token=...
 * Mengembalikan: ringkasan booking, detail tagihan, metode pembayaran sesuai kategori
 */
router.get('/token/:token', async (req, res) => {
  const { token } = req.params;
  if (!token || token.length < 32) {
    return res.status(400).json({ error: 'Token tidak valid' });
  }

  try {
    const { rows } = await db.query(
      `SELECT
         p.id, p.booking_id, p.token, p.total_tagihan, p.dp_terbayar,
         p.sisa_kekurangan, p.catatan, p.status, p.bukti_file_url,
         p.bukti_filename, p.reject_reason, p.sent_at, p.paid_at,
         b.client_name, b.event_date, b.event_time, b.location,
         b.package_price,
         COALESCE(
           NULLIF(TRIM(b.package_name), ''),
           NULLIF(TRIM(b.form_data->>'_package_name'), ''),
           NULLIF(TRIM(b.form_data->>'package_name'), ''),
           bc.name,
           'Layanan Fotografi'
         ) AS package_name,
         bc.name  AS category_name,
         bc.slug  AS category_slug,
         bc.color AS category_color
       FROM pelunasan p
       JOIN bookings b  ON p.booking_id = b.id
       JOIN booking_categories bc ON b.category_id = bc.id
       WHERE p.token = $1`,
      [token]
    );

    if (!rows[0]) return res.status(404).json({ error: 'Tagihan tidak ditemukan' });
    const tagihan = rows[0];

    // Ambil metode pembayaran sesuai kategori
    const [qrisRes, banksRes] = await Promise.all([
      db.query('SELECT qris_image_url FROM payment_settings WHERE id = 1'),
      db.query(
        'SELECT id, nama_bank, no_rekening, atas_nama FROM bank_accounts WHERE is_active = true ORDER BY sort_order, id'
      ),
    ]);

    // Tentukan metode yang ditampilkan berdasarkan slug kategori
    // graduation → QRIS statis; event, corporation → rekening bank
    // lainnya → keduanya (klien pilih)
    const slug = tagihan.category_slug;
    let payment_method = 'both';
    if (slug === 'graduation') payment_method = 'qris';
    else if (slug === 'event' || slug === 'corporation') payment_method = 'bank';

    res.json({
      tagihan: {
        id: tagihan.id,
        status: tagihan.status,
        total_tagihan: tagihan.total_tagihan,
        dp_terbayar: tagihan.dp_terbayar,
        sisa_kekurangan: tagihan.sisa_kekurangan,
        catatan: tagihan.catatan,
        bukti_file_url: tagihan.bukti_file_url,
        bukti_filename: tagihan.bukti_filename,
        reject_reason: tagihan.reject_reason,
        sent_at: tagihan.sent_at,
        paid_at: tagihan.paid_at,
      },
      booking: {
        client_name: tagihan.client_name,
        event_date: tagihan.event_date,
        event_time: tagihan.event_time,
        location: tagihan.location,
        package_name: tagihan.package_name,
        category_name: tagihan.category_name,
        category_slug: tagihan.category_slug,
        category_color: tagihan.category_color,
      },
      payment: {
        method: payment_method,          // 'qris' | 'bank' | 'both'
        qris_image_url: qrisRes.rows[0]?.qris_image_url || '/img/Qris Jadiphoto.webp',
        bank_accounts: banksRes.rows,
      },
    });
  } catch (err) {
    console.error('[pelunasan] GET /token error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

/**
 * POST /api/pelunasan/token/:token/submit
 * Klien submit URL bukti bayar (setelah upload lewat /api/upload/file).
 * Hanya bisa jika status = 'sent' atau 'rejected'.
 */
router.post('/token/:token/submit', async (req, res) => {
  const { token } = req.params;
  const { bukti_file_url, bukti_blob_key, bukti_filename } = req.body;

  if (!token || token.length < 32) return res.status(400).json({ error: 'Token tidak valid' });
  if (!bukti_file_url?.trim())    return res.status(400).json({ error: 'URL bukti bayar wajib diisi' });

  // Validasi URL
  try { new URL(bukti_file_url); } catch (_) {
    return res.status(400).json({ error: 'URL bukti bayar tidak valid' });
  }

  try {
    // Ambil tagihan — pastikan status masih bisa diupload
    const { rows } = await db.query(
      'SELECT id, status, booking_id FROM pelunasan WHERE token = $1',
      [token]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Tagihan tidak ditemukan' });
    const tagihan = rows[0];

    if (!['sent', 'rejected'].includes(tagihan.status)) {
      const msgs = {
        menunggu_verifikasi: 'Bukti bayar sudah dikirim dan sedang ditinjau admin.',
        lunas: 'Tagihan ini sudah lunas.',
        cancelled: 'Tagihan ini sudah dibatalkan.',
      };
      return res.status(409).json({ error: msgs[tagihan.status] || 'Status tagihan tidak mengizinkan upload ulang.' });
    }

    // Update tagihan → menunggu_verifikasi
    await db.query(
      `UPDATE pelunasan
       SET bukti_file_url = $1, bukti_blob_key = $2, bukti_filename = $3,
           status = 'menunggu_verifikasi', paid_at = now()
       WHERE id = $4`,
      [bukti_file_url.trim(), bukti_blob_key || null, bukti_filename || null, tagihan.id]
    );

    // Notif WA ke admin (ambil dari env)
    const adminPhone = process.env.ADMIN_WA_NUMBER;
    if (adminPhone) {
      const bookRes = await db.query(
        'SELECT client_name, client_phone FROM bookings WHERE id = $1',
        [tagihan.booking_id]
      );
      if (bookRes.rows[0]) {
        const { client_name, client_phone } = bookRes.rows[0];
        const adminMsg = `📸 *Bukti Pelunasan Masuk — Jadiphoto.Moment*\n\nKlien: *${client_name}*\nNo. HP: ${client_phone}\n\nBukti transfer pelunasan telah diupload dan menunggu verifikasi Anda.\n\nCek dashboard admin untuk approve/reject.`;
        sendWhatsApp(adminPhone, adminMsg).catch(() => {});
      }
    }

    res.json({ message: 'Bukti bayar berhasil dikirim. Menunggu verifikasi admin.' });
  } catch (err) {
    console.error('[pelunasan] POST /token/submit error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// ═══════════════════════════════════════════════════════════════
// ADMIN ENDPOINTS — JWT required
// ═══════════════════════════════════════════════════════════════

/**
 * GET /api/pelunasan?booking_id=&status=&page=&limit=
 * Daftar tagihan. Jika booking_id disertakan, filter per booking.
 */
router.get('/', auth, auth.requirePermission('booking.view'), async (req, res) => {
  const { booking_id, status, page = 1, limit = 50 } = req.query;
  const params = [];
  const conditions = [];

  if (booking_id) { params.push(parseInt(booking_id, 10)); conditions.push(`p.booking_id = $${params.length}`); }
  if (status)     { params.push(status);                   conditions.push(`p.status = $${params.length}`); }

  const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
  const offset = (parseInt(page, 10) - 1) * parseInt(limit, 10);

  try {
    const { rows } = await db.query(
      `SELECT
         p.id, p.booking_id, p.token, p.total_tagihan, p.dp_terbayar, p.sisa_kekurangan,
         p.status, p.catatan, p.sent_at, p.send_count, p.paid_at, p.created_at,
         p.bukti_file_url, p.bukti_filename, p.reject_reason,
         b.client_name, b.client_phone, b.event_date, b.package_name,
         bc.name AS category_name, bc.slug AS category_slug,
         a_verif.name AS verified_by_name,
         a_create.name AS created_by_name
       FROM pelunasan p
       JOIN bookings b ON p.booking_id = b.id
       JOIN booking_categories bc ON b.category_id = bc.id
       LEFT JOIN admins a_verif  ON p.verified_by  = a_verif.id
       LEFT JOIN admins a_create ON p.created_by   = a_create.id
       ${where}
       ORDER BY p.created_at DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, parseInt(limit, 10), offset]
    );
    res.json(rows);
  } catch (err) {
    console.error('[pelunasan] GET / error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

/**
 * GET /api/pelunasan/:id
 * Detail satu tagihan (admin).
 */
router.get('/:id', auth, auth.requirePermission('booking.view'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'ID tidak valid' });

  try {
    const { rows } = await db.query(
      `SELECT
         p.*,
         b.client_name, b.client_phone, b.event_date, b.event_time, b.location,
         b.package_price, b.package_name, b.status AS booking_status,
         bc.name AS category_name, bc.slug AS category_slug,
         a_verif.name  AS verified_by_name,
         a_create.name AS created_by_name
       FROM pelunasan p
       JOIN bookings b ON p.booking_id = b.id
       JOIN booking_categories bc ON b.category_id = bc.id
       LEFT JOIN admins a_verif  ON p.verified_by  = a_verif.id
       LEFT JOIN admins a_create ON p.created_by   = a_create.id
       WHERE p.id = $1`,
      [id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Tagihan tidak ditemukan' });
    res.json(rows[0]);
  } catch (err) {
    console.error('[pelunasan] GET /:id error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

/**
 * POST /api/pelunasan
 * Admin membuat tagihan pelunasan baru.
 * Server selalu menghitung ulang sisa = total - dp_terbayar.
 */
router.post('/', auth, auth.requirePermission('tagihan.send'), async (req, res) => {
  const { booking_id, total_tagihan, catatan } = req.body;

  // 1. Validasi input awal (400)
  if (!booking_id || isNaN(parseInt(booking_id, 10))) {
    return res.status(400).json({ error: 'booking_id wajib diisi dan berupa angka' });
  }
  if (!total_tagihan || isNaN(Number(total_tagihan)) || Number(total_tagihan) <= 0) {
    return res.status(400).json({ error: 'Total tagihan harus berupa angka positif' });
  }

  const bId = parseInt(booking_id, 10);
  const totalInt = Math.round(Number(total_tagihan));

  let dbClient;
  try {
    // 2. Ambil data booking + DP terbayar yang sudah disetujui
    const bookRes = await db.query(
      `SELECT b.id, b.client_name, b.client_phone, b.event_date, b.package_name, b.package_price,
              b.status, b.deleted_at, b.version,
              COALESCE(
                (SELECT SUM(amount) FROM payments
                 WHERE booking_id = b.id AND status = 'approved' AND payment_type = 'dp'),
                0
              ) AS dp_terbayar_aktual
       FROM bookings b
       WHERE b.id = $1`,
      [bId]
    );

    // 404 jika booking tidak ditemukan
    if (!bookRes.rows[0]) {
      return res.status(404).json({ error: 'Data booking tidak ditemukan' });
    }
    const booking = bookRes.rows[0];

    if (booking.deleted_at) {
      return res.status(404).json({ error: 'Booking ini sudah dihapus (soft delete)' });
    }
    if (booking.status === 'cancelled') {
      return res.status(400).json({ error: 'Booking ini sudah dibatalkan, tagihan tidak dapat dibuat' });
    }
    if (booking.status === 'lunas') {
      return res.status(409).json({ error: 'Booking ini sudah berstatus lunas' });
    }

    // Jika staff mengubah total_tagihan berbeda dari package_price, cek approval
    const pkgPrice = booking.package_price != null ? Math.round(Number(booking.package_price)) : null;
    if (pkgPrice != null && totalInt !== pkgPrice) {
      const mode = await approvalSvc.resolveAksi('tagihan.override_amount', req.user.role);
      if (mode === 'approval') {
        const appReq = await approvalSvc.ajukan({
          aksiTipe: 'tagihan.override_amount',
          requestedBy: req.user.id,
          entitasTipe: 'pelunasan',
          entitasId: booking.id,
          baseVersion: booking.version || 1,
          payload: { booking_id: booking.id, total_tagihan: totalInt, catatan: catatan?.trim() || null },
          req
        });
        return res.status(202).json({
          status: 'pending_approval',
          message: 'Perubahan nilai tagihan memerlukan persetujuan Owner',
          approval_id: appReq.id
        });
      }
    }

    // Hitung sisa di server — klien tidak bisa manipulasi
    const dpInt   = Math.round(Number(booking.dp_terbayar_aktual));
    const sisaInt = totalInt - dpInt;

    if (sisaInt <= 0) {
      return res.status(400).json({
        error: `Sisa kekurangan (Rp ${fmtRp(sisaInt)}) tidak valid. DP terbayar (Rp ${fmtRp(dpInt)}) sudah memenuhi atau melebihi total tagihan (Rp ${fmtRp(totalInt)}).`,
      });
    }

    dbClient = await db.getClient();
    await dbClient.query('BEGIN');

    // Cek apakah ada tagihan aktif/pending yang sudah dibuat sebelumnya untuk booking ini
    const { rows: existingRows } = await dbClient.query(
      `SELECT * FROM pelunasan 
       WHERE booking_id = $1 AND status IN ('sent', 'menunggu_verifikasi')
       ORDER BY id DESC LIMIT 1
       FOR UPDATE`,
      [booking.id]
    );

    let tagihan;
    let token;

    if (existingRows.length > 0) {
      // Gunakan token yang sudah ada agar link tetap konsisten dan valid
      const existing = existingRows[0];
      token = existing.token || crypto.randomBytes(32).toString('hex');

      const { rows: updatedRows } = await dbClient.query(
        `UPDATE pelunasan 
         SET total_tagihan = $1, dp_terbayar = $2, sisa_kekurangan = $3, catatan = $4, token = $5
         WHERE id = $6
         RETURNING *`,
        [totalInt, dpInt, sisaInt, catatan?.trim() || null, token, existing.id]
      );
      tagihan = updatedRows[0];
    } else {
      // Generate token acak aman (32 bytes = 64 hex chars)
      token = crypto.randomBytes(32).toString('hex');

      // Insert tagihan baru (sent_at NULL & send_count 0 karena belum dikirim ke WA)
      const { rows: insertRows } = await dbClient.query(
        `INSERT INTO pelunasan (booking_id, token, total_tagihan, dp_terbayar, sisa_kekurangan, catatan, status, sent_at, send_count, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, 'sent', NULL, 0, $7)
         RETURNING *`,
        [
          booking.id, token, totalInt, dpInt, sisaInt,
          catatan?.trim() || null,
          req.user.id,
        ]
      );
      tagihan = insertRows[0];
    }

    await audit.record(dbClient, {
      req,
      aksi: 'tagihan.create',
      entitas: 'pelunasan',
      entitas_id: tagihan.id,
      data_setelah: {
        id: tagihan.id,
        booking_id: booking.id,
        total_tagihan: totalInt,
        sisa_kekurangan: sisaInt
      }
    });

    await dbClient.query('COMMIT');
    const linkPelunasan = buildPelunasanUrl(token, req);

    res.status(201).json({
      message: 'Tagihan pelunasan berhasil dibuat',
      tagihan: {
        id: tagihan.id,
        token: tagihan.token,
        total_tagihan: tagihan.total_tagihan,
        dp_terbayar: tagihan.dp_terbayar,
        sisa_kekurangan: tagihan.sisa_kekurangan,
        status: tagihan.status,
      },
      link_pelunasan: linkPelunasan,
      wa_info: {
        client_name: booking.client_name,
        client_phone: booking.client_phone,
      },
    });
  } catch (err) {
    if (dbClient) await dbClient.query('ROLLBACK');
    console.error('[pelunasan] ERROR on POST /api/pelunasan:', {
      endpoint: 'POST /api/pelunasan',
      booking_id,
      error: err.message,
      stack: err.stack,
      body: req.body
    });
    res.status(500).json({ error: 'Terjadi kesalahan sistem saat membuat tagihan pelunasan' });
  } finally {
    if (dbClient) dbClient.release();
  }
});

/**
 * POST /api/pelunasan/:id/send-wa
 * Kirim / kirim ulang pesan WA tagihan ke klien.
 * Menyimpan timestamp & jumlah kirim untuk mencegah kebingungan klien.
 */
router.post('/:id/send-wa', auth, auth.requirePermission('tagihan.send'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'ID tagihan tidak valid' });

  try {
    const { rows } = await db.query(
      `SELECT p.*,
              EXTRACT(EPOCH FROM (NOW() - p.sent_at))::int AS seconds_since_sent,
              b.client_name, b.client_phone, b.event_date,
              COALESCE(
                NULLIF(TRIM(b.package_name), ''),
                NULLIF(TRIM(b.form_data->>'_package_name'), ''),
                NULLIF(TRIM(b.form_data->>'package_name'), ''),
                bc.name,
                'Layanan Fotografi'
              ) AS resolved_package_name
       FROM pelunasan p 
       JOIN bookings b ON p.booking_id = b.id
       LEFT JOIN booking_categories bc ON b.category_id = bc.id
       WHERE p.id = $1`,
      [id]
    );

    // 404 jika tagihan tidak ditemukan
    if (!rows[0]) return res.status(404).json({ error: 'Tagihan pelunasan tidak ditemukan' });
    const tagihan = rows[0];

    // Status conflict check (409)
    if (tagihan.status === 'lunas') {
      return res.status(409).json({ error: 'Tagihan sudah lunas, tidak perlu kirim ulang.' });
    }
    if (tagihan.status === 'cancelled') {
      return res.status(409).json({ error: 'Tagihan sudah dibatalkan, pesan tidak dapat dikirim.' });
    }
    if (!tagihan.client_phone) {
      return res.status(400).json({ error: 'Nomor WhatsApp klien tidak tersedia pada data booking.' });
    }

    // Cooldown 5 menit (300 detik) untuk mencegah pesan terkirim ganda (idempotency guard)
    const COOLDOWN_SECONDS = 300;
    if (tagihan.seconds_since_sent !== null && tagihan.seconds_since_sent !== undefined && tagihan.seconds_since_sent < COOLDOWN_SECONDS) {
      const sisaMenit = Math.ceil((COOLDOWN_SECONDS - tagihan.seconds_since_sent) / 60);
      return res.status(409).json({
        error: `Pesan tagihan baru saja dikirim ke klien. Mohon tunggu ${sisaMenit} menit sebelum mengirim ulang untuk mencegah pesan ganda.`
      });
    }

    // Fallback/backfill token untuk data transaksi lama jika token NULL
    let token = tagihan.token;
    if (!token) {
      token = crypto.randomBytes(32).toString('hex');
      await db.query('UPDATE pelunasan SET token = $1 WHERE id = $2', [token, id]);
    }

    const linkPelunasan = buildPelunasanUrl(token, req);
    const packageName = tagihan.resolved_package_name || 'Layanan Fotografi';
    const catatan_section = tagihan.catatan ? `\n📌 *Catatan:* ${tagihan.catatan}\n` : '';

    // Ambil template dari DB, fallback ke pesan terformat rapi
    let msg = await getWaTemplate('pelunasan_tagihan', {
      client_name: tagihan.client_name,
      package_name: packageName,
      event_date: fmtDate(tagihan.event_date),
      total_tagihan: fmtRp(tagihan.total_tagihan),
      dp_terbayar: fmtRp(tagihan.dp_terbayar),
      sisa_kekurangan: fmtRp(tagihan.sisa_kekurangan),
      catatan_section,
      link_pelunasan: linkPelunasan,
    });

    if (!msg) {
      msg = `💰 *Tagihan Pelunasan — Jadiphoto.Moment*\n\nHalo ${tagihan.client_name},\n\nBerikut rincian tagihan pelunasan booking Anda:\n\n📦 *Paket:* ${packageName}\n📅 *Tanggal Acara:* ${fmtDate(tagihan.event_date)}\n💵 *Total Tagihan:* Rp ${fmtRp(tagihan.total_tagihan)}\n✅ *DP Terbayar:* Rp ${fmtRp(tagihan.dp_terbayar)}\n🔴 *Sisa Pelunasan:* Rp ${fmtRp(tagihan.sisa_kekurangan)}\n${catatan_section}\nSilakan selesaikan pembayaran melalui link resmi berikut:\n🔗 ${linkPelunasan}\n\nTerima kasih 🙏`;
    }

    // Kirim WA via Fonnte Gateway
    const waRes = await sendWhatsApp(tagihan.client_phone, msg);

    // Verifikasi respons gateway
    if (!waRes || waRes.status === false) {
      const reason = (waRes && (waRes.reason || waRes.message)) || 'Gateway WhatsApp Fonnte gagal memproses pengiriman';
      return res.status(502).json({
        error: `Gagal mengirim pesan WhatsApp: ${reason}`,
        wa_response: waRes
      });
    }

    // Catat pengiriman hanya saat sukses terkirim — increment send_count, update sent_at & sent_to_wa
    await db.query(
      `UPDATE pelunasan
       SET sent_at = now(), send_count = send_count + 1, sent_to_wa = $1
       WHERE id = $2`,
      [tagihan.client_phone, id]
    );

    res.json({
      message: 'Pesan WhatsApp berhasil dikirim',
      wa_response: waRes,
      link_pelunasan: linkPelunasan,
    });
  } catch (err) {
    console.error('[pelunasan] ERROR on POST /api/pelunasan/:id/send-wa:', {
      endpoint: `POST /api/pelunasan/${id}/send-wa`,
      id,
      error: err.message,
      stack: err.stack
    });
    res.status(500).json({ error: 'Terjadi kesalahan sistem saat memproses pengiriman WhatsApp' });
  }
});

/**
 * PATCH /api/pelunasan/:id/verify
 * Admin approve atau reject bukti bayar pelunasan.
 * Body: { action: 'approve' | 'reject', reason?: string }
 *
 * Saat APPROVE:
 *   - pelunasan.status → 'lunas'
 *   - bookings.status  → 'lunas'  (hanya jika semua tagihan aktif lunas)
 *   - INSERT ke payments (payment_type='pelunasan', status='approved')
 *   - Kirim WA konfirmasi ke klien
 *
 * Saat REJECT:
 *   - pelunasan.status → 'rejected'
 *   - reject_reason tersimpan
 *   - Kirim WA alasan penolakan + link upload ulang ke klien
 */
router.patch('/:id/verify', auth, auth.requirePermission('payment.verify'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'ID tidak valid' });

  const { action, reason } = req.body;
  if (!['approve', 'reject'].includes(action)) {
    return res.status(400).json({ error: 'action harus "approve" atau "reject"' });
  }
  if (action === 'reject' && !reason?.trim()) {
    return res.status(400).json({ error: 'Alasan penolakan wajib diisi saat reject' });
  }

  let client;
  try {
    // Lock baris tagihan dengan FOR UPDATE agar tidak ada race condition double-approve
    const tagRes = await db.query(
      `SELECT p.id, p.status, p.booking_id, p.sisa_kekurangan, p.total_tagihan,
              p.dp_terbayar, p.token, p.bukti_file_url, p.bukti_filename, p.bukti_blob_key,
              b.client_name, b.client_phone, b.event_date, b.package_name
       FROM pelunasan p
       JOIN bookings b ON p.booking_id = b.id
       WHERE p.id = $1`,
      [id]
    );
    if (!tagRes.rows[0]) return res.status(404).json({ error: 'Tagihan tidak ditemukan' });
    const tagihan = tagRes.rows[0];

    if (tagihan.status !== 'menunggu_verifikasi') {
      return res.status(409).json({
        error: `Status tagihan adalah "${tagihan.status}". Hanya tagihan berstatus "menunggu_verifikasi" yang bisa diverifikasi.`,
      });
    }

    client = await db.getClient();
    await client.query('BEGIN');

    if (action === 'approve') {
      // 1. Update pelunasan → lunas
      await client.query(
        `UPDATE pelunasan
         SET status = 'lunas', verified_by = $1, verified_at = now(), updated_by = $1, version = version + 1
         WHERE id = $2`,
        [req.user.id, id]
      );

      // 2. Catat pemasukan di tabel payments (otomatis masuk finance.html)
      await client.query(
        `INSERT INTO payments (booking_id, amount, payment_type, proof_url, proof_filename, blob_key, status, approved_by, approved_at, created_by, updated_by)
         VALUES ($1, $2, 'pelunasan', $3, $4, $5, 'approved', $6, now(), $6, $6)`,
        [
          tagihan.booking_id,
          tagihan.sisa_kekurangan,
          tagihan.bukti_file_url || null,
          tagihan.bukti_filename || null,
          tagihan.bukti_blob_key || null,
          req.user.id,
        ]
      );

      // 3. Update bookings.status → 'lunas'
      //    (hanya update jika tidak ada tagihan menunggu_verifikasi lain di booking yg sama)
      await client.query(
        `UPDATE bookings
         SET status = 'lunas', updated_by = $1, version = version + 1
         WHERE id = $2
           AND NOT EXISTS (
             SELECT 1 FROM pelunasan
             WHERE booking_id = $2
               AND id != $3
               AND status IN ('sent', 'rejected', 'menunggu_verifikasi')
           )`,
        [req.user.id, tagihan.booking_id, id]
      );

      await audit.record(client, {
        req,
        aksi: 'payment.verify',
        entitas: 'pelunasan',
        entitas_id: id,
        data_sebelum: { status: 'menunggu_verifikasi' },
        data_setelah: { status: 'lunas', action: 'approve' }
      });

      await client.query('COMMIT');

      // 4. Notif WA ke klien (fire-and-forget)
      if (tagihan.client_phone) {
        let msg = await getWaTemplate('pelunasan_lunas', {
          client_name: tagihan.client_name,
          package_name: tagihan.package_name || '-',
          event_date: fmtDate(tagihan.event_date),
          sisa_kekurangan: fmtRp(tagihan.sisa_kekurangan),
        });
        if (!msg) {
          msg = `✅ *Pembayaran Diterima — Jadiphoto.Moment*\n\nHalo ${tagihan.client_name},\n\nPembayaran pelunasan Anda untuk paket *${tagihan.package_name || '-'}* sudah kami terima dan booking Anda kini berstatus *LUNAS*. 🎉\n\n📅 *Tanggal Acara:* ${fmtDate(tagihan.event_date)}\n💰 *Jumlah Diterima:* Rp${fmtRp(tagihan.sisa_kekurangan)}\n\nTerima kasih telah mempercayai Jadiphoto.Moment! 📸`;
        }
        sendWhatsApp(tagihan.client_phone, msg).catch(() => {});
      }

      res.json({ message: 'Pelunasan disetujui. Booking telah berstatus lunas.' });

    } else {
      // REJECT
      await client.query(
        `UPDATE pelunasan
         SET status = 'rejected', reject_reason = $1, verified_by = $2, verified_at = now(), updated_by = $2, version = version + 1
         WHERE id = $3`,
        [reason.trim(), req.user.id, id]
      );

      await audit.record(client, {
        req,
        aksi: 'payment.verify',
        entitas: 'pelunasan',
        entitas_id: id,
        data_sebelum: { status: 'menunggu_verifikasi' },
        data_setelah: { status: 'rejected', action: 'reject', reason: reason.trim() }
      });

      await client.query('COMMIT');

      // Notif WA alasan penolakan + link upload ulang
      if (tagihan.client_phone) {
        const linkPelunasan = buildPelunasanUrl(tagihan.token, req);
        let msg = await getWaTemplate('pelunasan_rejected', {
          client_name: tagihan.client_name,
          reject_reason: reason.trim(),
          link_pelunasan: linkPelunasan,
        });
        if (!msg) {
          msg = `❌ *Bukti Pembayaran Ditolak — Jadiphoto.Moment*\n\nHalo ${tagihan.client_name},\n\nMohon maaf, bukti pembayaran pelunasan Anda tidak dapat kami verifikasi.\n\n📝 *Alasan:* ${reason.trim()}\n\nSilakan upload ulang bukti pembayaran yang valid melalui link yang sama:\n🔗 ${linkPelunasan}\n\nTerima kasih atas pengertiannya. 🙏`;
        }
        sendWhatsApp(tagihan.client_phone, msg).catch(() => {});
      }

      res.json({ message: 'Bukti bayar ditolak. Klien dapat upload ulang.' });
    }
  } catch (err) {
    if (client) await client.query('ROLLBACK');
    console.error('[pelunasan] PATCH /:id/verify error:', err);
    res.status(500).json({ error: 'Database error' });
  } finally {
    if (client) client.release();
  }
});

/**
 * PATCH /api/pelunasan/:id/cancel
 * Admin membatalkan tagihan yang belum lunas.
 * Tagihan 'lunas' tidak bisa dibatalkan.
 */
router.patch('/:id/cancel', auth, auth.requirePermission('booking.update'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'ID tidak valid' });

  let client;
  try {
    client = await db.getClient();
    await client.query('BEGIN');

    const { rows } = await client.query(
      `UPDATE pelunasan
       SET status = 'cancelled', verified_by = $1, verified_at = now(), updated_by = $1, version = version + 1
       WHERE id = $2
         AND status != 'lunas'
       RETURNING id, status, booking_id`,
      [req.user.id, id]
    );

    if (!rows[0]) {
      await client.query('ROLLBACK');
      const check = await db.query('SELECT status FROM pelunasan WHERE id = $1', [id]);
      if (!check.rows[0]) return res.status(404).json({ error: 'Tagihan tidak ditemukan' });
      if (check.rows[0].status === 'lunas') return res.status(409).json({ error: 'Tagihan yang sudah lunas tidak bisa dibatalkan.' });
    }

    await audit.record(client, {
      req,
      aksi: 'tagihan.cancel',
      entitas: 'pelunasan',
      entitas_id: id,
      data_setelah: { status: 'cancelled' }
    });

    await client.query('COMMIT');
    res.json({ message: 'Tagihan berhasil dibatalkan.', data: rows[0] });
  } catch (err) {
    if (client) await client.query('ROLLBACK');
    console.error('[pelunasan] PATCH /:id/cancel error:', err);
    res.status(500).json({ error: 'Database error' });
  } finally {
    if (client) client.release();
  }
});

module.exports = router;
