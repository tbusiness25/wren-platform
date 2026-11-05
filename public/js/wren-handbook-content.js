/*! wren-handbook-content.js — b312 (2026-09-10)
 *
 * The Wren staff handbook. Eighteen chapters, written for a level-3
 * practitioner who has never seen a developer's diagram and does not want one.
 *
 * This file is DATA ONLY — require()-able from Node (scripts/b312-verify.js
 * reads it to check reading times and that every chapter has a question in
 * ladn.consultation_questions). No DOM calls, no fetch.
 *
 * ── THE RULES THIS CONTENT WAS WRITTEN UNDER ────────────────────────────────
 *
 * 1. NOTHING IS INVENTED. Every claim in Parts 1 and 2 was checked against the
 *    running code on 2026-09-10. Where a chapter describes something that is
 *    NOT yet true, it uses a { t:'coming' } block and says so in as many words
 *    rather than describing it in the present tense. The ten spot-checks and
 *    the file:line each one traces to are listed in
 *    /app/ladn-ready/logs/b312.NOTES.md.
 *
 * 2. FIVE MINUTES, ON A PHONE. Every chapter is under 900 words, which at the
 *    180 words-per-minute a tired person reads on a tablet is under five
 *    minutes. The page shows the number at the top of each chapter and the
 *    verify script fails the build if any chapter goes over.
 *
 * 3. NO JARGON WITHOUT A DEFINITION IN PLACE. "Audience", "capability",
 *    "outbox" and "OIDC" are all defined at the point of first use or not used.
 *
 * 4. THE REAL THING, NOT A DESCRIPTION OF IT. { t:'shot' } blocks are real
 *    screenshots captured off wren-ladn-dev by scripts/b312-screenshots.js —
 *    the dev database, so every child in them is synthetic. Each one also
 *    carries `href`, the live page, because on a phone tapping through to the
 *    actual screen beats looking at a picture of it.
 *
 * ── BLOCK TYPES ────────────────────────────────────────────────────────────
 *   p        paragraph
 *   h        sub-heading
 *   list     bullets            { items: [...] }
 *   olist    numbered steps     { items: [...] }
 *   kv       two-column table   { rows: [[left, right], ...] }
 *   quote    somebody's words   { text, who }
 *   note     a plain aside
 *   warn     something that goes wrong
 *   coming   NOT TRUE YET — rendered as "coming", never as fact
 *   shot     screenshot         { src, caption, href }
 *   try      do this now        { text, href, label }
 *   ab       two worked alternatives { a:{label,body[]}, b:{label,body[]} }
 */
(function (root, factory) {
  var data = factory();
  if (typeof module === 'object' && module.exports) module.exports = data;
  if (root) root.WrenHandbookContent = data;
})(typeof self !== 'undefined' ? self : null, function () {
  'use strict';

  var PARTS = [
    { n: 1, title: 'What Wren is',                 blurb: 'The portals, your sign-in, who can see what.' },
    { n: 2, title: 'How to use it',                blurb: 'Observations, planning, reports, the daily logs.' },
    { n: 3, title: 'The curriculum, and a real question', blurb: 'Fledge, our planning, and what is missing between them.' },
    { n: 4, title: 'What changes when we go live', blurb: 'Meetings, off-ratio time, CPD. Policy, not software.' }
  ];

  var CHAPTERS = [

  // ══════════════════════════════════════════════════════════════════════════
  // PART 1 — WHAT WREN IS
  // ══════════════════════════════════════════════════════════════════════════
  {
    key: 'what-wren-is', part: 1, number: 1,
    title: 'What Wren is, and why we built it',
    standfirst: 'It is our own system. That is the whole of the difference.',
    blocks: [
      { t: 'p', text: 'Wren is the software we use to run the nursery — observations, the diary, the register, planning, reports, messages to parents, the rota, your payslip information, the lot. It replaces EyLog, and eventually BrightHR too.' },
      { t: 'p', text: 'We built it rather than buying it. The short reason: everything else we looked at either could not do what we needed, or did it in a way that meant our children’s records sat on somebody else’s computers in somebody else’s country.' },
      { t: 'h', text: 'Where the data actually is' },
      { t: 'p', text: 'On a small computer in this building. Not in a cloud, not in America. If the internet goes down, the tablets keep talking to it over the nursery wifi. Nothing about a child ever leaves the setting except the specific things we deliberately send to that child’s own parents.' },
      { t: 'p', text: 'That is not a marketing line, it is the reason several of the design decisions in this handbook look stricter than you would expect — for instance, why a message about a child can never be emailed to you (chapter 9).' },
      { t: 'h', text: 'What changes for you' },
      { t: 'list', items: [
        'The tablet you write observations on. Same job, different app.',
        'Where you look for the plan, the register, the diary — all in one place now instead of EyLog plus paper plus the office.',
        'You get your own sign-in for the office side of things (chapter 3), which you did not have before.'
      ] },
      { t: 'h', text: 'What does not change' },
      { t: 'list', items: [
        'Your PIN on the room tablet. Same four taps.',
        'What a good observation is. Wren does not have an opinion about your practice.',
        'Ratios, safeguarding routes, who you tell when you are worried. All exactly as now.'
      ] },
      { t: 'h', text: 'When' },
      { t: 'p', text: 'Wren is already running alongside EyLog: observations, diary, planning, register and messages all work today. EyLog is still being read from every night so nothing is stranded while both are live.' },
      { t: 'coming', text: 'The date we stop using EyLog altogether has not been set. Nobody is being asked to work in two systems for a day longer than necessary, but until Toby names the date, treat EyLog as still live.' },
      { t: 'p', text: 'One more thing worth saying plainly, because it is the reason this handbook exists at all: Wren is ours, so when something in it is wrong or annoying, saying so is not a complaint into the void. It gets changed. That is what the question at the end of each chapter is for.' }
    ]
  },

  {
    key: 'portals', part: 1, number: 2,
    title: 'The four portals, and their addresses',
    standfirst: 'Four front doors to the same building. You have a key to one or two of them.',
    blocks: [
      { t: 'p', text: 'A "portal" is just a website address. Wren has four, and which one you get depends on who you are. They all read and write the same records — change something in one and it is changed everywhere — but each one shows a different slice.' },
      { t: 'kv', rows: [
        ['ey.example-nursery.co.uk', 'Nest — the practitioner portal. The room tablets. Observations, diary, register, planning, your own tasks. This is the one you live in.'],
        ['hr.example-nursery.co.uk', 'HR — your own employment things. Shifts, absence requests, your documents, your clock records. Safe to use on your own phone: it has no child data on it at all.'],
        ['admin.example-nursery.co.uk', 'Roost — the management portal. Finance, payroll, occupancy, the whole nursery from the office chair.'],
        ['parents.example-nursery.co.uk', 'Finch — what parents see. Their own child, nobody else’s.']
      ] },
      { t: 'shot', src: '/images/handbook/ey-home.png', caption: 'Nest, on a phone. Your rooms, your children, and the + button for everything you can log. Every child in the screenshots in this handbook is made up — they are taken from the test copy of Wren, never from the real one.', href: '/ey/home' },
      { t: 'h', text: 'Why you cannot see the others' },
      { t: 'p', text: 'It is not a hierarchy thing. Each portal is locked to a different kind of information, and mixing them would break a promise made somewhere else:' },
      { t: 'list', items: [
        'HR is deliberately empty of child data, because it is designed to be used on your own phone at home. If child records appeared there, we could no longer say that.',
        'Nest has child data, which is why it is meant to be used on nursery devices (chapter 5).',
        'Roost is restricted to a named list of people rather than to a job title — at the moment that list is Toby. Being a manager is not enough on its own.',
        'Finch only ever shows a family their own children.'
      ] },
      { t: 'h', text: 'Practical bits' },
      { t: 'list', items: [
        'You do not need to type the address on a room tablet — Nest is the home screen.',
        'On your own phone, HR is the one to bookmark. Add it to your home screen and it behaves like an app.',
        'If you land on the wrong portal you will get a plain message telling you which one to use, with a link. It is not an error and you have not broken anything.'
      ] },
      { t: 'try', text: 'Open HR on your phone now and add it to your home screen — it takes twenty seconds and it is the one you will want at 7am when you are ill.', href: 'https://hr.example-nursery.co.uk/', label: 'Open HR' }
    ]
  },

  {
    key: 'wren-id', part: 1, number: 3,
    title: 'Wren ID — your own sign-in',
    standfirst: 'It does not replace your PIN. It is for the office side of Wren.',
    blocks: [
      { t: 'p', text: 'Wren ID is a proper account — your work email address and a password you choose — that signs you in to Wren without a PIN. It exists because a PIN is right for a shared tablet in a room and wrong for everything else: PINs are four digits, everyone can see you type them, and you cannot use one to prove it was you.' },
      { t: 'warn', text: 'Right now Wren ID works on Roost and HR only. The room tablet still uses your PIN, and there is no plan in front of anyone to change that this term. If somebody tells you Wren ID replaces your PIN, they are wrong.' },
      { t: 'h', text: 'Setting it up' },
      { t: 'olist', items: [
        'You get an email with a link. It is sent when your account is approved, and it is signed by whoever pressed the button — so if it looks odd, reply to it and ask.',
        'Open the link on your phone. It asks you to set a password. Choose something you do not use anywhere else.',
        'That is it. From then on, HR and Roost offer "Sign in with Wren ID" as well as a PIN.'
      ] },
      { t: 'h', text: 'When the link has expired' },
      { t: 'p', text: 'The link lasts fourteen days and can only be used once. That is on purpose: a sign-up link sitting unused in an inbox forever is a way in for whoever else reads that inbox.' },
      { t: 'p', text: 'If it has expired, or you never got it, ask in the office. Toby can send a fresh one, and doing so cancels the old link at the same moment — so there is never more than one live link for you. You do not need to do anything with the old email.' },
      { t: 'h', text: 'What it does not do' },
      { t: 'list', items: [
        'It does not change what you can see. Your account still gets its permissions from your staff record here, not from the sign-in. Having a Wren ID cannot give you access to anything (see chapter 4).',
        'It does not get you into Roost. Roost is a named list of people, and Wren ID is not a way around that list.',
        'It is not a Google or Microsoft account. It is Wren’s own, running on the same computer in this building as everything else.'
      ] },
      { t: 'note', text: 'Managers: you will also be asked for a second factor — a code from an app on your phone — on top of whichever sign-in you use. Practitioners are not.' }
    ]
  },

  {
    key: 'roles', part: 1, number: 4,
    title: 'Roles and permissions — who can see and do what',
    standfirst: 'Four levels, and two things that are gated for reasons worth knowing.',
    blocks: [
      { t: 'p', text: 'Everyone in Wren has a role. The role decides what the screens offer you, and Wren checks it again on the way in to every piece of information — so hiding a button is never the only thing standing between somebody and a record.' },
      { t: 'kv', rows: [
        ['Practitioner', 'Your key children and your room. Write observations, the diary, the register, sleeps, accidents, medicine. Read the plan and add to it. See your own shifts, absence, documents and CPD.'],
        ['Room leader', 'All of the above, plus the room. Approve the observations of anyone in your room who is not yet signed off to publish (below), and see the room’s trackers as a whole.'],
        ['Manager (floor)', 'Everything about practice and staffing across both rooms — supervisions, rota, absence, the trackers, the review queue. Hours, but not pay.'],
        ['Admin / Owner', 'The business as well: finance, payroll, pay, occupancy, the whole of Roost.']
      ] },
      { t: 'p', text: 'There are also apprentice, bank, supply and cook roles, which are narrower versions of practitioner. A cook, for example, can reach the kitchen and the menu and nothing else at all.' },
      { t: 'h', text: 'Two things are gated on purpose' },
      { t: 'p', text: '<b>Medicine.</b> Recording that you gave a child their medicine, and signing it off, are separate permissions and can be given to you individually rather than because of your job title. That is deliberate — competence with medicine is about training, not seniority. Ask if you need it and do not have it.' },
      { t: 'p', text: '<b>Safeguarding.</b> Anyone can log a concern, always, and nothing gets in the way of that. Reading other people’s concerns is separate, and most practitioners can see their own and not the rest. That is not about trust; a concern often contains information about a family that has nothing to do with the child in your room.' },
      { t: 'h', text: 'The publish permission' },
      { t: 'p', text: 'New and unqualified staff can write observations but cannot send them to parents directly. They go into a review queue, and a room leader or manager reads them, then either publishes them or sends them back with a note. Everything you wrote is kept exactly as you wrote it while it waits.' },
      { t: 'p', text: 'This is not a comment on anybody. It is the same moderation step EyLog had, and it comes off once you are signed off.' },
      { t: 'h', text: 'Pay' },
      { t: 'p', text: 'Nobody sees anybody else’s pay except the owner. Floor managers can open Payroll and see hours — the money columns are blanked for them by Wren itself, not hidden by the screen.' }
    ]
  },

  {
    key: 'security', part: 1, number: 5,
    title: 'Security and safety — including what is recorded about you',
    standfirst: 'Shared tablets behave differently on purpose, and yes, everything you click is logged.',
    blocks: [
      { t: 'h', text: 'The device gate' },
      { t: 'p', text: 'Nursery tablets are enrolled: Wren knows them and lets them at child records. A device that is not enrolled can be made to show the sign-in screen but cannot reach a single child’s record, even with a correct PIN.' },
      { t: 'p', text: 'This is why you cannot look at an observation on your own phone. It is not that we do not trust you — it is that a personal phone is outside the setting’s control. It gets lost, it gets lent to a child, it keeps working after somebody leaves.' },
      { t: 'warn', text: 'If a page on the tablet loads but every list on it is empty, and it worked yesterday, that is usually the device gate rather than a broken page. Tell somebody rather than reinstalling anything — it is a two-minute fix in the office.' },
      { t: 'h', text: 'Why a shared tablet is different' },
      { t: 'list', items: [
        'It signs you out after fifteen minutes of nobody touching it. On your own phone in HR it is an hour, because it is your device.',
        'It does not remember you. Every practitioner signs in with their own PIN, and everything they write is stamped with their name.',
        'It never asks whether to trust the device — that question only appears on personal devices, and only on HR.'
      ] },
      { t: 'h', text: 'What is recorded' },
      { t: 'p', text: 'This one deserves saying straight rather than burying: <b>every screen you open and every record you change is written down, with your name, the time, and what you did.</b> Not the content of what you were reading — the fact that you opened it.' },
      { t: 'p', text: 'Two reasons, and the second is the one that matters to you:' },
      { t: 'olist', items: [
        'A children’s setting has to be able to answer "who looked at this child’s record and when". That is a legal expectation, not a house rule.',
        'It is the only thing that can prove you were nowhere near a record when something went wrong. An unlogged system cannot exonerate anybody — it can only leave a question open.'
      ] },
      { t: 'p', text: 'Nobody reads that log casually and there is no report that ranks people by clicks. It gets read when there is a reason: a complaint, a safeguarding review, a data request from a family.' },
      { t: 'h', text: 'Photos' },
      { t: 'p', text: 'Always take the photo from inside Wren — the camera button on the observation or diary screen. It attaches straight to the right child, it is logged with your name, and it is the only route that ends up in the record.' },
      { t: 'p', text: 'Never use the tablet’s own camera app for a child, and never your own phone. A picture taken that way is somewhere Wren cannot manage, share correctly, or delete when a family asks us to.' },
      { t: 'warn', text: 'Being straight about one thing: tapping the camera button hands you to the tablet’s camera, and depending on the tablet that camera may keep its own copy in the device gallery as well. So the rule is not "Wren keeps it tidy for you" — it is that the nursery tablets are ours, they stay here, and nothing about a child is ever taken on a personal device.' },
      { t: 'p', text: 'One thing that happens without you doing anything: a photo a parent views is watermarked, at the moment it is served, with the account it was issued to. It does not stop a screenshot — nothing does — but a leaked picture can be traced back to who was shown it.' }
    ]
  },

  {
    key: 'offline', part: 1, number: 6,
    title: 'Offline — what happens when the wifi drops',
    standfirst: 'Observations and diary entries keep working. Most other things wait.',
    blocks: [
      { t: 'p', text: 'The garden, the far end of the pre-school room, and the corridor by the store cupboard are the usual places. Here is exactly what happens in each case, because "it just works offline" is not true and knowing which half is true is the useful thing.' },
      { t: 'h', text: 'Keeps working, and sends itself later' },
      { t: 'list', items: [
        'Writing an observation. It saves on the tablet and goes up as soon as there is signal. Photos go with it.',
        'Diary entries — meals, sleeps, nappies, bottles — written from the group screens.'
      ] },
      { t: 'p', text: 'These two have what Wren calls an outbox: a queue on the tablet itself. You will see a small count on Drafts telling you how many are waiting. You do not have to do anything; leave the tablet somewhere with signal and it empties itself.' },
      { t: 'shot', src: '/images/handbook/ey-drafts.png', caption: 'Drafts. Anything waiting to send shows here, with why.', href: '/ey/drafts' },
      { t: 'h', text: 'Still opens, but with yesterday’s information' },
      { t: 'p', text: 'Pages you have already visited will still load offline, from a copy the tablet kept. The page is real; the numbers on it may be a few hours old. There is no badge telling you that, so if you are offline and a figure looks wrong, it probably is.' },
      { t: 'h', text: 'Does not work offline' },
      { t: 'list', items: [
        'Signing in. Your PIN has to be checked against the server.',
        'Anything you have never opened before on that tablet.',
        'Sending a message to a parent, publishing an observation, marking the register.',
        'Anything that asks a question of the whole nursery — trackers, reports, occupancy.'
      ] },
      { t: 'warn', text: 'The one thing genuinely worth remembering: <b>do not sign out on a tablet that has entries waiting in the outbox.</b> They are safe across a sign-out and a restart, but they cannot send until somebody signs in again on that same tablet — and if that tablet then sits in a cupboard for a fortnight, so do they.' }
    ]
  },

  {
    key: 'notifications', part: 1, number: 7,
    title: 'Notifications — what Wren sends, and where',
    standfirst: 'There is a hard line: nothing that names a child ever goes to email.',
    blocks: [
      { t: 'p', text: 'Wren can tell you things three ways: the bell inside Wren, a push notification on a device you have allowed, and email. Which of the three you get depends on the kind of thing it is, and the third one has a rule you cannot switch off.' },
      { t: 'h', text: 'The email rule' },
      { t: 'p', text: 'You signed up with a personal email address. A personal inbox is outside this nursery’s control: somebody else may read that account, it is not covered by our retention rules, and it carries on existing after you leave. So the rule is not a preference you set — it is enforced by Wren, and it fails closed, meaning anything nobody has explicitly classified as safe does not get emailed.' },
      { t: 'kv', rows: [
        ['Can reach your email', 'Rota published or changed, shift reminders, absence requests and their outcome, forgot-to-clock-in, tasks, training and CPD due, supervision and probation dates, policies to sign, the staff newsletter.'],
        ['Never reaches your email', 'Anything about a child or a family. Parent messages, observations, progress updates, safeguarding, accidents, medicine, SEND, allergies, the room headcount, the doorbell.']
      ] },
      { t: 'p', text: 'The test is not "would this be useful in an email". It is "could this text ever name a child, a parent, or a concern". The staff newsletter is on the safe list, and even that is checked word by word against every child’s name before it sends — if a name is in there, the send is refused rather than trimmed.' },
      { t: 'h', text: 'The bell, and push' },
      { t: 'p', text: 'Everything else arrives on the bell inside Wren. Urgent things — a safeguarding concern logged, a ratio breach, the doorbell — can also go to Telegram for managers.' },
      { t: 'p', text: 'Push notifications on a tablet or phone are off until you turn them on, per device, in Nest → Settings. There is also a quiet-hours setting, so a notification raised at 11pm is held until the morning rather than lost.' },
      { t: 'h', text: 'Changing yours' },
      { t: 'p', text: 'Each category can be set to off, in-app only, in-app plus push, or a daily digest — per person, not per role. If you are getting something you do not want, that is a setting, not something you have to live with.' },
      { t: 'try', text: 'Turn push on for this tablet, or off for a category that is bothering you.', href: '/ey/settings', label: 'Nest → Settings' }
    ]
  },

  {
    key: 'parents-see', part: 1, number: 8,
    title: 'What parents can see — precisely',
    standfirst: 'The chapter everyone asks about. Here is the actual list.',
    blocks: [
      { t: 'p', text: 'Parents sign in to Finch and see one thing only: their own child. There is no view in it that shows another family, another child, or another child’s photo.' },
      { t: 'h', text: 'They can see' },
      { t: 'list', items: [
        '<b>Observations you have published</b>, with the photos attached to them and the next steps.',
        '<b>The diary</b> — meals, sleeps, nappies, bottles, the day as it happened.',
        '<b>The baby log</b>, for the baby room.',
        '<b>Records</b> — accidents involving their child, medicine given, sleep checks.',
        '<b>Progress updates</b> and the two-year check, once sent.',
        '<b>The plan</b> — this half-term’s theme, intentions, books and songs. Not a child-by-child version; the room’s plan.',
        '<b>Menu, events, newsletters, consents, absence reporting, surveys.</b>',
        '<b>Money</b> — invoices, statements, their balance, fee schedule, bookings, funding declaration.',
        '<b>Messages</b> — their own threads with the office or their key person.'
      ] },
      { t: 'h', text: 'They cannot see' },
      { t: 'list', items: [
        'Anything you write and do not publish. An unpublished observation is invisible to them, and so is one sitting in the review queue.',
        'Safeguarding concerns. Nothing about them appears in Finch at all.',
        'The register, the room headcount, or who else is in today.',
        'Trackers and framework statements — not the grid, not the statements, not the age bands.',
        'SEND flags and early concerns before somebody has reviewed them.',
        'Anything about staff — the rota, absence, notes, overtime, documents.',
        'Any other family’s anything.'
      ] },
      { t: 'h', text: 'The bit worth being careful about' },
      { t: 'p', text: 'Publishing is one-way and it is immediate. Un-publishing removes it from Finch, but a parent may already have read it and the email telling them about it has already gone. So the moment to check the wording is before you tap publish, not after.' },
      { t: 'p', text: 'And the plan is parent-visible. Write the plan as something a parent will read — because they will — and keep anything candid about a particular child in that child’s own record instead.' },
      { t: 'note', text: 'A practical consequence: if you want to record something for colleagues rather than for a family, write it as an observation and leave "share with parents" off. It stays in the child’s record and in the trackers, and the family never sees it.' }
    ]
  },

  {
    key: 'messaging', part: 1, number: 9,
    title: 'Messaging — and why it stays in Wren',
    standfirst: 'A parent may reply by email. Their reply still lands in Wren.',
    blocks: [
      { t: 'p', text: 'Messages between the nursery and a family live in Wren and nowhere else. Every one of them is kept, attributed, and readable afterwards. That is a safeguarding decision before it is a convenience one: a conversation with a parent about their child is a record, and a record in somebody’s personal WhatsApp is not a record at all.' },
      { t: 'h', text: 'How it works from your side' },
      { t: 'olist', items: [
        'Open the child, or Nest → Messages, and write. It goes into the thread for that child.',
        'The parent gets told — on the bell in Finch, and by email if that is their preference.',
        'If they reply in Finch, it appears in the same thread. If they reply <b>to the email</b>, it also appears in the same thread. They do not have to sign in to answer you, and you do not have to do anything differently.'
      ] },
      { t: 'p', text: 'That last part is the bit people do not expect. The email we send them carries a hidden address that belongs to that one thread, so a plain reply from their phone comes back into Wren rather than into somebody’s inbox.' },
      { t: 'h', text: 'What never leaves Wren' },
      { t: 'p', text: 'The message itself. When a parent messages you, the notification that reaches you says a message arrived — it never carries the text, and it never goes to your personal email. To read it you sign in. That is the same rule as chapter 7 and it has no exceptions.' },
      { t: 'h', text: 'What does go to your personal email' },
      { t: 'p', text: 'Your own working life: the rota when it is published, a shift change, your absence request being approved, training coming up, the staff newsletter. Nothing in that list can name a child, and Wren refuses to send it if it does.' },
      { t: 'h', text: 'Two more things' },
      { t: 'list', items: [
        '<b>Blocking.</b> Where a family must not be contacted by a particular member of staff, that is set in Wren and enforced on the way out — you will not be able to send, and you will be told why.',
        '<b>Attachments.</b> A photo you send in a message goes into the thread, not into an email. A parent has to sign in to see it.'
      ] },
      { t: 'note', text: 'If a parent asks you something you are not sure you should answer — anything about another child, anything about staff, anything legal or financial — the right move is to pass the thread to the office, not to answer carefully. Passing it on keeps it in the same thread and the parent sees no seam.' }
    ]
  },

  // ══════════════════════════════════════════════════════════════════════════
  // PART 2 — HOW TO USE IT
  // ══════════════════════════════════════════════════════════════════════════
  {
    key: 'observations', part: 2, number: 10,
    title: 'Observations and next steps',
    standfirst: 'What a good one looks like, and the two lines that make the difference.',
    blocks: [
      { t: 'p', text: 'An observation in Wren is: what you saw, optionally a photo, which areas of learning it touched, and what you will offer next. The last part is the one that turns a nice moment into teaching, and it is the part most often left empty.' },
      { t: 'shot', src: '/images/handbook/ey-obs-new.png', caption: 'The observation screen. Photo, what you saw, areas, next steps, and whether parents see it.', href: '/ey/observation/new' },
      { t: 'h', text: 'Two write-ups of the same five minutes' },
      { t: 'ab', a: {
          label: 'A',
          body: [
            '"Built a tower with the wooden blocks. Counted to 6 out loud as she stacked, then said “it’s going to fall” and moved the big block to the bottom without being asked. Tower stayed up. Went and got Amina to look at it."',
            'Areas: Maths, PSED, Communication and Language.',
            'Next step: offer the blocks again with a photo of a taller tower next to them, and see whether she plans the base first. Ask her to tell Amina how she did it.'
          ]
        }, b: {
          label: 'B',
          body: [
            '"Enjoyed playing with the blocks today. Good concentration. 😊"',
            'Areas: Maths.',
            'Next step: (empty)'
          ]
        } },
      { t: 'p', text: 'B is not a bad person’s observation, it is a busy person’s. But in three weeks nobody can do anything with it — including you. A is the same five minutes written in a way that survives.' },
      { t: 'h', text: 'The bits that matter' },
      { t: 'list', items: [
        '<b>Say what happened, not how it felt.</b> "Counted to 6 out loud" is evidence. "Good concentration" is an opinion with nothing under it.',
        '<b>Use their words.</b> A quoted sentence is worth a paragraph of summary.',
        '<b>One next step, and make it a thing you will do.</b> "Continue to encourage" is not a next step. "Offer the blocks again with a photo of a taller tower" is.',
        '<b>Tick the areas honestly.</b> Two or three real ones beat seven hopeful ones — and the trackers are only as good as this.'
      ] },
      { t: 'h', text: 'Next steps afterwards' },
      { t: 'p', text: 'Every next step you write becomes a live item against that child. It shows on their profile, it feeds the next planning cycle, and it shows up in your morning list until somebody does something about it. That is the loop — it is not filing.' },
      { t: 'h', text: 'Practical' },
      { t: 'list', items: [
        'Write it in the room, in the moment. Offline is fine (chapter 6).',
        'A group observation covers several children at once and writes one record each. Use it for a shared activity, not as a shortcut.',
        'If you are not yet signed off to publish, yours goes to a room leader first. Nothing you wrote is changed while it waits.'
      ] }
    ]
  },

  {
    key: 'planning', part: 2, number: 11,
    title: 'Planning — the plan is already written; your job is to make it about these children',
    standfirst: 'It arrives filled in. That is a starting point, not a fixture.',
    blocks: [
      { t: 'p', text: 'Each half-term has a plan, per room. It comes pre-filled from the setting’s own yearly planning — the same planning we have always had, now in Wren instead of in a folder. When you open next half-term you will already find:' },
      { t: 'list', items: [
        '<b>A theme.</b> Autumn 1 in pre-school is "All About Me".',
        '<b>Learning intentions</b> — five of them, in our own words. For example: "Support children’s personal, social and emotional development by helping them recognise and name different feelings."',
        '<b>Key books</b> — The Colour Monster, Elmer, Marvellous Me, The Skin You Live In, Something Else, My World Your World.',
        '<b>Songs</b> — the Hello Song, Head Shoulders Knees and Toes, If You’re Happy and You Know It, Tommy Thumb, and on.',
        '<b>Week-by-week activities</b>, and in the baby room the adult’s role for each day.'
      ] },
      { t: 'p', text: 'Wren says so on the week itself, in these words: <i>"Pre-filled from the setting’s yearly plan. Change anything here — it is a starting point, not a fixture."</i>' },
      { t: 'h', text: 'What you are expected to do to it' },
      { t: 'olist', items: [
        '<b>Put these children in it.</b> The yearly plan does not know that four of them are obsessed with diggers this month. Add the activities that follow what is actually happening in the room.',
        '<b>Pull in the next steps.</b> Wren gathers the next steps you have all written and offers them when the new half-term is drafted — so the plan can be built out of what the children actually need rather than out of last year’s plan.',
        '<b>Cut what will not happen.</b> A plan with three activities you will really do beats one with nine you will not.',
        '<b>Then publish it.</b> Until it is published it is a draft; publishing is what makes it visible to parents and what fixes it as this half-term’s plan.'
      ] },
      { t: 'shot', src: '/images/handbook/ey-termly-plan.png', caption: 'The termly plan. Theme, intentions, books, songs, and the weeks underneath.', href: '/ey/termly-plan' },
      { t: 'h', text: 'Drafts, and who sees what' },
      { t: 'p', text: 'A plan is a draft until somebody publishes it, and a draft is not parent-visible. Publishing moves one half-term — it does not push the whole year out. So you can be working on Spring 1 in the middle of Autumn 2 without a parent seeing a half-finished plan.' },
      { t: 'warn', text: 'The plan is parent-visible once published. Write it for a parent to read. Anything candid about an individual child belongs in that child’s record, not in the plan.' },
      { t: 'h', text: 'At the end of the half-term' },
      { t: 'p', text: 'There is an evaluation — one for the room, and one per child — and Wren will tell you when it is due. It is a short "did this work, what would we keep". It is also the only honest source for next year’s version of the same half-term.' }
    ]
  },

  {
    key: 'reports', part: 2, number: 12,
    title: 'Reports — progress updates, two-year checks, the summative',
    standfirst: 'Three different documents. Wren tells you which one is owed and when.',
    blocks: [
      { t: 'p', text: 'You do not have to remember any of this. Nest → Reports Due lists every child who is owed something, with the ones nobody has written at the top. Start there rather than from a list in your head.' },
      { t: 'h', text: 'The progress update' },
      { t: 'p', text: 'Once a half-term, per key child, following the Ealing term dates. Five sections: what went well last term, what we are working on this term, next steps, things to try at home, and the tracking data.' },
      { t: 'p', text: 'It is largely written for you from what is already in the child’s record — the observations, the next steps, the tracker. Your job is to read it as a parent would, change what is not right, add what only you know, and send it. It is not a form to fill from nothing.' },
      { t: 'p', text: 'There is a tracker for these, so it is visible who has sent theirs and who is late. That is deliberate and it is not aimed at you — the reason it exists is that "everyone is behind" and "two people are behind" need completely different responses.' },
      { t: 'h', text: 'The two-year progress check' },
      { t: 'p', text: 'Statutory, once, between two and three. Wren drafts it from the child’s record and puts it in a review queue; the key person reads it, edits it, signs it and sends it to the family. It covers communication and language, physical development, and personal social and emotional development, and it has to be something a health visitor can read.' },
      { t: 'h', text: 'The summative / transition report' },
      { t: 'p', text: 'When a child moves room or leaves for school. Nest → Reports → Summative. It is the "here is this child" document for whoever gets them next.' },
      { t: 'h', text: 'The termly review' },
      { t: 'p', text: 'Different thing, same time of year: a short per-child review with your room leader that feeds the next plan. It is a conversation with a record, not a document for parents.' },
      { t: 'h', text: 'Two things that will save you an hour' },
      { t: 'list', items: [
        '<b>Write observations properly during the term and the reports write themselves.</b> The generated draft is only as good as what is in the record. A term of "enjoyed playing outside" produces a report that says nothing, and then you write it from scratch in an evening.',
        '<b>Do not wait for the deadline to open the draft.</b> Opening it in week two of the half-term tells you what is missing while there is still time to go and see it.'
      ] },
      { t: 'try', text: 'See who is owed what, right now.', href: '/ey/reports-due', label: 'Nest → Reports Due' }
    ]
  },

  {
    key: 'daily', part: 2, number: 13,
    title: 'The daily stuff — register, diary, sleep, medicine, accidents',
    standfirst: 'The five things that happen every day, and where each one lives.',
    blocks: [
      { t: 'h', text: 'The register' },
      { t: 'p', text: 'Who is expected, who is here, who has gone. Nest → Child Register. It is also what the ratio calculation reads, so a child marked in who went home two hours ago is not a paperwork problem, it is a ratio problem.' },
      { t: 'h', text: 'The diary' },
      { t: 'p', text: 'Meals, sleeps, nappies, bottles, toileting. Two ways in, and both write the same records:' },
      { t: 'list', items: [
        '<b>Per child</b> — open the child, add the entry. Right when one child needs something noting.',
        '<b>Per group</b> — the + button, then Diary, then the routine. Right when you have just changed six children.'
      ] },
      { t: 'p', text: 'The diary is what parents read at pick-up, so it is worth being specific. "Ate most of the pasta, left the peppers" tells a parent something. "Good lunch" does not.' },
      { t: 'h', text: 'Sleep' },
      { t: 'p', text: 'Sleep checks are timed and each one is stamped with who did it. Nest → Sleep Chart shows the room at a glance. Do the check, then record it — not a batch of six at the end, which is both wrong and obvious in the record.' },
      { t: 'h', text: 'Medicine' },
      { t: 'p', text: 'Two people, always: one gives it, one signs it off. Wren enforces that as two separate permissions and two separate actions (chapter 4). Recording it is part of giving it, not paperwork afterwards.' },
      { t: 'h', text: 'Accidents' },
      { t: 'p', text: 'The + button → Accident. What happened, where on the body, what you did, who was told. It goes to a manager to sign off, and the parent sees it in Finch once it is signed.' },
      { t: 'warn', text: 'Three separate things, three separate places, and people mix them up: an <b>accident</b> happened to a child; a <b>safeguarding concern</b> is a worry about a child; a <b>setting incident</b> happened to the building or the session — fire, intruder, a leak, a near miss, a child briefly unaccounted for. All three are on the + button. If in doubt, log it as the one you think it is and say so — a wrongly-filed record that exists beats a correctly-filed one that does not.' },
      { t: 'h', text: 'The + button' },
      { t: 'p', text: 'Everything above is behind the same + in the bottom bar: diary, observation, medicine, accident, safeguarding, setting incident, report. If you are looking for where to log something, that is the answer.' },
      { t: 'p', text: 'Everything <i>else</i> is under More, grouped by what you came to do — My Day, Children, Planning, Reports, CPD, Safeguarding, Messages, the Setting, Help. There is a search box at the top of it: four letters is faster than scrolling.' },
      { t: 'shot', src: '/images/handbook/ey-more.png', caption: 'More, grouped. Type in the box at the top if you know what you want.', href: '/ey/more' }
    ]
  },

  // ══════════════════════════════════════════════════════════════════════════
  // PART 3 — THE CURRICULUM, AND A REAL QUESTION
  // ══════════════════════════════════════════════════════════════════════════
  {
    key: 'curriculum', part: 3, number: 14, fledge: true,   // fledge-off (2026-10-26): shown only while the Fledge switch is on (ey/handbook.html)
    title: 'Fledge, our planning, and the gap between them',
    standfirst: 'This is the chapter Toby wants answered. Read it even if you skip the others.',
    blocks: [
      { t: 'quote', who: 'Toby, September 2026', text: 'Our Fledge framework … it just seems like it’s not really that different from Birth to Five Matters … it doesn’t really tell them how we’re learning or what we’re learning. It just says what they should be learning by the end of it.' },
      { t: 'p', text: 'He is right, and it is worth being precise about why, because the fix is not to write more statements.' },
      { t: 'h', text: 'What Fledge actually is' },
      { t: 'p', text: 'Counted, not guessed: <b>158 statements</b> across the seven EYFS areas, in five age bands. Every one of them describes something a child can do by the end of a band. (There were 177 — the extra 19 were a "Fledge Profile" nobody used, now retired.)' },
      { t: 'p', text: 'There is a field in it for the Characteristics of Effective Learning — the part that would say <i>how</i> children learn: playing and exploring, active learning, creating and thinking critically. It is filled in on <b>none</b> of them. The one dimension in Fledge that is about how rather than what-by-when is empty.' },
      { t: 'h', text: 'The distinction that matters' },
      { t: 'kv', rows: [
        ['An assessment framework', 'Describes destinations — what a child can typically do by a point in time. Its job is to help you notice whether a child is where you would expect.'],
        ['A curriculum', 'Describes the journey — what THIS setting has decided to teach, in what order, and how. Its job is to make sure the destinations are reached on purpose rather than by luck.']
      ] },
      { t: 'p', text: 'Fledge is the first one. We have been reading it as if it were the second, and finding it thin — because for that purpose it is. This is also the most common criticism of settings at inspection: using an assessment document as the curriculum.' },
      { t: 'h', text: 'The thing that has been missed: we already wrote the curriculum' },
      { t: 'p', text: 'Our termly plans hold, for every half-term of this year and both rooms: a theme chosen for these children, intentions in our own words, key books, songs, week-by-week activities, and in the baby room the adult’s role per day.' },
      { t: 'p', text: 'That is a curriculum. It has content, it has sequence, it names the pedagogy. What is missing is not the curriculum — it is the <b>connection</b>. Fledge sits in one place describing outcomes; the plan sits in another describing teaching; nothing joins them. So the plan looks like activities for their own sake, and Fledge looks like a checklist nobody can act on.' },
      { t: 'coming', text: 'Three things have since been <b>drafted and are waiting for Toby</b>: half a page per room on what a child should leave us able to do, a place on the pre-school plan for the adult\u2019s role, and a proposed characteristic for every statement. None of it is agreed \u2014 the question below is the part nobody has decided.' },
      { t: 'h', text: 'Two ways to write next term\u2019s intentions' },
      { t: 'p', text: 'The intentions have to be written either way \u2014 the same work in one of two orders. Here is a real one from pre-school Autumn 1, done both ways.' },
      { t: 'ab', a: {
          label: 'A \u2014 Our words first, then tag it',
          body: [
            'You write the intention the way you always have: <i>\u201cSupport children\u2019s personal, social and emotional development by helping them recognise and name different feelings.\u201d</i>',
            'Then you tick the two or three Fledge statements it is aiming at \u2014 here, PSED-B3-3 \u201cnames basic feelings in themselves and in pictures\u201d and PSED-B4-3 \u201ctalks about feelings, what caused them, and what helps\u201d.',
            'From then on, every observation written against those statements counts as evidence for that intention. The plan stays in our words; Fledge becomes the proof.',
            'Cost: about twenty minutes per half-term per room, at the point where somebody is already writing the intentions.'
          ]
        }, b: {
          label: 'B \u2014 Fledge first, then the how',
          body: [
            'You start from the framework: for this half-term, in PSED, we are going for PSED-B3-3 and PSED-B4-3.',
            'Then under each one you write how \u2014 <i>\u201cThe Colour Monster at circle time, feelings jars, name the feeling you see and wait.\u201d</i>',
            'The tracker is joined up from the first minute and nothing has to be tagged afterwards. The wording of the intention is the framework\u2019s, not ours.',
            'Cost: about the same twenty minutes, spent choosing statements instead of writing sentences.'
          ]
        } },
      { t: 'p', text: 'A risks never getting tagged; B risks the plan sounding like a document rather than like us. You will do it either way, which is why you are being asked.' },
      { t: 'note', text: 'Not on the table: scrapping Fledge, or writing more statements. The seven areas are what everyone here understands.' }
    ]
  },

  // ══════════════════════════════════════════════════════════════════════════
  // PART 4 — WHAT CHANGES WHEN WE GO LIVE  (policy, not software)
  // ══════════════════════════════════════════════════════════════════════════
  {
    key: 'meetings', part: 4, number: 15,
    title: 'The rota carries meetings, and they are mandatory',
    standfirst: 'A change to how we work, not a feature.',
    blocks: [
      { t: 'p', text: 'From go-live, room meetings appear on the rota like any other part of a shift. They are inside your paid hours, they are planned in advance so cover exists, and they are not optional.' },
      { t: 'h', text: 'Why this is being made explicit' },
      { t: 'p', text: 'Because the alternative has been tried. A meeting that depends on there being a quiet moment does not happen, and then the things that need a room to agree on them — what we are doing about a child, what changed in the plan, what somebody learned on a course — get decided in a corridor by whoever is standing there.' },
      { t: 'p', text: 'Putting it on the rota is what makes it real. It also means nobody has to choose between the meeting and the floor: if it is rostered, the cover is rostered too.' },
      { t: 'h', text: 'What a room meeting is for' },
      { t: 'list', items: [
        'The children we are worried about, and what each of us is doing this week.',
        'What is coming up in the plan, and what needs preparing.',
        'Anything one of us has learned that the rest of us should know — including the deep-dive reading (chapter 18).',
        'Anything that is not working. This is the part that most often gets skipped and most often matters.'
      ] },
      { t: 'h', text: 'What it is not' },
      { t: 'list', items: [
        'It is not a supervision. Supervisions are one-to-one, private, and separate.',
        'It is not a handover. Handovers happen at the change of shift and are about today.',
        'It is not somewhere to raise something about a colleague. That goes to a manager.'
      ] },
      { t: 'h', text: 'The record' },
      { t: 'p', text: 'Somebody writes down what was discussed, what we decided to change, and who was there. Two or three lines is enough. It goes into Wren, it counts towards CPD for everybody present, and it means the next meeting can start with "did we do the thing we said".' },
      { t: 'p', text: 'The question below is genuinely open: half an hour weekly, or an hour fortnightly. Both are the same time. They are not the same meeting.' }
    ]
  },

  {
    key: 'off-ratio', part: 4, number: 16,
    title: 'Off-ratio time is CPD time',
    standfirst: 'Wren can see when we are over ratio. The spare adult is not spare.',
    blocks: [
      { t: 'p', text: 'Wren works out the required ratio for each room from who is booked in and how old they are, and compares it to who is actually clocked in. It knows, hour by hour, when we have more adults than we need.' },
      { t: 'p', text: 'That happens more than you might think. On most weekdays there is a period where a room is over ratio — usually the middle of the day.' },
      { t: 'h', text: 'The change' },
      { t: 'p', text: 'On a day we are over ratio, the priority for the extra adult is <b>CPD and training</b>. Not tidying, not laminating, not a job that could be done at any time. That is what the spare adult is for from now on, and it is what the time is being protected for.' },
      { t: 'h', text: 'Why' },
      { t: 'p', text: 'Two reasons, both honest:' },
      { t: 'olist', items: [
        'It is the only training time that does not cost anybody an evening. Everything else — courses at home, twilight sessions, reading in your own time — comes out of your life. This does not.',
        'It is the difference between a setting that says it values development and one that can show when it happens. If it is never on the clock, it never happened.'
      ] },
      { t: 'h', text: 'How you will know it is your turn' },
      { t: 'p', text: 'It will be visible — a manager will say so, or it will be on the rota. You are not expected to work out the ratio yourself and take yourself off the floor.' },
      { t: 'h', text: 'What counts' },
      { t: 'list', items: [
        'A course, or part of one — the CPD section tracks where you got to.',
        'The deep-dive reading for this half-term (chapter 18).',
        'Writing something you have been putting off that needs thought rather than speed: a progress update, a two-year check, an action plan.',
        'Shadowing somebody in the other room. This one is undervalued and costs nothing.'
      ] },
      { t: 'warn', text: 'What does not count: catching up on the diary or the register. Those are the job, not development — and if they are only possible in off-ratio time, that is a staffing problem to raise, not a training plan.' }
    ]
  },

  {
    key: 'pop-up-cpd', part: 4, number: 17,
    title: 'Pop-up CPD',
    standfirst: 'Short, unannounced, in the room. Starting with Safeguarding and Prevent.',
    blocks: [
      { t: 'p', text: 'A pop-up session is ten or fifteen minutes, in the room, without warning. One question or one scenario, discussed properly, then everyone goes back to the floor.' },
      { t: 'h', text: 'The first two topics' },
      { t: 'list', items: [
        '<b>Safeguarding.</b> Not the annual certificate — the actual thing. You have a worry about a child. What do you do in the next ten minutes, who do you tell, what do you write, and what do you do if the person you would normally tell is the person you are worried about.',
        '<b>Prevent.</b> The duty is real and it is the one everybody is least confident about. What it actually asks of us, what it does not, and what it looks like in a nursery rather than in a secondary school.'
      ] },
      { t: 'h', text: 'Why unannounced' },
      { t: 'p', text: 'Because the point is what you know now, not what you can revise. Safeguarding knowledge you have to look up is not safeguarding knowledge — the moment it matters, there is no time to look anything up.' },
      { t: 'p', text: 'It is not a test and there is no pass mark. Nobody is written down as having got something wrong. The only thing that gets recorded is that the session happened and who was in it, which goes to your CPD record.' },
      { t: 'h', text: 'What it will feel like' },
      { t: 'p', text: 'Honestly: mildly annoying the first time, because it interrupts. That is the cost, and it is being chosen deliberately over the alternative, which is a whole-team session everybody has to be released for and which therefore happens once a year.' },
      { t: 'p', text: 'If you are the only adult in a room with children, the session waits. Nothing about this comes before ratio.' },
      { t: 'h', text: 'After it' },
      { t: 'p', text: 'Anything a session shows we are collectively unsure about becomes something Toby does properly — a full session, a change to a policy, or a deep dive (chapter 18). A pop-up finding that goes nowhere would make the next one pointless.' }
    ]
  },

  {
    key: 'deep-dive', part: 4, number: 18,
    title: 'The termly deep dive',
    standfirst: 'One topic a term, gone into properly.',
    blocks: [
      { t: 'p', text: 'Each half-term has one theme. A short read each week — fifteen minutes, one page, not a journal article — and the following week’s room meeting discusses the one before. At the end of the theme the room evaluates it, and each of us signs off individually. It goes into your CPD record as what it is: real, dated, evidenced development.' },
      { t: 'h', text: 'Why a term, and one thing' },
      { t: 'p', text: 'Because a day’s course on a Saturday changes nothing by Wednesday. Six weeks on one idea, discussed with the people you work next to, changes the room. That is the whole bet.' },
      { t: 'h', text: 'How it runs' },
      { t: 'olist', items: [
        'The theme is set for the half-term and is visible from the start — no surprises, and you can read ahead if you want.',
        'One short read a week. You can do it in off-ratio time (chapter 16).',
        'Next week’s room meeting discusses last week’s read. That one week’s delay is on purpose: it means everyone has had time, and nobody is reading it in the meeting.',
        'At the end: what did we change, and what would we keep. Then sign off.'
      ] },
      { t: 'h', text: 'Once a term as well' },
      { t: 'p', text: 'A short quiz — safeguarding and the EYFS — taken in the rooms. Same principle as the pop-ups: it is about what we know now, and what it finds becomes what gets taught next. It is recorded per question, not as a mark out of fifteen, because "everybody got question 9 wrong" is useful and "the average was 11" is not.' },
      { t: 'h', text: 'The last word' },
      { t: 'p', text: 'You have reached the end of eighteen chapters, which is more than most people will. Thank you — genuinely. The question below is the last one, and then there is a Submit button.' },
      { t: 'p', text: 'Everything you have said goes to Toby with your name on it, and the reason he wants your name on it is so he can come and ask you more about it. That is the point of the whole exercise.' }
    ]
  }

  ];

  return { version: 'b312-2026-09-10', parts: PARTS, chapters: CHAPTERS };
});
