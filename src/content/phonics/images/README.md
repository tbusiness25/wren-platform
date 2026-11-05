# Wren Phonics — character artwork

Drop a character illustration in this directory, then set that character's
`image` field in `../characters.json` to the **bare filename**, e.g.:

```json
{ "id": "moss_hedgehog", "name": "Moss", "image": "moss_hedgehog.png", ... }
```

Editing `characters.json` needs a server restart (the content pack is cached at
first load). Once `image` is set, the file itself is checked per request — so
adding or replacing the actual artwork is picked up live, no restart.

Until `image` is set AND the file exists, the API returns `image_url: null` and
the UI falls back to the generated line-icon motif (`svg/cast-<id>.svg`). There
is deliberately **no placeholder artwork** — an obvious gap beats a fake
illustration.

`image` also accepts an absolute path (`/uploads/...`) or an `https://` URL,
which are passed through untouched.

Every character also has an `image_alt` art brief in `characters.json` — that
text doubles as the `alt` attribute and as the commissioning note.

## Spec for commissioned art
- **Format:** PNG with transparent background (SVG also fine).
- **Size:** 512×512, character centred with ~8% padding, no cropping at edges.
- **Pose:** as described in that character's `image_alt`.
- **Style:** must read at 40px (the story-reader icon size) as well as full size.
