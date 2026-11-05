'use strict';
// 2026-10-05 — Xero brings NOTHING into Wren unless this is switched on.
// Toby: "make sure nothing else comes in through Xero." Barclays open banking is the
// bank feed (from 26 Sep) and Wren raises the invoices, so a Xero bank line is only ever
// a copy of a Barclays one — on 1-2 Oct 18 copies sat in the reconcile queue beside
// their twins. Every Xero pull (bank lines, accounting reports, the transaction mirror,
// the finance-provider sync) asks here first. Off unless XERO_INBOUND_ENABLED=true.
function xeroInboundOff() {
  return String(process.env.XERO_INBOUND_ENABLED || '').toLowerCase() !== 'true';
}
const OFF_REASON = 'Xero inbound is switched off (2026-10-05): Barclays open banking is the bank feed and Wren raises the invoices. Set XERO_INBOUND_ENABLED=true to allow.';
module.exports = { xeroInboundOff, OFF_REASON };
