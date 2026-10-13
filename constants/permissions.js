'use strict';

/**
 * Peta Role -> Permissions sesuai Bagian 2 crm.md
 */
const ROLE_PERMISSIONS = {
  owner: [
    'dashboard.view',
    'dashboard.view_revenue',
    'booking.view',
    'booking.create',
    'booking.update',
    'booking.view_amount',
    'booking.cancel',
    'booking.delete',
    'payment.verify',
    'tagihan.send',
    'tagihan.override_amount',
    'wa_template.manage',
    'category.manage',
    'finance.*',
    'finance.view',
    'finance.manage',
    'payment_settings.manage',
    'user.manage',
    'audit.view_all',
    'approval.decide',
    'audit.view_own'
  ],
  staff: [
    'dashboard.view',
    'booking.view',
    'booking.create',
    'booking.update',
    'booking.view_amount',
    'booking.cancel',          // Jika ada DP: dialihkan ke approval
    'booking.delete',          // Dialihkan ke approval
    'payment.verify',
    'tagihan.send',
    'tagihan.override_amount', // Dialihkan ke approval
    'wa_template.manage',
    'category.manage',
    'audit.view_own'
  ]
};

// Dukungan backward compatibility: role 'admin' dianggap sinonim dengan 'owner'
ROLE_PERMISSIONS.admin = ROLE_PERMISSIONS.owner;

/**
 * Cek apakah sebuah role memiliki permission tertentu.
 * Mendukung wildcard (misal 'finance.*' mencakup 'finance.view').
 */
function hasPermission(role, requiredPermission) {
  if (!role) return false;
  const userPerms = ROLE_PERMISSIONS[role.toLowerCase()] || [];

  return userPerms.some(perm => {
    if (perm === '*' || perm === requiredPermission) return true;
    if (perm.endsWith('.*')) {
      const prefix = perm.slice(0, -2);
      return requiredPermission === prefix || requiredPermission.startsWith(prefix + '.');
    }
    return false;
  });
}

function getPermissionsForRole(role) {
  if (!role) return [];
  return ROLE_PERMISSIONS[role.toLowerCase()] || [];
}

module.exports = {
  ROLE_PERMISSIONS,
  hasPermission,
  getPermissionsForRole
};
