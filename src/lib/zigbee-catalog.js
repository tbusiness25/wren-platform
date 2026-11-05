'use strict';
/* ═══════════════════════════════════════════════════════════════════════════════
 * zigbee-catalog.js — b511 (2026-10-19)
 *
 * The plain-English half of "Building & devices". Everything here is STATIC
 * knowledge about the kinds of device the nursery owns: what a model is called
 * in words, what it looks like, what battery it eats, and exactly how a person
 * standing in front of it puts it into pairing mode.
 *
 * ── WHY THIS IS A FILE AND NOT A COMMENT IN THE PAGE ─────────────────────────
 * the office manager is the person who will use it, usually when Toby is not in the building.
 * The wizard is only useful if it shows the RIGHT steps for the RIGHT model at
 * the moment she is holding it, so the steps are data, keyed by model, and the
 * page renders whatever the catalogue says. Adding a new model is one entry here
 * and nothing else.
 *
 * ── THE INSTRUCTIONS ARE CHECKED, NOT REMEMBERED ─────────────────────────────
 * Every `pairing` block below was read off SONOFF's own manual (or
 * zigbee2mqtt.io's device page) on 2026-10-18 and each entry carries its
 * `source` URL. Two things the b511 brief had slightly wrong, and which the
 * manuals settle:
 *   • TRVZB takes **3 × AA**, not 2 (support.sonoff.tech: "4.5V (3×1.5V AA)").
 *   • TRVZB pairing is the **middle button held 3 s while the screen shows OF**,
 *     not "hold until the Zigbee icon flashes" — the flashing icon is the
 *     RESULT, and someone holding the button on a screen showing a temperature
 *     gets nowhere. The z2m page adds the "turn the dial anticlockwise to OF"
 *     step that the manual assumes.
 * The other five models are all "hold the pairing button 5 s, LED flashes slowly
 * for 180 s", which is what the brief said, and all five take a CR2477 coin cell
 * rather than AAs.
 *
 * ── NO COLOUR, NO MARKUP ─────────────────────────────────────────────────────
 * `icon` is a key the page maps to an inline SVG. Nothing here emits HTML and
 * nothing here names a colour: the page owns both, in var(--c-*) tokens.
 * ═══════════════════════════════════════════════════════════════════════════════ */

const fs   = require('fs');
const path = require('path');

// ── Device types ────────────────────────────────────────────────────────────
// Five words a person who has never heard "Zigbee" would use. The wizard's
// step 1 is literally this list as big pictures.
const TYPES = {
  radiator: {
    key: 'radiator', label: 'Radiator valve', plural: 'Radiator valves', icon: 'radiator',
    blurb: 'The white dial on the end of a radiator that sets how warm the room gets.',
    where: 'Screwed onto the radiator in place of the old plastic knob.',
  },
  thermometer: {
    key: 'thermometer', label: 'Thermometer', plural: 'Thermometers', icon: 'thermometer',
    blurb: 'A small white square that reports how warm a room, the fridge or the freezer is.',
    where: 'On a wall, a shelf, or inside the fridge or freezer.',
  },
  plug: {
    key: 'plug', label: 'Smart plug', plural: 'Smart plugs', icon: 'plug',
    blurb: 'A plug that goes between the socket and whatever is plugged in, so it can be switched on and off.',
    where: 'In a wall socket. These also pass messages along for everything else, so leave them plugged in.',
  },
  button: {
    key: 'button', label: 'Button', plural: 'Buttons', icon: 'button',
    blurb: 'A single press-me button that can be set to do something.',
    where: 'Stuck to a wall or loose on a shelf.',
  },
  sensor: {
    key: 'sensor', label: 'Movement sensor', plural: 'Movement sensors', icon: 'sensor',
    blurb: 'Notices when somebody walks past.',
    where: 'High up in a corner, pointing into the room.',
  },
  other: {
    key: 'other', label: 'Other device', plural: 'Other devices', icon: 'other',
    blurb: 'Something that does not fit the other four.',
    where: '',
  },
};

// ── The models the nursery actually owns ────────────────────────────────────
// `router: true` means the device is mains-powered and relays messages for the
// battery ones. The troubleshooter leans on this: "too far away" is nearly
// always fixed by plugging a plug in between, not by moving the sensor.
const MODELS = {
  TRVZB: {
    model: 'TRVZB', vendor: 'SONOFF', type: 'radiator', router: false,
    name: 'Radiator valve',
    battery: '3 × AA batteries',
    battery_phrase: 'three AA batteries',
    battery_note: 'Ordinary AA alkalines. It takes three, and the battery reading can take a day to catch up after a change.',
    wake: {
      steps: ['Press the middle button once so the screen lights up.', 'If the screen stays blank, the batteries are flat — put in three new AA batteries.'],
      warn: 'Do not turn the dial to OF and hold the button: that is pairing. Only do that if this card says pair it again.',
    },
    pairing: {
      lead: 'Do this standing at the radiator, with the valve already screwed on and showing a temperature.',
      steps: [
        'If the little screen shows FS or RD instead of a temperature, press the middle button until it stops.',
        'Hold the middle button for about 5 seconds until a temperature appears.',
        'Turn the dial anticlockwise until the screen shows OF.',
        'With OF showing, hold the middle button for 3 seconds.',
        'A signal icon starts flashing on the screen. That is it looking for us — leave it alone.',
      ],
      success: 'The flashing stops and the screen settles back to a temperature.',
      window_s: 180,
      sources: [
        'https://support.sonoff.tech/trvzb-usermanual/',
        'https://www.zigbee2mqtt.io/devices/TRVZB.html',
      ],
    },
  },
  'SNZB-02P': {
    model: 'SNZB-02P', vendor: 'SONOFF', type: 'thermometer', router: false,
    name: 'Thermometer',
    battery: 'One CR2477 coin cell',
    battery_phrase: 'one CR2477 coin cell',
    battery_note: 'A flat round battery about the size of a 10p. CR2477 — the thicker one; a CR2032 will not fit.',
    wake: {
      steps: ['Press the small button on the back once — a quick press, then let go.'],
      warn: 'A quick press only. Holding the button for 5 seconds takes it off the network, and then it has to be paired again.',
    },
    pairing: {
      lead: 'Take the back off if you need to reach the little button.',
      steps: [
        'Find the small pairing button (on the back, next to the battery).',
        'Press and hold it for 5 seconds, then let go.',
        'The light starts flashing slowly. It keeps flashing for 3 minutes.',
      ],
      success: 'The light stays on for about 3 seconds and then goes out.',
      failure: 'If the light just stops and goes dark, it gave up — hold the button for 5 seconds again.',
      window_s: 180,
      sources: [
        'https://help.sonoff.tech/docs/snzb-02p',
        'https://www.zigbee2mqtt.io/devices/SNZB-02P.html',
      ],
    },
  },
  'SNZB-02LD': {
    model: 'SNZB-02LD', vendor: 'SONOFF', type: 'thermometer', router: false,
    name: 'Thermometer with a probe',
    battery: 'One CR2477 coin cell',
    battery_phrase: 'one CR2477 coin cell',
    battery_note: 'Same flat round CR2477 as the other thermometers.',
    wake: {
      steps: ['Press the small button on the body (not the probe) once — a quick press, then let go.'],
      warn: 'A quick press only. Holding the button for 5 seconds takes it off the network, and then it has to be paired again.',
    },
    pairing: {
      lead: 'This is the one with a wire and a metal probe on the end.',
      steps: [
        'Find the small pairing button on the body (not the probe).',
        'Press and hold it for 5 seconds, then let go.',
        'The light starts flashing slowly. It keeps flashing for 3 minutes.',
      ],
      success: 'The light stays on. (Holding for 5 seconds also wipes it back to factory, which is what we want here.)',
      window_s: 180,
      sources: ['https://support.sonoff.tech/snzb-02ld-usermanual/'],
    },
  },
  S60ZBTPG: {
    model: 'S60ZBTPG', vendor: 'SONOFF', type: 'plug', router: true,
    name: 'Smart plug',
    battery: 'No battery — it runs off the socket',
    battery_phrase: 'no battery at all — it runs off the socket',
    battery_note: 'Nothing to replace. Leave it switched on at the wall: these three plugs are what carry messages to everything else in the building.',
    wake: {
      steps: ['Check it is plugged in and the wall socket is switched on.', 'Its blue light should be on. If the socket is on but the plug stays dark, try it in another socket in the same room.'],
      warn: 'Do not press its button. A short press switches off whatever is plugged into it, and holding it for 5 seconds takes it off the network.',
    },
    pairing: {
      lead: 'Plug it into a socket and switch the socket on first.',
      steps: [
        'Press and hold the button on the side of the plug for 5 seconds.',
        'The blue light starts flashing slowly. It keeps flashing for 3 minutes.',
      ],
      success: 'The blue light stops flashing and stays on.',
      failure: 'A fast flash means it cannot see us. A rapid continuous flash means it has tripped on overload — unplug whatever is in it.',
      window_s: 180,
      sources: ['https://support.sonoff.tech/s60zbtpg-usermanual/'],
    },
  },
  'SNZB-01P': {
    model: 'SNZB-01P', vendor: 'SONOFF', type: 'button', router: false,
    name: 'Button',
    battery: 'One CR2477 coin cell',
    battery_phrase: 'one CR2477 coin cell',
    battery_note: 'Lasts about five years, so it is rarely the answer.',
    wake: {
      steps: ['Press it once, the way you would use it.'],
      warn: 'A quick press only. Holding the button for 5 seconds takes it off the network, and then it has to be paired again.',
    },
    pairing: {
      lead: 'The pairing button is the same button you press to use it.',
      steps: [
        'Press and hold the button for 5 seconds, then let go.',
        'The light flashes slowly for 3 minutes.',
      ],
      success: 'The light stays on for 3 seconds and then goes out.',
      window_s: 180,
      sources: ['https://support.sonoff.tech/snzb-01p-usermanual/'],
    },
  },
  'SNZB-03P': {
    model: 'SNZB-03P', vendor: 'SONOFF', type: 'sensor', router: false,
    name: 'Movement sensor',
    battery: 'One CR2477 coin cell',
    battery_phrase: 'one CR2477 coin cell',
    battery_note: 'Lasts around three years.',
    wake: {
      steps: ['Wave a hand in front of it.', 'If you can reach its small button, press it once — a quick press.'],
      warn: 'A quick press only. Holding the button for 5 seconds takes it off the network, and then it has to be paired again.',
    },
    pairing: {
      lead: 'Take it off its bracket so you can reach the button.',
      steps: [
        'Press and hold the pairing button for 5 seconds, then let go.',
        'The light flashes slowly for 3 minutes.',
      ],
      success: 'The light stays on for 3 seconds and then goes out.',
      window_s: 180,
      sources: ['https://support.sonoff.tech/snzb-03p-usermanual/'],
    },
  },
};

// Anything we have never seen before. The wizard still works: open joining, and
// whatever arrives gets named — we just cannot print its steps.
const UNKNOWN_MODEL = {
  model: null, vendor: null, type: 'other', router: false,
  name: 'Device',
  battery: 'Check the back of the device',
  battery_phrase: 'whatever is printed on the back of it',
  battery_note: '',
  wake: {
    steps: ['Press its button once — a quick press, then let go.'],
    warn: 'Do not hold the button down: that usually takes it off the network.',
  },
  pairing: {
    lead: 'We do not have instructions for this exact model.',
    steps: [
      'Look for a small button on the device.',
      'Press and hold it for about 5 seconds until a light starts flashing.',
      'If nothing flashes, try taking the battery out for 10 seconds and putting it back.',
    ],
    success: 'The light stops flashing.',
    window_s: 180,
    sources: ['https://www.zigbee2mqtt.io/guide/usage/pairing_devices.html'],
  },
};

function modelInfo(model) {
  const m = MODELS[String(model || '').trim()];
  if (m) return m;
  return { ...UNKNOWN_MODEL, model: model || null };
}

function typeInfo(typeKey) {
  return TYPES[typeKey] || TYPES.other;
}

/** What type is this, given whatever z2m/HA told us? */
function typeOf(model) {
  return modelInfo(model).type;
}

// ── Rooms ───────────────────────────────────────────────────────────────────
// The nursery's rooms, in the order a person walks them. `ha_area` is the Home
// Assistant area id where one exists — HA's own area names ("Ps1") are not what
// anybody calls the room, so the label here wins on the page.
const ROOMS = [
  { key: 'baby_room',  label: 'Baby Room',    ha_area: 'baby_room' },
  { key: 'ps1',        label: 'Pre-school 1', ha_area: 'ps1' },
  { key: 'ps2',        label: 'Pre-school 2', ha_area: 'ps2' },
  { key: 'kitchen',    label: 'Kitchen',      ha_area: 'kitchen' },
  { key: 'office',     label: 'Office',       ha_area: 'office' },
  { key: 'wc',         label: 'Toilets',      ha_area: 'wc' },
  { key: 'unassigned', label: 'Not in a room yet', ha_area: null },
];
const ROOM_BY_KEY   = Object.fromEntries(ROOMS.map(r => [r.key, r]));
const ROOM_BY_AREA  = Object.fromEntries(ROOMS.filter(r => r.ha_area).map(r => [r.ha_area, r]));

function roomLabel(key) {
  return (ROOM_BY_KEY[key] && ROOM_BY_KEY[key].label) || 'Not in a room yet';
}

/**
 * Guess a room from the name the device had on the old network.
 * "BR long" → baby_room, "PS1 rear rad" → ps1, "FRIDGE THERM" → kitchen.
 * Used ONLY to pre-fill the wizard; a person confirms it before it is saved.
 */
function roomFromName(name) {
  const n = String(name || '').toLowerCase();
  if (/^br\b|baby/.test(n))       return 'baby_room';
  if (/\bps1\b|pre-?school ?1/.test(n)) return 'ps1';
  if (/\bps2\b|pre-?school ?2/.test(n)) return 'ps2';
  if (/fridge|freezer|kitchen/.test(n)) return 'kitchen';
  if (/office|art\b/.test(n))     return 'office';
  if (/\bwc\b|toilet/.test(n))    return 'wc';
  return 'unassigned';
}

// ── The devices that were on the network before the stick was lost ──────────
// Read once, from src/content/zigbee/old-network-20261017.json (the export Toby
// took on 17 Oct, 19 devices). This is the re-pair checklist's source of truth
// and the "welcome back" lookup in the wizard. It is a snapshot and it never
// changes: a device that comes back is recorded in the DB, not here.
let _oldNetwork = null;
function oldNetwork() {
  if (_oldNetwork) return _oldNetwork;
  try {
    const raw = fs.readFileSync(path.join(__dirname, '..', 'content', 'zigbee', 'old-network-20261017.json'), 'utf8');
    const list = JSON.parse(raw);
    _oldNetwork = list.map(d => {
      // Several devices were never named on the old network, so z2m called them
      // by their address. Showing "0xd44867fffe2b2ea7" to the office manager is useless, so
      // an unnamed device is described by what it IS instead.
      const named = d.name && !/^0x[0-9a-f]+$/i.test(d.name);
      const info  = modelInfo(d.model);
      return {
        ieee: String(d.ieee).toLowerCase(),
        old_name: named ? d.name : null,
        display: named ? d.name : `${info.name} (never named)`,
        model: d.model || null,
        vendor: d.vendor || null,
        type: info.type,
        router: !!info.router,
        room: named ? roomFromName(d.name) : 'unassigned',
      };
    });
  } catch (e) {
    _oldNetwork = [];
  }
  return _oldNetwork;
}

function oldDevice(ieee) {
  const k = String(ieee || '').toLowerCase();
  return oldNetwork().find(d => d.ieee === k) || null;
}

// ── The troubleshooter ──────────────────────────────────────────────────────
// Ordered: the thing most likely to be wrong first. `when` decides whether a
// step is shown at all, so a mains plug is never told to change its battery.
function troubleshoot(device) {
  const info  = modelInfo(device && device.model);
  const out   = [];
  // ⚠️ Number(null) is 0 and 0 is finite. An OFFLINE device reports no battery at
  // all, so the naive check made every unreachable device say "The battery is low
  // (0%)" — including a radiator valve with a 70% battery that had merely stopped
  // answering. Null first, always.
  const raw   = device ? device.battery_pct : null;
  const bat   = (raw === null || raw === undefined || !Number.isFinite(Number(raw))) ? null : Number(raw);

  if (!info.router) {
    out.push({
      key: 'battery',
      title: bat !== null && bat < 20 ? `The battery is low (${Math.round(bat)}%)` : 'Change the battery',
      body: `This one takes ${info.battery_phrase}. ${info.battery_note}`.trim(),
      strength: bat !== null && bat < 20 ? 'likely' : 'maybe',
    });
  }
  out.push({
    key: 'range',
    title: 'It may be too far from a plug',
    body: info.router
      ? 'This is one of the plugs, so it is itself the thing that carries messages. Check the socket is switched on at the wall.'
      : 'The three smart plugs (Baby, Art, Office) are what relay messages across the building. If one of them is unplugged, '
        + 'anything that was leaning on it goes quiet. Check all three are in and switched on, then wait ten minutes.',
    strength: 'maybe',
  });
  out.push({
    key: 'repair',
    title: 'Pair it again',
    body: 'Nothing is lost by doing this: it keeps its name and everything it was set up to do. '
        + 'Use "Add a device" and pick the same kind.',
    strength: 'fix',
    pairing: info.pairing,
  });
  out.push({
    key: 'escalate',
    title: 'Still nothing?',
    body: 'Leave it. Tell Toby which device and what the card says. Nothing in the building stops working because one of these is offline — '
        + 'the radiator still works by hand, and the fridge and freezer are still logged by hand on the kitchen screen.',
    strength: 'info',
  });
  return out;
}

// ── Bringing one back (3 Nov 2026) ──────────────────────────────────────────
// Since 3 Nov the hub carries the OLD network again (the lost stick turned up —
// wren-docs/decisions/2026-11-03-zigbee-old-network-restored-onto-dongle-m.md),
// so a device that is not answering is asleep or unpowered, not unpaired. The
// kind is the order of the walk round: plugs first, because everything else
// relays through them; then a quick press; pairing again only where Wren knows
// a quick press cannot work (`needsRepair`) or as the last resort on a card.
function bringBack(model, { needsRepair = false } = {}) {
  const info = modelInfo(model);
  const wake = info.wake || UNKNOWN_MODEL.wake;
  if (needsRepair) {
    return {
      kind: 'repair',
      title: 'Pair it again',
      why: 'It was paired to a different network in October, so a quick press will not bring it back.',
      lead: info.pairing.lead,
      steps: info.pairing.steps,
      success: info.pairing.success || null,
    };
  }
  if (info.router) {
    return { kind: 'power', title: 'Check it is switched on', steps: wake.steps, warn: wake.warn,
             then: 'Once the plugs are on, give everything else ten minutes before you start pressing buttons.' };
  }
  return {
    kind: 'wake',
    title: 'Press its button once',
    steps: wake.steps,
    warn: wake.warn,
    then: `Not back after two minutes? Put in a new battery (${info.battery_phrase}) and press once more. `
        + 'Still nothing? Pair it again with "Add a device" — it keeps its name and its room.',
  };
}

module.exports = {
  TYPES, MODELS, ROOMS,
  modelInfo, typeInfo, typeOf,
  roomLabel, roomFromName, ROOM_BY_AREA, ROOM_BY_KEY,
  oldNetwork, oldDevice,
  troubleshoot, bringBack,
};
