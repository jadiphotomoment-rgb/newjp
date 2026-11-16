'use strict';

const assert = require('assert');

// Mock database module via require.cache
const mockDb = {
  lastQuery: '',
  lastParams: [],
  query: async (sql, params = []) => {
    mockDb.lastQuery = sql;
    mockDb.lastParams = params;
    return {
      rows: [
        { id: 1, client_name: 'Client A', event_date: '2026-11-20', event_time: '10:00:00' },
        { id: 2, client_name: 'Client B', event_date: '2026-11-20', event_time: '14:00:00' }
      ]
    };
  }
};

require.cache[require.resolve('../database')] = {
  exports: mockDb
};

const mockAuth = (req, res, next) => next();
mockAuth.requirePermission = () => (req, res, next) => next();
mockAuth.requireRole = () => (req, res, next) => next();

require.cache[require.resolve('../middleware/auth')] = {
  exports: mockAuth
};

const bookingsRouter = require('../routes/bookings');

// Helper to find handleAdminList from router stack
const adminListLayer = bookingsRouter.stack.find(layer => layer.route && layer.route.path === '/admin/list');
const handleAdminList = adminListLayer.route.stack[adminListLayer.route.stack.length - 1].handle;

function mockReqRes(query = {}) {
  const req = { query, admin: { id: 1, role: 'owner' } };
  const headers = {};
  const res = {
    statusCode: 200,
    headers,
    status(code) {
      this.statusCode = code;
      return this;
    },
    set(k, v) {
      headers[k.toLowerCase()] = v;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    }
  };
  return { req, res };
}

async function runTests() {
  console.log('Testing T1 Backend Date Filter (In-Memory)...');

  // 1. Validation tests (400 Bad Request)
  {
    const { req, res } = mockReqRes({ date: 'invalid-date' });
    await handleAdminList(req, res);
    assert.strictEqual(res.statusCode, 400, 'Invalid date should return 400');
    assert(res.body.error.includes('Format tanggal'), 'Error format date');
    console.log('  ✓ 400 on invalid date format');
  }

  {
    const { req, res } = mockReqRes({ from: '2026-11-25', to: '2026-11-20' });
    await handleAdminList(req, res);
    assert.strictEqual(res.statusCode, 400, 'from > to should return 400');
    assert(res.body.error.includes('from harus <= to'), 'Error from <= to');
    console.log('  ✓ 400 on from > to');
  }

  {
    const { req, res } = mockReqRes({ from: '2025-01-01', to: '2026-02-01' });
    await handleAdminList(req, res);
    assert.strictEqual(res.statusCode, 400, 'Range > 366 days should return 400');
    assert(res.body.error.includes('366 hari'), 'Error max 366 days');
    console.log('  ✓ 400 on range > 366 days');
  }

  // 2. Filter date (single date)
  {
    const { req, res } = mockReqRes({ date: '2026-11-20' });
    await handleAdminList(req, res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(typeof res.body.total, 'number', 'Response has total');
    assert.strictEqual(res.body.total, 2, 'Total matches row count');
    assert(Array.isArray(res.body.data), 'Response data is array');
    assert(mockDb.lastQuery.includes('b.event_date = $'), 'Query includes event_date = $');
    assert(mockDb.lastQuery.includes('ORDER BY b.event_date ASC, b.event_time ASC NULLS LAST'), 'Query orders by event_date ASC, event_time ASC NULLS LAST');
    assert.strictEqual(res.headers['x-total-count'], '2', 'X-Total-Count header is present');
    console.log('  ✓ Single date filter returns { data, total }, proper SQL & order');
  }

  // 3. Filter range from & to
  {
    const { req, res } = mockReqRes({ from: '2026-11-01', to: '2026-11-30' });
    await handleAdminList(req, res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.total, 2);
    assert(mockDb.lastQuery.includes('b.event_date >= $'), 'Query includes from');
    assert(mockDb.lastQuery.includes('b.event_date <= $'), 'Query includes to');
    assert(mockDb.lastQuery.includes('ORDER BY b.event_date ASC, b.event_time ASC NULLS LAST'), 'Query orders by event_date & time');
    console.log('  ✓ Date range filter returns { data, total } & inclusive SQL');
  }

  // 4. Legacy behavior (without date params)
  {
    const { req, res } = mockReqRes({});
    await handleAdminList(req, res);
    assert.strictEqual(res.statusCode, 200);
    assert(Array.isArray(res.body), 'Legacy call returns raw array without object wrapper');
    assert.strictEqual(res.body.length, 2);
    assert(mockDb.lastQuery.includes('ORDER BY b.created_at DESC'), 'Legacy query orders by created_at DESC');
    console.log('  ✓ Legacy call without date params returns array ordered by created_at DESC');
  }

  // 5. Combination of date + status + category + location
  {
    const { req, res } = mockReqRes({ date: '2026-11-20', status: 'confirmed', category: 'wedding', location: 'Solo' });
    await handleAdminList(req, res);
    assert.strictEqual(res.statusCode, 200);
    assert(mockDb.lastQuery.includes('b.event_date = $'), 'Includes date');
    assert(mockDb.lastQuery.includes('b.status = $'), 'Includes status');
    assert(mockDb.lastQuery.includes('bc.slug = $'), 'Includes category');
    assert(mockDb.lastQuery.includes('b.location ILIKE $'), 'Includes location');
    console.log('  ✓ Combined filters (date + status + category + location) correctly merged');
  }

  console.log('All T1 Backend tests passed successfully! ✅');
}

runTests().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
