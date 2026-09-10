// Simulate node-postgres parsing of DATE column "2026-09-26"
// It parses it as midnight local time:
const d = new Date(2026, 8, 26, 0, 0, 0); // 2026-09-26 00:00:00 local time
console.log("Local time:", d.toString());
console.log("toISOString():", d.toISOString());
console.log("sliced:", d.toISOString().slice(0, 10));

// Wait, the DB returned 2026-09-25T17:00:00.000Z.
const dbDate = new Date("2026-09-25T17:00:00.000Z");
console.log("If DB Date is:", dbDate.toISOString());
console.log("sliced:", dbDate.toISOString().slice(0, 10));

// Correct way to get the local YYYY-MM-DD from a Date object parsed by node-postgres
// which represents midnight local time:
const yyyy = dbDate.getFullYear();
const mm = String(dbDate.getMonth() + 1).padStart(2, '0');
const dd = String(dbDate.getDate()).padStart(2, '0');
console.log("Correct local YYYY-MM-DD:", `${yyyy}-${mm}-${dd}`);

