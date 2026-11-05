// Where to send someone Roost turned away (roost_restricted). 2026-10-06.
//
// The shell (public/js/wren-shell-v2.js) and the Roost login page send a refused
// person to `redirect.ey` / `redirect.hr` from the 403. Only LADN's own gates in
// editions/ladn/server-unified.js ever set those, with LADN's hosts baked in, so
// the shared routers (admin.js, council-sharing.js) sent none and the browser fell
// back to ey.example-nursery.co.uk. On htps / childrenscorner that bounced a
// school's staff into the LADN production portal: the wrong setting.
//
// This works the hosts out from the host the request came in on, so a refused
// person stays inside their own setting. LADN is unchanged: any
// example-nursery.co.uk host, and anything this cannot place (LAN/Tailscale
// IPs, localhost) on the LADN server, still gets the LADN EY/HR portals.

const LADN = Object.freeze({
  ey: 'https://ey.example-nursery.co.uk/',
  hr: 'https://hr.example-nursery.co.uk/',
});

// A 4-portal instance whose learning host is not its INSTANCE_SLUG. Children's
// Corner runs as slug `cc` (cc-admin / cc-hr / cc-parents.getwren.co.uk) but its
// learning portal is childrenscorner.getwren.co.uk; there is no cc.getwren.co.uk.
const LEARNING_LABEL = { cc: 'childrenscorner' };

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** { ey, hr } portal URLs for the setting this request belongs to. `hr` can be
 *  absent when there is no way to know it; callers hide that link then. */
function roostRedirect(req) {
  const host = String((req && req.hostname) || '').toLowerCase();
  if (!host || /(^|\.)example-nursery\.co\.uk$/.test(host)) return { ...LADN };
  let m;
  // The HT nature-theme demo (wren-ht): ht-roost admin, ht-seed HR, ht-nest
  // parents, ht-egg learning.
  if ((m = host.match(/^ht-(?:roost|seed|nest|egg)\.(.+)$/))) {
    return { ey: `https://ht-egg.${m[1]}/`, hr: `https://ht-seed.${m[1]}/` };
  }
  // A 4-portal customer instance (editions/ht/server-unified.js host dispatch):
  // <slug>-admin / <slug>-hr / <slug>-parents, learning on the bare name.
  const slug = String(process.env.INSTANCE_SLUG || '').toLowerCase();
  if (slug) {
    const learn = LEARNING_LABEL[slug] || slug;
    const re = new RegExp(`^(?:${esc(slug)}-(?:admin|hr|parents)|${esc(learn)})\\.(.+)$`);
    if ((m = host.match(re))) return { ey: `https://${learn}.${m[1]}/`, hr: `https://${slug}-hr.${m[1]}/` };
  }
  // The classic subdomain layout (the getwren demo): admin./ey./hr./parents.<domain>.
  if ((m = host.match(/^(?:admin|ey|hr|parents)\.(.+)$/))) {
    return { ey: `https://ey.${m[1]}/`, hr: `https://hr.${m[1]}/` };
  }
  // A 4-portal instance reached some other way (IP, alias): the ht server sends
  // every unprefixed host to the learning portal, so stay on this one.
  if (process.env.WREN_EDITION === 'ht') return { ey: `${req.protocol}://${req.get('host')}/` };
  return { ...LADN };
}

module.exports = { roostRedirect };
