function buildTemplateMsg(booking, template) {
  if (!template) return null; // fallback will be used

  let msg = template;
  const eventDateFmt = new Date(booking.event_date).toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' });
  
  // Standard variables
  const data = {
    client_name: booking.client_name || '',
    event_date: eventDateFmt,
    event_time: booking.event_time ? booking.event_time.slice(0,5) : '-',
    location: booking.location || '-',
    package_price: booking.package_price ? 'Rp ' + Number(booking.package_price).toLocaleString('id-ID') : '-',
    dp_amount: booking.dp_amount ? 'Rp ' + Number(booking.dp_amount).toLocaleString('id-ID') : '-'
  };

  // Form variables
  if (booking.form_data && typeof booking.form_data === 'object') {
    Object.assign(data, booking.form_data);
  }

  // Replace {{key}}
  for (const [key, val] of Object.entries(data)) {
    const regex = new RegExp(`{{${key}}}`, 'g');
    msg = msg.replace(regex, val);
  }

  // Clean up any remaining {{xxx}} that didn't match
  msg = msg.replace(/{{[^}]+}}/g, '-');

  return msg;
}

module.exports = { buildTemplateMsg };
