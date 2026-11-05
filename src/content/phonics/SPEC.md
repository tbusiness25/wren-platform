# Wren Phonics content-pack spec (b157)

Read this fully before writing any content file. You are authoring part of **Wren's own
free phonics scheme** — an original alternative to Read Write Inc / Jolly Phonics / Little
Wandle / Monster Phonics, built for Your Nursery / the Wren product.

## Hard IP rule — read first, this is non-negotiable

Every mnemonic phrase, character, formation cue, action and story element you write must be
**wholly original** — invented by you for this task. Do NOT reproduce, closely paraphrase, or
lightly reskin any element of an existing commercial phonics scheme. Specifically banned,
even in disguised form:

- **Read Write Inc (Ruth Miskin):** Fred the Frog / Fred Talk / Fred Fingers, "Speed Sounds",
  any of its specific mnemonic phrases (e.g. do NOT write anything like "slither like a
  snake" for s, or "pretend to eat, monkey" for m — these are RWI's actual mnemonics).
- **Jolly Phonics:** Inky Mouse, Snake in the Grass, Bouncy Ben, its songs/story mnemonics,
  its specific action set.
- **Little Wandle:** its grapheme characters, phrase "my turn, your turn", its specific
  wording.
- **Monster Phonics:** colour-coded monster characters tied to specific graphemes.
- **Letterland:** its named alphabet characters (Annie Apple, Bouncy Ben, etc).

If you're unsure whether something is "too close", don't write it — invent something
different instead. Judge originality by: different character concept, different phrase,
different physical action, different formation cue wording. Reusing the general IDEA that a
sound has a mnemonic character + action + formation cue is fine (that's the genre); reusing
any SPECIFIC scheme's actual content is not.

The DfE Letters & Sounds **phase structure** and standard **GPC teaching order**
(s a t p i n m d g o c k ck e u r h b f ff l ll ss, then j v w x y z zz qu ch sh th ng, etc.)
are public/government material — use those freely, they're just sequencing, not creative content.

## Wren's three phases (use these labels, not "Phase 1/2/3" alone — always pair with the name)

1. **Introduction** (pre-school; DB `phase=1`) — the 7 listening aspects. No letters yet.
2. **Learning** (Reception; DB `phase=2,3,4`) — GPCs in standard order + tricky words.
3. **School Readiness** (Y1/Y2; DB `phase=5,6`) — alternative spellings, suffixes/prefixes.

## Fixed vocabulary for `character` fields — DO NOT invent new motif/color/accessory keys

You choose from these; a small Node script renders the actual SVG from your choices, so pick
values that suit the sound (e.g. `bee` for a buzzing sound, `raindrop` for a soft sound) —
but the exact visual doesn't need to literally match your mnemonic, use judgement.

- `motif` (pick exactly one): `wren_bird, robin, owl, sparrow, duckling, egg, nest, feather,
  leaf, acorn, seed, raindrop, sun, cloud, snail, ladybird, butterfly, caterpillar, mushroom,
  pinecone, star, bee, flower, hedgehog`
- `color` (pick exactly one): `gold, sky, leaf, coral, plum, teal, sunflower, berry, sage,
  sand, sea, rose`
- `accessory` (pick exactly one): `spots, stripe, tuft, none`

Try to vary motif+color combinations across your batch so neighbouring sounds don't look
identical (a little repetition across the full ~140-item pack is fine and expected — there
are only 24 motifs — but avoid using the exact same motif+color pair twice within your own
file if you can help it).

## Tone

Warm, simple, nursery/Reception-appropriate English. Short sentences. No jargon. This is read
by parents and 2–7 year-olds' key workers, not phonics specialists.

## JSON schema — GPC catalog entries (phase2/3/4/5/6 files)

Each entry (one per grapheme, in the exact order given to you — do not add, remove, reorder,
or rename graphemes; the `grapheme` value must exactly match the DB `sound_code` you were given):

```json
{
  "grapheme": "s",
  "phase": 2,
  "wren_phase": "learning",
  "sound_type": "grapheme",
  "position_in_phase": 1,
  "ipa": "/s/",
  "pronunciation_note": "Pure sound only, e.g. 'sss' not 'suh' — say it short and don't add a vowel on the end.",
  "mnemonic": "One or two original short sentences/rhyme lines that help a child remember the sound. Must reference the character below.",
  "character": { "name": "Original name", "motif": "one of the fixed motifs", "color": "one of the fixed colors", "accessory": "one of the fixed accessories", "blurb": "One original sentence describing this character and how it connects to the sound." },
  "formation_cue": "Original description of how to form the letter shape by hand — different wording/imagery from any commercial scheme.",
  "example_words": ["sat","sun","sit"],
  "action": "One original physical action a child does while saying the sound (distinct from RWI/Jolly Phonics actions)."
}
```

`sound_type` is one of `grapheme`, `digraph`, `trigraph` — use exactly what's given to you per
grapheme (it's already correct in the source list, just copy it over).

For phase 4 (in "Learning") and the tricky-word batches you're given a mix of GPCs (adjacent
consonant clusters like `bl`, `nd`) and `tricky_word` entries — tricky words go in the
**separate** `tricky-words.json` format below, not the GPC format.

## JSON schema — tricky words file

```json
{ "word": "the", "phase": 2, "wren_phase": "learning", "tip": "One original sentence — what's 'tricky' about this word and a simple way a child can spot/remember it. Do not invent a character/mnemonic phrase that duplicates a known scheme's tricky-word teaching." }
```

## JSON schema — Phase 1 (Introduction) aspects file

One entry per aspect, using EXACTLY these 7 `code` values (already used elsewhere in the
product, do not rename): `environmental_sounds, instrumental_sounds, body_percussion,
rhythm_and_rhyme, alliteration, voice_sounds, oral_blending`.

```json
{
  "code": "environmental_sounds",
  "name": "Listening Walk",
  "description": "One friendly sentence for parents/staff explaining this aspect.",
  "games": [
    { "title": "Original game name", "how_to_play": "2-3 sentences, concrete and practical for a nursery room or garden.", "duration_mins": 5 },
    { "title": "...", "how_to_play": "...", "duration_mins": 5 },
    { "title": "...", "how_to_play": "...", "duration_mins": 5 }
  ]
}
```
Use the exact `name` values already chosen by the product for these 7 (so parent-facing and
staff-facing text agree): environmental_sounds="Listening Walk", instrumental_sounds="Instrument
Sounds", body_percussion="Body Percussion", rhythm_and_rhyme="Rhythm & Rhyme",
alliteration="Alliteration", voice_sounds="Voice Sounds", oral_blending="Oral Blending & Segmenting".
Write your own `description` (can closely match the spirit of the existing one, doesn't need
to be verbatim) and 3 wholly original games per aspect.

## JSON schema — character cast file (characters.json)

6 recurring original characters used across decodable stories (nature/nursery-world theme,
Wren is a bird-themed product — lean into that but you don't have to make all 6 birds).

```json
{
  "characters": [
    { "id": "short_slug", "name": "Original Name", "species": "original species/creature description", "personality": "1 sentence", "home": "where they live in the story world, 1 sentence", "motif": "fixed motif key", "color": "fixed color key", "accessory": "fixed accessory key" }
  ]
}
```

## Output

Write ONLY the JSON file(s) you were asked for, to the exact path given. Valid JSON, no
trailing commas, no comments in the actual JSON files (comments are only allowed in this
spec/markdown). Double-check your `grapheme`/`word`/`code` values exactly match the source
list you were given — nothing added, nothing missing, nothing reordered.
