/**
 * Calls every endpoint the frontend uses, as the role that uses it.
 *
 * This exists because a whole class of bug — a broken DTO, a lost method, a
 * wrong guard — only shows up when an endpoint is actually called, and the
 * fastest way to find those was a person clicking through the app. This does
 * the clicking.
 *
 * It asserts the *expected* status, so a 403 that should be a 403 passes and a
 * 500 never does.
 *
 *   node scripts/smoke-all-endpoints.mjs
 */
const API = process.env.API_URL ?? 'http://localhost:3000/api/v1';
const ORIGIN = process.env.ORIGIN ?? 'http://localhost:5173';

const ACCOUNTS = {
  admin: { identifier: '01711000001', password: 'Admin#2026' },
  manager: { identifier: '01711000002', password: 'Manager#2026' },
  cashier: { identifier: '01711000003', password: 'Cashier#2026' },
};

const tokens = {};
let passed = 0;
const failures = [];

async function signIn(role) {
  const response = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify(ACCOUNTS[role]),
  });
  if (!response.ok) throw new Error(`Could not sign in as ${role} (${response.status})`);
  const body = await response.json();
  tokens[role] = body.data.accessToken;
}

async function hit(role, path, expected = 200) {
  const response = await fetch(`${API}${path}`, {
    headers: { origin: ORIGIN, authorization: `Bearer ${tokens[role]}` },
  });

  const statuses = Array.isArray(expected) ? expected : [expected];
  const ok = statuses.includes(response.status);

  if (ok) {
    passed++;
  } else {
    let detail = '';
    try {
      const body = await response.json();
      detail = body.message ?? '';
    } catch {
      /* non-JSON body */
    }
    failures.push(`${role.padEnd(8)} ${String(response.status).padEnd(4)} ${path}  ${detail}`);
  }

  return response;
}

/** Every screen in the app and the calls it makes on load. */
const SCREENS = [
  ['Dashboard', 'admin', ['/dashboard/combined']],

  ['Kid Zone · check-in', 'manager', []],
  ['Kid Zone · floor', 'manager', ['/kidzone/visits/active']],
  ['Kid Zone · sell', 'manager', ['/kidzone/plans?isActive=true&limit=100']],
  ['Kid Zone · memberships', 'manager', ['/kidzone/memberships?page=1&limit=25&status=ACTIVE', '/kidzone/memberships?expiringWithinDays=7']],
  ['Kid Zone · sales', 'manager', ['/kidzone/sales?page=1&limit=25']],
  ['Kid Zone · visits', 'manager', ['/kidzone/visits?page=1&limit=25']],
  ['Kid Zone · plans', 'admin', ['/kidzone/plans?limit=100']],

  ['Restaurant · till', 'cashier', ['/restaurant/menu']],
  ['Restaurant · orders', 'cashier', ['/restaurant/orders?page=1&limit=25']],
  ['Restaurant · menu', 'cashier', ['/restaurant/menu-items?limit=100', '/restaurant/categories']],

  ['Customers', 'manager', ['/customers?page=1&limit=25&isActive=true']],

  ['Closing · Kid Zone', 'manager', ['/closing/kidzone/preview']],
  ['Closing · restaurant', 'cashier', ['/closing/restaurant/preview']],
  ['Closing · history', 'admin', ['/closing?page=1&limit=15']],

  [
    'Reports · Kid Zone',
    'admin',
    [
      '/reports/kidzone/summary?range=this_month',
      '/reports/kidzone/revenue-trend?range=this_month',
      '/reports/kidzone/by-plan?range=this_month',
      '/reports/kidzone/visits?range=this_month',
      '/reports/kidzone/peak-hours?range=this_month',
      '/reports/kidzone/membership-utilization?range=this_month',
      '/reports/kidzone/members?range=this_month',
    ],
  ],
  [
    'Reports · restaurant',
    'admin',
    [
      '/reports/restaurant/summary?range=this_month',
      '/reports/restaurant/revenue-trend?range=this_month',
      '/reports/restaurant/top-items?range=this_month&limit=10',
      '/reports/restaurant/by-category?range=this_month',
      '/reports/restaurant/hourly?range=this_month',
      '/reports/restaurant/cashier-performance?range=this_month',
    ],
  ],
  [
    'Reports · shared',
    'admin',
    [
      '/reports/payment-methods?range=this_month',
      '/reports/discounts-voids?range=this_month',
      '/reports/cross-section?range=this_month',
    ],
  ],

  ['Admin · staff', 'admin', ['/users?page=1&limit=25']],
  ['Admin · settings', 'admin', ['/settings', '/settings/schema']],
  ['Admin · audit', 'admin', ['/audit-logs?page=1&limit=25']],
  ['Admin · operations', 'admin', ['/jobs/sms-log?page=1&limit=25']],
];

/** Access the UI hides, which the API must still refuse. */
const DENIALS = [
  ['cashier', '/kidzone/sales?page=1&limit=25', 403],
  ['cashier', '/kidzone/visits/active', 403],
  ['cashier', '/dashboard/combined', 403],
  ['cashier', '/reports/kidzone/summary?range=today', 403],
  ['manager', '/restaurant/orders?page=1&limit=25', 403],
  ['manager', '/restaurant/menu', 403],
  ['manager', '/users?page=1&limit=25', 403],
  ['manager', '/settings', 403],
  ['manager', '/audit-logs', 403],
  // Staff get today only; a historical range is refused.
  ['manager', '/reports/kidzone/summary?range=this_month', 403],
  ['cashier', '/reports/restaurant/summary?range=last_week', 403],
  // Exports are admin-only whatever the range.
  ['manager', '/reports/kidzone/summary?range=today&export=xlsx', 403],
];

async function main() {
  console.log(`\nCalling every screen's endpoints against ${API}\n`);

  for (const role of Object.keys(ACCOUNTS)) await signIn(role);

  for (const [screen, role, paths] of SCREENS) {
    if (paths.length === 0) continue;
    for (const path of paths) await hit(role, path);
    console.log(`  ${screen}`);
  }

  // The membership card needs a real membership id, so it cannot live in the
  // static SCREENS table above.
  const memberships = await hit('manager', '/kidzone/memberships?limit=1&status=ACTIVE');
  const membershipId = (await memberships.clone().json().catch(() => ({})))?.data?.[0]?.id;

  if (membershipId) {
    const card = await hit('manager', `/kidzone/memberships/${membershipId}/qr`);
    const token = (await card.clone().json().catch(() => ({})))?.data?.qrToken;
    if (typeof token !== 'string' || token.length < 20) {
      failures.push(`manager  --   /kidzone/memberships/:id/qr  returned no usable qrToken`);
    }
    console.log('  Kid Zone · membership card');
  } else {
    console.log('  Kid Zone · membership card (skipped: no active membership seeded)');
  }

  console.log('\n  Role denials the API must enforce');
  for (const [role, path, expected] of DENIALS) await hit(role, path, expected);
  if (membershipId) await hit('cashier', `/kidzone/memberships/${membershipId}/qr`, 403);

  // Exports, which stream files rather than JSON.
  console.log('  Report exports');
  for (const format of ['xlsx', 'pdf']) {
    await hit('admin', `/reports/kidzone/summary?range=this_month&export=${format}`);
    await hit('admin', `/reports/restaurant/summary?range=this_month&export=${format}`);
  }

  console.log(`\n${passed} calls returned the expected status`);

  if (failures.length > 0) {
    console.log(`\n${failures.length} unexpected:\n`);
    for (const failure of failures) console.log(`  ${failure}`);
    process.exitCode = 1;
  } else {
    console.log('No unexpected responses.\n');
  }
}

main().catch((error) => {
  console.error('\nSmoke run failed:', error.message, '\n');
  process.exitCode = 1;
});
