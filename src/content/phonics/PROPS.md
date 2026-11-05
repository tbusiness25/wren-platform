# Wren phonics — shared prop/creature survey (b381, updated b382, b384, b385)

Built by reading the `illustration` brief on every page of all 43 story files
and listing every non-cast creature, person and object any brief names.
Grouped as the b381 brief asked. **done** = drawn in `illustration-kit.js`
(`PROPS`) this batch. **to draw** = still needed by a later batch — check this
file before inventing a duplicate.

Three new poses were added to `POSE_LIBRARY` (limb/tilt/lift only, no new
geometry): `pull` (leaning back with effort — Ned's wellington boot), `huff`
(puffed/indignant, limb out), `listen` (head-cocked, limb up to the ear).

One new palette pair was added: `red` / `red_deep` — a true bright red for
every brief that names the colour "red" specifically (bell, wig, hat, boat,
fish, ladybird), distinct from the warmer orange-brown of `brick`. Contrast
checked the same way as every other token (see illustration-tokens.json).

## b382 — animal redraws, a flip bug, and 16 new props

Books 3, 6, 7, 8's contact sheets were reviewed and four of b381's animal
props read wrong at a glance ("an insect", "an orange oval with a dot eye",
"a brown blob", "only reads as a cow because of the spots"). All four were
**redrawn in place** (same function names, same call signature, so no scene
file needed to change): `dog`, `goat`, `fox`, `cow` — see each function's own
comment in `illustration-kit.js` for exactly what was wrong and what changed.
The common fix across all four: give every creature the 2-3 features a child
actually names it by (muzzle/snout, ears, horns, visible legs with hooves/
paws), built the same way as the cast (bold outline, flat fill, one eye) —
not an ellipse with details stuck on.

**A real bug surfaced while fixing the fox**: `goat`/`fox`/`cow`/`fish` each
read `o.flip` and mirrored their OWN coordinates with it, but
`renderScene`'s `drawProp` ALSO mirrors the whole placed group whenever a
prop's own `flip: true` is set. Both firing together cancels out to **no
visible flip at all** — which is why `the-dark-farm` page 5 ("the fox
trotting away... glancing back") never actually turned around. Fixed by
dropping the internal self-flip from all four functions; they now draw one
fixed orientation and rely purely on the scene's own `flip`, the same
convention `boat`, `corn`, `dog` and every CAST character already use. If you
add a new directional creature prop, do NOT read `o.flip` inside it — just
draw it facing one way and let the scene mirror it.

One new pose: `lean` (leaning hard into a headwind, still standing — limb/
tilt only, same six knobs as every other pose). One new backdrop:
`dusk_earth` (dusk sky over bare soil, for a night page whose ground is dug
earth rather than grass — keeps the sky consistent instead of forcing a
daytime backdrop just because the ground is earth; fixed `the-owl-and-the-
cow` page 6, which was oddly daytime in an otherwise all-night book).

**Fig is a red bug** (14-fig-in-the-sun, page 3) could not be solved by
recolouring Fig — the cast-identity check requires his body to be
byte-identical in every book, in every pose. Solved with a new prop,
`heat_tint`: a translucent colour wash placed as a FRONT-layer prop directly
over the character, never touching his own geometry. Reused the same way for
"caked in mud" on 13-nell-and-the-bell's last two pages (key: `earth`
instead of `red`). See DEPARTURES.md.

New props this batch (16): `frost` (radiating fern-like hairlines — a frost
crystal close-up, or scattered along a grass/pond edge), `twig_snap` (a
clean break with two ends and a small frost spray), `mud_splash` /
`mud` (the `splash`/`puddle` shapes, re-toned earth-brown for mud pages
instead of water), `hay_bales` (three round bales, stacked), `paddling_pool`
(a raised-rim pool, distinct from a ground-level `puddle`), `ivy_nest`
(Pip's own nest, ivy-leaf trim — distinct from the generic twiggy `nest`),
`den` (a cutaway earth den under a root, dry hollow interior), `nut` (a
hazelnut), `bell` (a small red hand bell on a string), `wig` (a cluster of
overlapping curls — reads as "curly wig" without one detailed silhouette),
`quiz_card` (paper + a big tick, never a letter), `jam_bun` (bread + glossy
jam), `fig_fruit` (the FRUIT — a purple teardrop, not to be confused with
Fig the caterpillar), `oak_hollow` (a cutaway tree-trunk cavity), `leaf_single`
(one pointed oval leaf with a centre vein — added when book 6 page 2's
"close on a leaf" read as an unclear bush blob instead), `fuss` (a radiating
starburst of lines for a tantrum/commotion that needs to read as "bigger
than the character having it" — no new pose geometry needed).

## b384 — books 25-32, a documentation gap closed, and four props that didn't read at first attempt

**b383 gap closed first.** b383 was assigned books 17-24 and its session was killed by a
600s background-task timeout before it finished: `illustration-kit.js` already carries its
props (pig, hen, crab, ant, stallholder, pie, bunting, tent, big_wheel, chair_swing,
corn_cob, party_hat, twig, hive, bow_tie, dune, sandwich, teacup, book_prop, wave, the
`sea_day` backdrop, the `sprawl`/`spin` poses), but **no scene files exist for books 17-24,
no NOTES.md, no contact sheets, and this file was never updated to say any of that work
existed.** This batch (b384) only verified and documented what b383 actually built (see the
rows above now marked "done (b383) — drawn b383, not yet placed in a scene") — it did NOT
author scenes for books 17-24; that is still open and needs a re-queue.

**Two still-broken batch-2 props, fixed.** The b384 brief's review notes said bell and wig
still didn't read right after b382 ("a red blob with a dot under it", "a cluster of red
circles"). Checked against the live code first (per the brief's own "verify, don't redraw
twice" instruction) — they genuinely were still broken, b382's PROPS.md entry described the
intent but the shapes didn't deliver it. Both redrawn in place this batch: `bell` is now an
actual flared bell silhouette with a wooden handle and a visible clapper inside a dark open
rim; `wig` is now one dome silhouette with a scalloped curl fringe and a visible underside,
not six loose circles. Also fixed the two bare-paper ("plain" backdrop) pages the same review
flagged: 09-ned-in-the-frost p2 and 15-nell-and-the-wig p1 now use a real backdrop
(`meadow_day` + `wind_lines`, and `garden_day`, respectively). Section 2's other two smaller
fixes (book 6 p2 leaf, book 7 p8 sun position) were checked against the current code and were
**already correct** (leaf_single and the sun's y already clear the horizon) — no action needed.

**Four new props failed their own contact-sheet review and were redrawn before shipping**,
following the same bar the b382/b383 animal redraws set — "would a 3-year-old name it
correctly with no words?":
- `hoe` — the first version (a vertical post with a rounded rect on top) read as a **street
  sign**. Redrawn with the blade low, flat and angled, the way a real tool holds its blade,
  not a plaque mounted high on a post.
- `haul_net` (taut state) — the first version was a thin rope and a tiny underwater arc that
  vanished at thumbnail size, reading as **a stick in a pond**, not a net. Redrawn with a
  big, solid, visibly meshed bag and a rim hoop.
- `deer` — two attempts. The first (thin hairline legs, dead straight and symmetric) read as
  a generic spindly-legged bug. The second (bent hairline legs) still read as a static
  insect-like animal. The third — FILLED angled leg slivers with small hoof dots, a slim
  elongated body (not the round cow/pig barrel), and a filled neck wedge connecting a small
  head to the body (so the head never floats) — finally reads as a running deer.
- `child` — the first version drew the lap/torso and the head as two disconnected shapes
  with a visible gap between them (a "floating head"). Redrawn so the torso/lap shape
  overlaps the head circle by several units in every pose.

New props this batch (24): `child` (generic person, reusable for "a boy" later), `tug`
(Moss's toy tugboat — no sail, distinct from Ned's `boat`), `branch`, `washing_line`,
`grass_flat`, `flowerpot`, `window`, `picnic_cloth`, `crisp`, `plum_fruit`, `wasp` (narrow
and pointed — never confusable with Nell), `sun_hat`, `paw_print` (4 toes + heel, distinct
from the 3-toe bird `footprint`), `claw`, `cat` (`lying`/`yawn`), `stew_pot` (`o.empty`),
`steam`, `spoon`, `pea`, `bowl`, `hoe`, `furrow`, `deer`, `haul_net` (`taut`/`landed`),
`motion_arc`. One new pose: `crawl` (limb/tilt/lift only). Small additive parameters on
existing props: `boat` gained `o.hullKey`/`o.sailKey`/`o.chipped`/`o.reflection`; `footprint`
gained `o.key` (an earth-toned mud-print variant, for 31-toes-in-the-mud's "great muddy
prints" next to the deer's clean ones); `renderScene`'s `drawProp` now passes through an
`o.opacity` for a faint/imagined/distant version of a prop (used once: 29-paws-by-the-pond's
"a faint fox shape suggested in the shadows" — never for recolouring a cast member, see
`heat_tint`/DEPARTURES.md for that case).

**Not this batch's job, flagged for whoever does it:** `stallholder` (b383, used nowhere yet)
has the same head/torso gap shape `child` had before its redraw — worth checking when
19-fun-at-the-fair is finally scened.

## b385 — books 33-43 (the last batch; every book now has a scene file), 14 new props

Books 33-43 are now all scened and rendered, which means **all 43 books / 352 pages have
authored art** — check-illustrations.js passes 54/54 across every illustrated book, and
`booklet.js` no longer falls back to `autoScene` for any page. Books 17-24 remain the one
exception flagged by b384 (drawn props, no scenes authored yet, no NOTES) — not this batch's
job, still open.

New props this batch (14): `garden_gate` (a single-panel wooden gate on a post with a visible
rusty hinge — distinct from the wide horizontal-rail `farm_gate`), `jam_jar` (small empty held
glass jar), `frog` (bulging eyes raised clear of the body is the one cue that separates it from
a blob, same lesson the b382 animal redraws established), `picture_card` (`o.icon: 'cat'` — a
small drawn icon on a paper card, never a letter), `bench` (wooden garden bench, side-on),
`acorn`, `petal_single` (a single petal, distinct from the full `flower`), `scratch_mark` (a
bare diagonal scratch in earth — deliberately not shaped like any letter), `crate`
(`o.tipped` for lying on its side, same dark-open-end convention as `tin`), `dish` (shallow
white china, one paint-chip nick), `cake` (a lopsided cake on its own leaf plate — see
DEPARTURES-style note below), `duck` (a generic non-cast duck, a different body tone from
Ned's cast gold on purpose), `kite` (`o.string`/`o.coil`/`o.muddy`), `phone` (`o.screen:
'ring'|'blurry'|'child'` — the `'child'` state calls `PROPS.child` from inside `PROPS.phone`,
which works because a later object-literal entry can reference an earlier one by the time
either is actually invoked — the object is fully built before any prop function runs).

**No new poses were needed.** Every b385 brief was coverable with the existing 20-pose
library — `sprawl` for a comic tumble/collapse (including "asleep upside down, feet in the
air", which the rig cannot literally draw — there is no lying-on-back knob, only tilt/lift
around the feet, so inventing one risked a worse result than reusing a pose already proven to
read as "undignified heap"), `listen` for "wings clamped over his ears", `pull` for leaning
hard against a kite string, `hop` for one-foot-lifted business. Worth recording so nobody
re-derives this: the pose rig has covered 43 books' worth of briefs without needing to grow
past 20.

**"Her name spelled out in seeds" (41-the-cake-on-the-lake) cannot be drawn literally** — the
absolute no-letters-or-words rule overrides the brief, the same precedent `quiz_card` and
`party_hat` already set. The cake's seeds are a fixed decorative scatter, never legible text.

**A near-total occlusion bug, caught by checking character/prop coordinates programmatically,
not just by eye.** 43-the-blue-phone p5 originally placed Olive and a phone prop almost
exactly on top of each other (the two-panel brief needs her foot ON the phone's screen); since
`renderScene` draws back-layer props before characters, Olive's body completely hid the phone
underneath her. Fixed by offsetting her position so her foot overlaps the phone's edge instead
of its centre. Worth the general lesson: before trusting a contact sheet alone, diff every
(character x,y) against every non-front prop's (x,y) in the same scene and eyeball any pair
closer than ~40 units — the failure mode is invisible in a thumbnail grid until you know to
look for it.

Three two-panel briefs (35-moss-and-the-rhyme-pot p3, 40-boxes-and-bushes p5,
43-the-blue-phone p5) are drawn as ONE combined picture rather than a literal split frame —
the kit has no panel/divider mechanism, and a single composed scene reads fine for this age.

## b383 (completed 2026-10-02) — books 17-24 finally scened, two latent bugs fixed, one pose swapped

The original b383 session (earlier the same day) drew all the props this batch needed (pig,
hen, crab, ant, stallholder, pie, bunting, tent, big_wheel, chair_swing, corn_cob, party_hat,
twig, hive, bow_tie, dune, sandwich, teacup, book_prop, wave, the `sea_day` backdrop, the
`sprawl`/`spin` poses) but was killed by the runner's background-task timeout before it could
author a single scene file — see the b384 entry above. This session picked that up: wrote all
8 scene files (71 pages), rendered, and fixed what the automated checks and the contact sheets
caught.

**Two latent bugs, caught the same way DEPARTURES.md §6 describes** — `check-illustrations.js`
can only test what has actually been rendered, and nothing in books 17-24 had been until now:
- `stallholder`'s head floated 26 units above its own torso (the same "floating head" bug
  `child` had before its b384 redraw — this file already flagged it as "worth checking when
  19-fun-at-the-fair is finally scened," and it was still there). Fixed in place: the head
  circle now overlaps the torso by 6 units, same convention `child` uses.
- `wave`'s foam highlight stroked plain `white` instead of `white_deep`, failing WCAG 3:1 on
  both grounds `by-the-sea` (the first scene ever to use it) paints behind it. Fixed to
  `white_deep`, the tone every other highlight in the kit already uses for this reason.

**`sprawl` does not work on every character.** It was tuned for Ned (normally upright) tumbling
sideways into "flat". Applied to Fig — whose resting posture is already horizontal, lying along
the ground — the same absolute 78° rotation turns him up onto his tail instead of down onto his
back (the-big-pie p5/p6, first attempt). Switched Fig to `curl` for "lying down/resting" briefs
instead; no kit change, just a per-character pose choice worth recording so a later batch
doesn't reach for `sprawl` on a horizontal-bodied character and get the same surprise.

**Composition fixes made only by looking at the contact sheets, not caught by any check:**
- A held/carried prop (`twig`, `corn_cob`, `party_hat`, `bow_tie`) placed at the character's
  nominal ground `y` reads as two unconnected objects, not "held", whenever the character's own
  pose lifts it well clear of that line — `nell_bee` is the extreme case (always +42, often
  +70-112 more from her pose). Fixed on sight across the-best-nest and nells-long-trip by moving
  the prop up to where the character actually draws, not its ground line.
- `pond_day`'s pond ellipse covers nearly the whole ground band right up to the horizon line
  (only a few px of grass clears it) — characters placed at typical pond-side x/y coordinates
  render as if they are standing in the water. down-by-the-pond p5 ("a pair of hens... on the
  bank") needed the hens moved onto the strip of grass left of the ellipse, outside its x-range.
- `sea_day` has no sand strip of its own — the sea rect paints straight over the whole ground
  band from the horizon down. Any "on the beach" brief needs an explicit `dune` prop in the
  foreground (the same device the reveal pages already used) or the characters read as floating
  in open water, not sitting on sand (by-the-sea p5, first attempt).
- A corn-cob pile drawn as 3 cobs stacked close together vertically, not spread horizontally,
  merges into a plaid/basket-weave pattern rather than reading as individual cobs
  (fun-at-the-fair p6) — spread with real gaps between them, same lesson as every other "pile of
  several of the same prop" composition in this file.
- The barn has no interior — scaling it up to fill the frame for a "dark inside the barn" brief
  just shows its exterior facade (doors, windows) at a larger size, not an interior. The-big-farm's
  three barn-interior pages (2, 3, 8) drop the barn prop entirely for a dark `dusk_earth` ground
  with `light_shaft` + `hay_bales` standing in for "dark, strawy, farm" rather than attempting an
  interior the kit has no geometry for.

All 8 books (71 pages) pass `check-illustrations.js` (62 checks, 0 failures, across all 352
pages in the whole scheme) and were reviewed on contact sheets in `ladn-ready/logs/b383-contact/`.

## Creatures (non-cast)

| name | done | used in (this batch) | also needed later |
|---|---|---|---|
| dog (Dot) | **done** — `PROPS.dog`, poses sit/squashed/dig/sleep (redrawn b382 — visible legs, muzzle, a real floppy ear) | 03-dot-the-dog | reusable wherever a big dog fits |
| fish | **done** — `PROPS.fish` (b382: no longer self-flips, see above) | 05-ned-and-the-fish | — |
| beetle | **done** — `PROPS.beetle` | 06-rain-on-the-oak | — |
| ladybird | **done** — `PROPS.ladybird` | 02-pip-and-the-tin, 34-nells-noisy-hive | — |
| goat | **done** — `PROPS.goat` (redrawn b382 — curved horns + beard + solid legs, was reading as an insect) | 06-rain-on-the-oak | — |
| fox | **done** — `PROPS.fox` (redrawn b382 — proper head, pointed ears, snout, white-tipped tail) | 07-the-dark-farm | 29-paws-by-the-pond (imagined shadow only — may not need the full creature) |
| cow | **done** — `PROPS.cow` (redrawn b382 — muzzle with nostrils, small horns, solid legs with hooves) | 08-the-owl-and-the-cow | 10/18-down-by-the-pond ("Ned can hear a cow" — distant/background) |
| pig | **done** (b383) — `PROPS.pig` | 17-the-big-farm | — |
| hen | **done** (b383) — `PROPS.hen` | 17-the-big-farm, 18-down-by-the-pond ("a pair of hens") | — |
| crab | **done** (b383) — `PROPS.crab` | 24-by-the-sea | — |
| deer/doe | **done** (b384) — `PROPS.deer`, running silhouette, `o.col` | 31-toes-in-the-mud | — |
| ants (line of) | **done** (b383) — `PROPS.ant` | 22-nells-long-trip | — |
| wasp | **done** (b384) — `PROPS.wasp`, deliberately narrow/pointed so it is never confusable with Nell | 28-lunch-on-the-grass | — |
| cat (tabby) | **done** (b384) — `PROPS.cat`, poses `lying`/`yawn` | 29-paws-by-the-pond | — |
| frog | **done** (b385) — `PROPS.frog`, bulging eyes raised clear of the body | 35-moss-and-the-rhyme-pot, 37-the-longest-day | — |
| second duck | **done** (b385) — `PROPS.duck`, generic non-cast, `o.col` (default 'white' — never Ned's gold) | 41-the-cake-on-the-lake | — |

## People

| name | done | needed in |
|---|---|---|
| child (generic, girl) | **done** (b384) — `PROPS.child`, poses `sit`/`stand`/`wave`/`laugh`, `o.skin`/`o.hair`/`o.shirt` | 26-the-bird-and-the-girl | reuse for "a boy" with different tones |
| stallholder (corn seller) | **done** (b383) — `PROPS.stallholder` (floating-head bug fixed b383, see above) | 19-fun-at-the-fair | — |
| boy (on a phone screen) | **done** (b385) — reuses `PROPS.child` (pose `laugh`) scaled down inside `PROPS.phone`'s own screen, no separate geometry | 43-the-blue-phone |

## Garden set

| name | done | used in |
|---|---|---|
| log (mossy) | **done** — `PROPS.log` | 04-fig-and-the-fuss, reusable (lunch-on-the-grass, fig-in-the-sun, etc.) |
| vegetable_patch | **done** — `PROPS.vegetable_patch` | 04-fig-and-the-fuss |
| shed | **done** — `PROPS.shed` | 02-pip-and-the-tin (background) |
| doormat | **done** — `PROPS.doormat` | 03-dot-the-dog |
| doorstep | **done** — `PROPS.doorstep` | 03-dot-the-dog |
| hole (dug) | **done** — `PROPS.hole` | 03-dot-the-dog, reusable for every digging book (moss-digs, the-big-haul) |
| tin (biscuit) | **done** — `PROPS.tin`, pose side/up | 02-pip-and-the-tin |
| ivy nest | **done** — `PROPS.ivy_nest` (b382) | the-loud-sound | the-best-nest |
| checked picnic cloth | **done** (b384) — `PROPS.picnic_cloth` | 28-lunch-on-the-grass |
| flowerpot (terracotta, chipped) | **done** (b384) — `PROPS.flowerpot` | 27-fun-in-the-wind, 31-toes-in-the-mud; reusable moss-and-the-rhyme-pot |
| bench (wooden garden) | **done** (b385) — `PROPS.bench` | 35-moss-and-the-rhyme-pot (Moss's home is under it) |

## Pond set

| name | done | used in |
|---|---|---|
| fishing_net | **done** — `PROPS.fishing_net` | 05-ned-and-the-fish |
| bubble | **done** — `PROPS.bubble` | 05-ned-and-the-fish |
| boat (toy, optional sail) | **done** — `PROPS.boat` | 06-rain-on-the-oak; reusable for 25-the-toy-boat |
| rainbow | **done** — `PROPS.rainbow` | 06-rain-on-the-oak |
| rain (shower) | **done** — `PROPS.rain` | 06-rain-on-the-oak; reusable for 16-rain-and-the-moon |
| toy tug (Moss's) | **done** (b384) — `PROPS.tug` (no sail, a boxy cabin — distinct from Ned's sailing `boat`) | 25-the-toy-boat |
| wooden chair (left outdoors) | **done** — `PROPS.chair` | 08-the-owl-and-the-cow; reusable down-by-the-pond |
| coin | **done** — `PROPS.coin` | 08-the-owl-and-the-cow; reusable down-by-the-pond |
| paw print / claw (in mud) | **done** (b384) — `PROPS.paw_print` (4 toe pads + heel, distinct from the 3-toe bird `footprint`), `PROPS.claw` | 29-paws-by-the-pond |
| net + rope (big haul) | **done** (b384) — `PROPS.haul_net`, `o.state: 'taut'\|'landed'` — a visible mesh bag on a rope, bigger than the handheld fishing_net | 32-the-big-haul |

## Farm set

| name | done | used in |
|---|---|---|
| barn | **done** — `PROPS.barn` | 07-the-dark-farm; reusable the-big-farm, the-owl-and-the-cow (background) |
| farmhouse | **done** — `PROPS.farmhouse`, `lit` option | 08-the-owl-and-the-cow |
| farm_gate | **done** — `PROPS.farm_gate` | 07-the-dark-farm, 08-the-owl-and-the-cow |
| corn (stalk, w/ cob) | **done** — `PROPS.corn` | 07-the-dark-farm (field), 17-the-big-farm (field) |
| corn cob (standalone, lying) | **done** (b383) — `PROPS.corn_cob`, distinct from the standing field `corn` | 19-fun-at-the-fair (stall + Nell astride one) |
| beehive (skep) | **done** (b383) — `PROPS.hive` | 22-nells-long-trip |
| rock/boulder | **done** — `PROPS.rock` | 07-the-dark-farm; reusable by-the-sea, the-toy-boat |
| welly_boot | **done** — `PROPS.welly_boot` | 07-the-dark-farm |
| hay bales | **done** — `PROPS.hay_bales` (b382) | a-sunny-day |
| paddling pool | **done** — `PROPS.paddling_pool` (b382) | a-sunny-day |
| crate/box (nut) | **done** (b385) — `PROPS.crate`, `o.tipped` for lying on its side | 40-boxes-and-bushes |
| dish (china) | **done** (b385) — `PROPS.dish` | 40-boxes-and-bushes |

## Fair / seaside / home sets (not needed this batch — none of books 2-8 touch them)

| name | done | needed in |
|---|---|---|
| bunting / fairground tents / big wheel / chair-swing | **done** (b383) — `PROPS.bunting`/`PROPS.tent`/`PROPS.big_wheel`/`PROPS.chair_swing` | 19-fun-at-the-fair |
| picnic sandwich, flask/tea cup | **done** (b383) — `PROPS.sandwich`, `PROPS.teacup` | 24-by-the-sea |
| dune | **done** (b383) — `PROPS.dune` | 24-by-the-sea |
| sandcastle | to draw if a future brief needs it — no book 17-43 names one | — |
| phone (mobile) | **done** (b385) — `PROPS.phone`, `o.screen: 'ring'\|'blurry'\|'child'` | 43-the-blue-phone |
| hoe (garden tool) | **done** (b384) — `PROPS.hoe` | 31-toes-in-the-mud |
| kite | **done** (b385) — `PROPS.kite`, `o.string`/`o.coil`/`o.muddy` | 42-five-white-kites |
| cake (on a leaf plate) | **done** (b385) — `PROPS.cake` (includes its own plate) | 41-the-cake-on-the-lake |
| pie (dish) | **done** (b383) — `PROPS.pie`, `o.cut` | 23-the-big-pie |
| stew pot | **done** (b384) — `PROPS.stew_pot`, `o.empty` | 30-the-new-stew |
| book (storybook prop) | **done** (b383) — `PROPS.book_prop` | 24-by-the-sea |
| quiz card, jam bun | **done** — `PROPS.quiz_card`, `PROPS.jam_bun` (b382) | nell-and-the-wig |
| acorn | **done** (b385) — `PROPS.acorn` | 36-olives-sound-game |
| petal (single), scratch mark, picture card | **done** (b385) — `PROPS.petal_single`, `PROPS.scratch_mark`, `PROPS.picture_card` (`o.icon: 'cat'`) | 36-olives-sound-game, 35-moss-and-the-rhyme-pot |

## Weather / sky (beyond what the kit already has)

Existing kit already covers: sun, cloud, moon, star, dusk backdrop. Added this
batch: `rain` (shower), `rainbow`. Still to draw: frost dusting (a decorative
sparkle overlay for frost-on-the-pond / ned-in-the-frost — not needed yet,
those two books reuse the `puddle`/ice idea via the water token on a flattened
ellipse, no new prop required so far), breath-cloud puffs (reuse the existing
`cloud()` prop scaled small — no new entry needed).

## Decisions / departures from a literal brief reading

- **Dot the dog** is drawn via `PROPS.dog`, not `CAST`, per the brief's own
  instruction ("a prop creature, not a cast member"). She is exempt from the
  identity/silhouette checks that govern the six cast — only the cast's
  silhouette-uniqueness is enforced by `check-illustrations.js` §3.
- Introduced the `red`/`red_deep` token pair rather than approximating "red"
  with the existing `brick` tone, because five+ future briefs (bell, wig, hat,
  boat, fish) explicitly call the colour "red" by name and `brick` reads as
  orange-terracotta, not red.
- `corn` is one stalk with a cob+husk, meant to be placed several times for a
  field/row — no separate "cornfield" prop, to keep it composable at any
  density a scene needs.
- Every new stroke colour used is an *already-proven* `_deep` token (or the
  new `red_deep`, checked the same way) — never a fresh hex — so no new prop
  needed its own contrast review beyond the one `red` pair.
