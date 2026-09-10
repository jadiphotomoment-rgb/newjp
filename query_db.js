const db = require('./database');
async function run() {
  const { rows } = await db.query('SELECT id, event_date, event_time, client_name, google_event_id, calendar_sync_status FROM bookings ORDER BY id DESC LIMIT 5');
  console.log(rows);
  process.exit(0);
}
run();
