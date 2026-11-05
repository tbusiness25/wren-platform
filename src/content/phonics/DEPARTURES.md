# Wren phonics illustrations — departures from the style guide (b248)

The brief's rule: **if the style guide and the drawings ever disagree, the style
guide wins.** Everything below is a case where that rule was applied — the guide
was changed deliberately, or a drawing was allowed out on a stated exception.
Nothing here was left as a silent inconsistency.

`illustration-tokens.json` is the guide. `scripts/phonics/check-illustrations.js`
enforces it and fails the build on a violation.

---

## 1. The cast is six, not "four or five"

**The brief asked for four or five recurring characters. There are six.**

Not a drift — the cast already existed. `characters.json` (b157) defines Pip, Ned,
Olive, Moss, Fig and Nell, and all 43 books were written against them: the story
files name them in `characters`, `proper_nouns_allowed` lists all six as legal
words in the decodable text, and their names are woven into titles and sentences
("Nell and the Bell", "Moss Digs", "Fig in the Sun").

Cutting to five would mean rewriting books, not dropping a drawing. The brief's
real requirement — *a small cast a child recognises book after book* — is met at
six. The drawings therefore match `characters.json` exactly: same ids, same
species, same palette keys, so the book art and the existing line-icon set
(`svg/cast-*.svg`) are recognisably the same creatures.

## 2. There is no night sky. Evening is drawn as dusk.

The palette originally carried `night` (`#33477a`). It was removed.

At any genuinely dark night value, the cast's warm brown outlines cannot reach
WCAG 3:1 against the sky — measured, not guessed: the best case tested was
1.72:1, and it gets worse as the sky gets darker. Passing would mean giving every
character a light rim that appears in night scenes only, which is exactly the
kind of "same character, drawn differently" inconsistency this build exists to
prevent.

`dusk` (`#a8b8e4`) clears 3:1 against every outline in the set, and reads as
evening to a 3-year-old once a moon and stars are in it — which is how picture
books for this age draw night anyway. Books 7 (*The Dark Farm*) and 16 (*Rain and
the Moon*) will use it.

## 3. Twelve palette tones were darkened for contrast

The first palette was chosen to look bright. Eleven of its "deep" outline tones
then failed WCAG 3:1 against bare earth (`#deac71`), the lightest ground the
books use, and `brick_deep` failed against its own brick fill at 2.57:1.

All were darkened until they cleared, and each carries the reason in its `role`
field. The bodies were **not** dulled — only the outlines went darker, so the art
is exactly as saturated as before and now legible for a child who needs it.

Worst surviving case: `#7d4e05` on `#deac71` = **3.46:1**.

## 4. Three stroke widths, plus three that are fills

The guide says three line weights and no others. Three shapes are drawn as a
thick round-capped *stroke* rather than a filled path — the bee's belly bands
(11) and the tap's spout (17 outer / 10 inner).

These are fills expressed as strokes, not line weights. They are declared in
`line.fill_stroke_widths`, and the checker knows the difference: it exempts them
from the outline-contrast rule while still refusing any width that is not one of
the six declared numbers.

## 5. Illustrations contain no text at all

Stronger than the guide requires. The typography token exists to describe the
words *around* the picture; no SVG contains a `<text>` element, so no font can
fail to embed and no stray glyph can appear inside a phonics book and be read as
a word by a child decoding the page.

Sound is drawn instead — the taps in book 1 are spreading rings in a puddle, not
letters.

## 6. Three more latent bugs surfaced once books 2-8 rendered (b381)

`check-illustrations.js` can only test what has actually been rendered. Books
2-43 were all auto-composed stand-ins until b381 authored real scenes for
books 2-8 — the first time Fig, Nell and Moss were ever rendered outside the
"meaning never by colour alone" unit check, and the first time their *own*
outline-vs-fill contrast was measured on a real page. Three pre-existing bugs
came up immediately and were fixed, not worked around:

- Fig's and Nell's antenna-tip dots were drawn `solid(X_deep, X_deep)` —
  stroke and fill the same hex, a 1:1 "outline" that was always invisible.
  Changed to `solid(X, X_deep)` like every other marking.
- `berry_deep` (Moss's outline) only ever cleared 3:1 against the *grounds*,
  never against its own fill `berry` — 2.70:1. Darkened from `#8c1f45` to
  `#6e1734` (3.52:1 against its own fill; every ground contrast only improved).

None of this is a departure from the style guide — it is the guide's own rule
being enforced for the first time against art that didn't exist before.

## 7. Pip's tail crosses the horizon on page 1

Allowed, deliberately. A character large enough to fill the page will overlap the
horizon line; that is correct depth, not a clipping bug. The geometry check
enforces the real rule — **no character may cross the frame** — and permits props
and horizons to pass behind a character.

## 8. "Fig is a red bug" — a colour wash, never a recolour (b382)

14-fig-in-the-sun's text states Fig turns red in the heat. He cannot actually
be drawn red: the cast-identity check (§4 of check-illustrations.js) asserts
every character's body is byte-identical across every pose, expression and
book, and that is enforced, not a style suggestion.

Solved with a new prop, `heat_tint` — a translucent colour ellipse placed as
a scene prop, in the FRONT layer, directly over the character. Fig's own
geometry never changes; the page just looks warmer. The same prop, with
`key: "earth"` instead of `"red"`, does the same job for 13-nell-and-the-
bell's "caked in mud" pages. Any future "a character looks a different
colour for a moment" brief should reach for this prop rather than proposing
a recolour.

## 9. goat/fox/cow/fish no longer read their own `o.flip` (b382)

b381 gave four creature props an internal `s = o.flip ? -1 : 1` to mirror
their own asymmetric geometry (a snout, a tail) when a scene set `flip:
true`. `renderScene`'s `drawProp` ALSO mirrors the whole placed prop group on
that same `flip: true` — so both fire together and cancel out, leaving the
creature facing its original way regardless of what the scene asked for.
This was invisible while these creatures were still shapeless blobs (see §10
below), but became obvious once they had a head to tell direction from:
the-dark-farm page 5 ("the fox trotting away... glancing back") was never
actually turning around.

Fixed by removing the internal flip from all four functions — they draw one
fixed orientation now and rely only on the scene's own `flip`, exactly like
`boat`, `corn`, `dog` and every CAST character already do. A later batch
adding a new directional creature prop should follow that convention, not
reintroduce the self-flip.

## 10. The b381 goat/fox/cow/dog redraws (b382)

Claude's review of b381's contact sheets found four animal props unreadable
at a glance: the goat ("an insect — white oval, stick legs, antennae-like
horns"), the fox ("an orange oval with a dot eye"), Dot the dog ("a brown
blob; legs barely visible, no clear ears/tail"), and the cow ("only reads as
a cow because of the spots; the head is a circle"). All four were redrawn in
place — same function name, same call signature in every scene that already
used them, so no scene file needed to change. Each now carries the 2-3
features a child actually names the animal by: dog = muzzle + floppy ear +
visible legs with paws; goat = curved horns + beard + legs with hooves; fox
= a proper head + pointed ears + long snout + white-tipped tail; cow =
muzzle with nostrils + small horns + legs with hooves. See each function's
own comment in `illustration-kit.js` for the exact fix.
