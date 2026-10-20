# MAP SISTEM: Fitur Staff Approve Booking Langsung

## 1. Rute Terkait Approval & WhatsApp
- Eksisting: `PATCH /api/admin/bookings/:id/approve-dp` & `reject-dp` (`routes/bookings.js:690, 795`)
- Eksisting: `PATCH /api/finance/payments/:id/approve` & `reject` (`routes/finance.js:162, 260`)
- Rute Baru (Fase 3): `POST /api/bookings/:id/approve` & `POST /api/bookings/:id/reject`
- Endpoint Me: `GET /api/auth/me` (`routes/auth.js:400`) mengembalikan user & permissions
- WhatsApp Sender: `sendWhatsApp()` (`routes/notify.js:10`, Fonnte API via https://api.fonnte.com/send)

## 2. Autentikasi & Otorisasi
- Middleware: `middleware/auth.js` (`authenticate`, `requirePermission`)
- Peta Role & Perms: `constants/permissions.js` (`ROLE_PERMISSIONS`, `hasPermission`, `getPermissionsForRole`)
- Roles: `owner` (semua permission implisit), `staff` (memiliki `booking.approve` default)
- Permission Baru: `booking.approve` (approve/reject DP), `booking.approve_without_dp` (khusus owner)

## 3. Tabel & Kolom Database Terverifikasi
- `bookings`: id (int PK), client_name (varchar), client_phone (varchar), event_date (date), event_time (time), category_id (int), location (text), form_data (jsonb), package_price (numeric 12,2), dp_amount (numeric 12,2), dp_deadline (timestamp), status (varchar), created_by (int), updated_by (int), version (int default 1)
  - Status Booking: `pending_dp`, `dp_review`, `confirmed`, `dp_rejected`, `lunas`, `cancelled`
- `payments`: id (int PK), booking_id (int FK), amount (numeric 12,2), payment_type (varchar 'dp'), proof_url (text), proof_filename (text), status (varchar), approved_by (int), approved_at (timestamptz), reject_reason (text), created_by (int), updated_by (int), version (int default 1)
  - Status Payment: `pending`, `approved`, `rejected`
- `audit_log`: id (bigserial PK), actor_id (int), actor_role (varchar), aksi (varchar), entitas (varchar), entitas_id (bigint), sebelum (jsonb), sesudah (jsonb), approval_id (bigint), ip (inet), request_id (varchar), created_at (timestamptz)
- `approval_rules` & `approval_requests`: sistem approval berjenjang lama (wajib dilarang untuk `booking.approve`)
- `financial_entries` (Tabel Baru Fase 1): id (bigserial PK), tipe (varchar 'masuk'/'keluar'), kategori (varchar), nominal (numeric 12,0), sumber_tipe (varchar), sumber_id (bigint), status (varchar 'aktif'/'batal'), created_by (int), created_at (timestamptz). Index unik: `(sumber_tipe, sumber_id)` WHERE status = 'aktif'
- `wa_outbox` (Tabel Baru Fase 1): id (bigserial PK), phone (varchar), message (text), status (varchar 'pending'/'sent'/'failed'), retries (int), last_error (text), created_at (timestamptz), sent_at (timestamptz)

## 4. Frontend & Integrasi UI
- File: `public/admin/bookings.html` (`approveDP(id, fromPanel)`, `rejectDP(id, fromPanel)`, `#detail-panel`)
- Modal & Konfirmasi: Dialog konfirmasi, anti double-submit (disabled saat proses), optimistic reload via `version`
