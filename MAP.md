# MAP SISTEM: Akun Staff, RBAC & Approval Tracking

## 1. Peta Route Express & File:Baris
| Endpoint Prefix / Path | File & Baris | Auth Saat Ini | Scope / Target RBAC |
|---|---|---|---|
| `/api/auth/login, /verify, /change-password` | `routes/auth.js:14-52` | Sebagian `auth` | Publik / Authenticated |
| `/api/dashboard/sumber-informasi` | `routes/dashboard.js:24` | `auth` | `dashboard.view` (filter agregat uang) |
| `/api/finance/summary` | `routes/finance.js:37` | `auth` | `finance.*` (Owner Only, 403 staff) |
| `/api/finance/payments` | `routes/finance.js:116` | `auth` | `finance.*` (Owner Only, 403 staff) |
| `/api/finance/payments/:id/approve, reject` | `routes/finance.js:157, 255` | `auth` | `payment.verify` / `finance.*` |
| `/api/finance/export` | `routes/finance.js:294` | `auth` | `finance.*` (Owner Only, 403 staff) |
| `/api/finance/payments/:id (DELETE)` | `routes/finance.js:326` | `auth` | `finance.*` (Owner Only, 403 staff) |
| `/api/bookings/admin/list`, `/api/bookings/` | `routes/bookings.js:447-448` | `auth` | `booking.view` |
| `/api/bookings/admin/detail/:id` | `routes/bookings.js:499` | `auth` | `booking.view` |
| `/api/bookings/admin/:id/set-price` | `routes/bookings.js:502` | `auth` | `booking.update` / `approval` |
| `/api/bookings/admin/:id (PUT)` | `routes/bookings.js:642-643` | `auth` | `booking.update` |
| `/api/bookings/admin/:id/approve-dp, reject-dp` | `routes/bookings.js:646, 742` | `auth` | `payment.verify` |
| `/api/bookings/admin/:id/send-wa-confirmation` | `routes/bookings.js:798` | `auth` | `tagihan.send` |
| `/api/bookings/admin/:id/status` | `routes/bookings.js:841` | `auth` | `booking.update` |
| `/api/bookings/admin/:id (DELETE)` | `routes/bookings.js:882-883` | `auth` | `booking.delete` (sensitif -> approval) |
| `/api/bookings/admin/create` | `routes/bookings.js:927-928` | `auth` | `booking.create` |
| `/api/bookings/admin/calendar` | `routes/bookings.js:946` | `auth` | `booking.view` |
| `/api/pelunasan/` (GET, POST) | `routes/pelunasan.js:233, 309` | `auth` | `booking.view`, `tagihan.send` |
| `/api/pelunasan/:id` (GET) | `routes/pelunasan.js:275` | `auth` | `booking.view` |
| `/api/pelunasan/:id/send-wa` | `routes/pelunasan.js:394` | `auth` | `tagihan.send` |
| `/api/pelunasan/:id/verify` | `routes/pelunasan.js:475` | `auth` | `payment.verify` |
| `/api/pelunasan/:id/cancel` | `routes/pelunasan.js:606` | `auth` | `booking.update` / approval |
| `/api/admin/categories` | `routes/categories.js:9-153` | `auth` | `category.manage` |
| `/api/wa-templates` | `routes/wa-templates.js:9-67` | `auth` | `wa_template.manage` |
| `/api/settings/payment/admin, banks, qris` | `routes/payment-settings.js:51-196`| `auth` | `payment_settings.manage` (Owner Only) |
| `/api/settings/payment/ (GET)` | `routes/payment-settings.js:28` | None (publik) | Publik (checkout/pelunasan klien) |
| `/api/sessions` (CRUD) | `routes/sessions.js:72-525` | `auth` | Staf & Owner |
| `/api/shortlinks` | `routes/shortlinks.js:19-184` | `auth` | Staf & Owner |
| `/api/google/auth, disconnect, status` | `routes/google.js:19, 102, 116`| `auth` | Owner Only |

## 2. Tabel & Skema Eksisting vs Migrasi Baru
- **Tabel Eksisting (`database.js:29-350`)**: `admins`, `sessions`, `selections`, `bookings`, `payments`, `pelunasan`, `payment_settings`, `bank_accounts`, `booking_categories`, `wa_templates`, `attachments`, `shortlinks`, `shortlink_clicks`.
- **Tabel Baru (Fase 1)**: `users`, `refresh_tokens`, `audit_log`, `approval_rules`, `approval_requests`.
- **Kolom Tambahan (Fase 1)**: `bookings` (created_by, updated_by, version), `pelunasan` (created_by, updated_by, version), `payments` (created_by, updated_by, version).

## 3. Middleware & Auth Eksisting
- `middleware/auth.js:9-35`: verifikasi Bearer JWT / query token sederhana via `process.env.JWT_SECRET`, pasang `req.admin`.
- Belum ada RBAC granular, token versioning, refresh token rotation, atau lockout.

## 4. Daftar Endpoint Keuangan & Angka Agregat Uang
- `/api/finance/summary` (`totalIncome`, `pendingAmount`, `thisMonthIncome`, `byCategory.income`, `byMonth.income`) -> **Owner Only**
- `/api/finance/payments` (daftar seluruh mutasi nominal masuk) -> **Owner Only**
- `/api/finance/export` (ekspor CSV/Excel seluruh data keuangan) -> **Owner Only**
- `/api/finance/payments/:id` (approve/reject/delete via finance module) -> **Owner Only**
- `/api/dashboard/sumber-informasi` (`summary.total_revenue`, `summary.top_revenue_amount`, `distribution[].total_revenue`, `distribution[].avg_revenue`) -> **Diserialisasi / disembunyikan untuk Staf**

## 5. Halaman Frontend Admin & Integrasi WA
- **Halaman Admin (`public/admin/`)**: `login.html`, `dashboard.html`, `bookings.html`, `finance.html`, `categories.html`, `sessions.html`, `shortlinks.html`, `wa-templates.html`.
- **Halaman Baru**: `users.html`, `approvals.html`, `activity.html`, `monitoring.html`.
- **Pemanggil WA Gateway (Fonnte API)**: `routes/notify.js:15`, `routes/bookings.js:26, 798`, `routes/pelunasan.js:51, 394`, `routes/finance.js:15`, `routes/sessions.js:19`, `cron/booking_cleaner.js:12`. Efek samping WA approval hanya dipicu *after-commit*.
