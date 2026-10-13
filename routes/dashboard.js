'use strict';

/**
 * routes/dashboard.js
 * Endpoint Analitik & Dashboard (Fase 5: Sumber Informasi & Marketing Analytics)
 */

const express = require('express');
const router  = express.Router();
const db      = require('../database');
const auth    = require('../middleware/auth');

const SOURCE_META = {
  instagram:       { label: 'Instagram',                  color: '#e1306c', bg: 'rgba(225, 48, 108, 0.15)' },
  tiktok:          { label: 'TikTok',                     color: '#00f2fe', bg: 'rgba(0, 242, 254, 0.15)' },
  google:          { label: 'Google Search',              color: '#4285f4', bg: 'rgba(66, 133, 244, 0.15)' },
  referral:        { label: 'Rekomendasi Teman/Keluarga', color: '#10b981', bg: 'rgba(16, 185, 129, 0.15)' },
  event:           { label: 'Event / Pameran',            color: '#f59e0b', bg: 'rgba(245, 158, 11, 0.15)' },
  lainnya:         { label: 'Lainnya',                    color: '#8b5cf6', bg: 'rgba(139, 92, 246, 0.15)' },
  tidak_diketahui: { label: 'Tidak Diketahui',            color: '#6b7280', bg: 'rgba(107, 114, 128, 0.15)' }
};

// ── GET /api/dashboard/sumber-informasi ──────────────────────────
router.get('/sumber-informasi', auth, async (req, res) => {
  const { category, start_date, end_date, period } = req.query;

  const conditions = ['b.deleted_at IS NULL'];
  const params = [];

  // Filter Kategori
  if (category && category !== 'all' && category !== '') {
    params.push(category);
    conditions.push(`bc.slug = $${params.length}`);
  }

  // Filter Rentang Tanggal / Period
  if (start_date && end_date) {
    params.push(start_date);
    conditions.push(`b.event_date >= $${params.length}`);
    params.push(end_date);
    conditions.push(`b.event_date <= $${params.length}`);
  } else if (period === 'this_month') {
    conditions.push(`b.event_date >= date_trunc('month', CURRENT_DATE) AND b.event_date < (date_trunc('month', CURRENT_DATE) + INTERVAL '1 month')`);
  } else if (period === 'last_3_months') {
    conditions.push(`b.event_date >= (CURRENT_DATE - INTERVAL '3 months')`);
  } else if (period === 'this_year') {
    conditions.push(`b.event_date >= date_trunc('year', CURRENT_DATE)`);
  }

  const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

  try {
    const sumberExpr = `
      COALESCE(
        NULLIF(TRIM(LOWER(b.sumber_informasi)), ''),
        CASE
          WHEN LOWER(COALESCE(b.form_data->>'source', b.form_data->>'infokontak', '')) LIKE '%instagram%' THEN 'instagram'
          WHEN LOWER(COALESCE(b.form_data->>'source', b.form_data->>'infokontak', '')) LIKE '%tiktok%' THEN 'tiktok'
          WHEN LOWER(COALESCE(b.form_data->>'source', b.form_data->>'infokontak', '')) LIKE '%google%' THEN 'google'
          WHEN LOWER(COALESCE(b.form_data->>'source', b.form_data->>'infokontak', '')) LIKE '%teman%' 
            OR LOWER(COALESCE(b.form_data->>'source', b.form_data->>'infokontak', '')) LIKE '%keluarga%' 
            OR LOWER(COALESCE(b.form_data->>'source', b.form_data->>'infokontak', '')) LIKE '%rekomendasi%' 
            OR LOWER(COALESCE(b.form_data->>'source', b.form_data->>'infokontak', '')) LIKE '%referral%' THEN 'referral'
          WHEN LOWER(COALESCE(b.form_data->>'source', b.form_data->>'infokontak', '')) LIKE '%event%' 
            OR LOWER(COALESCE(b.form_data->>'source', b.form_data->>'infokontak', '')) LIKE '%pameran%' THEN 'event'
          WHEN NULLIF(TRIM(COALESCE(b.form_data->>'source', b.form_data->>'infokontak', '')), '') IS NOT NULL THEN 'lainnya'
          ELSE 'tidak_diketahui'
        END
      )
    `;

    const detailExpr = `
      COALESCE(
        NULLIF(TRIM(b.sumber_informasi_detail), ''),
        NULLIF(TRIM(COALESCE(b.form_data->>'infokontak', b.form_data->>'source_detail', '')), '')
      )
    `;

    // 1. Distribusi per Sumber Informasi
    const distQuery = `
      SELECT 
        ${sumberExpr} AS sumber,
        COUNT(*)::int AS count,
        COALESCE(SUM(b.package_price), 0)::numeric AS total_revenue,
        COALESCE(AVG(b.package_price), 0)::numeric AS avg_revenue,
        COUNT(CASE WHEN b.status IN ('lunas', 'completed') THEN 1 END)::int AS lunas_count,
        COUNT(CASE WHEN b.status = 'cancelled' THEN 1 END)::int AS cancelled_count
      FROM bookings b
      JOIN booking_categories bc ON b.category_id = bc.id
      ${whereClause}
      GROUP BY ${sumberExpr}
      ORDER BY count DESC
    `;
    const distRes = await db.query(distQuery, params);

    const totalBookings = distRes.rows.reduce((sum, r) => sum + r.count, 0);
    const totalRevenue = distRes.rows.reduce((sum, r) => sum + Number(r.total_revenue || 0), 0);
    const totalLunas = distRes.rows.reduce((sum, r) => sum + r.lunas_count, 0);

    const distribution = distRes.rows.map(r => {
      const key = r.sumber in SOURCE_META ? r.sumber : 'lainnya';
      const meta = SOURCE_META[key] || SOURCE_META.tidak_diketahui;
      const count = r.count;
      const percentage = totalBookings > 0 ? Number(((count / totalBookings) * 100).toFixed(1)) : 0;
      const totalRev = Number(r.total_revenue || 0);
      const avgRev = count > 0 ? Math.round(totalRev / count) : 0;
      const convRate = count > 0 ? Number(((r.lunas_count / count) * 100).toFixed(1)) : 0;

      return {
        key: r.sumber,
        label: meta.label,
        color: meta.color,
        bg: meta.bg,
        count: count,
        percentage: percentage,
        total_revenue: totalRev,
        avg_revenue: avgRev,
        lunas_count: r.lunas_count,
        cancelled_count: r.cancelled_count,
        conversion_rate: convRate
      };
    });

    // 2. Tren Bulanan 6 Bulan Terakhir
    const trendQuery = `
      SELECT 
        to_char(b.event_date, 'YYYY-MM') AS month_str,
        ${sumberExpr} AS sumber,
        COUNT(*)::int AS count
      FROM bookings b
      JOIN booking_categories bc ON b.category_id = bc.id
      WHERE b.deleted_at IS NULL 
        AND b.event_date >= (CURRENT_DATE - INTERVAL '6 months')
      GROUP BY to_char(b.event_date, 'YYYY-MM'), ${sumberExpr}
      ORDER BY month_str ASC
    `;
    const trendRes = await db.query(trendQuery);

    // Format struktur data tren bulanan agar siap dikonsumsi Chart.js
    const monthMap = {};
    trendRes.rows.forEach(r => {
      if (!r.month_str) return;
      if (!monthMap[r.month_str]) {
        monthMap[r.month_str] = {
          month: r.month_str,
          total: 0,
          breakdown: {}
        };
      }
      monthMap[r.month_str].breakdown[r.sumber] = r.count;
      monthMap[r.month_str].total += r.count;
    });

    const monthlyTrend = Object.values(monthMap).sort((a, b) => a.month.localeCompare(b.month));

    // 3. Catatan Detail / Rekomendasi Terbaru
    const refQuery = `
      SELECT 
        b.id, b.client_name, 
        ${sumberExpr} AS sumber_informasi, 
        ${detailExpr} AS sumber_informasi_detail,
        b.event_date, b.package_price, b.status, bc.name AS category_name
      FROM bookings b
      JOIN booking_categories bc ON b.category_id = bc.id
      WHERE b.deleted_at IS NULL 
        AND ${detailExpr} IS NOT NULL 
        AND TRIM(${detailExpr}) <> ''
      ORDER BY b.created_at DESC
      LIMIT 12
    `;
    const refRes = await db.query(refQuery);

    // 4. Hitung Top Insights
    const topByCount = distribution.length > 0 ? distribution[0] : null;
    const topByRev = distribution.length > 0
      ? [...distribution].sort((a, b) => b.total_revenue - a.total_revenue)[0]
      : null;

    const canViewRevenue = req.user?.role === 'owner';

    let finalSummary = {
      total_bookings: totalBookings,
      total_revenue: totalRevenue,
      total_lunas: totalLunas,
      overall_conversion_rate: totalBookings > 0 ? Number(((totalLunas / totalBookings) * 100).toFixed(1)) : 0,
      top_source: topByCount ? topByCount.label : 'Belum Ada',
      top_source_count: topByCount ? topByCount.count : 0,
      top_revenue_source: topByRev ? topByRev.label : 'Belum Ada',
      top_revenue_amount: topByRev ? topByRev.total_revenue : 0
    };

    let finalDistribution = distribution;
    let finalReferrals = refRes.rows;

    // Per-role serializer: Staff dilarang melihat angka omset/pendapatan
    if (!canViewRevenue) {
      const { total_revenue, top_revenue_source, top_revenue_amount, ...staffSummary } = finalSummary;
      finalSummary = staffSummary;

      finalDistribution = distribution.map(d => {
        const { total_revenue, avg_revenue, ...staffD } = d;
        return staffD;
      });

      finalReferrals = refRes.rows.map(r => {
        const { package_price, ...staffR } = r;
        return staffR;
      });
    }

    res.json({
      summary: finalSummary,
      distribution: finalDistribution,
      monthly_trend: monthlyTrend,
      recent_referrals: finalReferrals
    });
  } catch (err) {
    console.error('[dashboard] sumber-informasi error:', err);
    res.status(500).json({ error: 'Gagal mengambil data analitik sumber informasi' });
  }
});

module.exports = router;
