# GRYND Player Icons — Visual Specification

**Status:** Reference for asset generation (ComfyUI pipeline, external to the app runtime)
**Canonical format for generation:** 1024 × 1024 PNG (master)
**Canonical format for production:** single 512 × 512 WebP per icon, served at `/icons/<key>.webp`
**Section reference:** architecture lives in `src/lib/iconAssets.ts`, `src/lib/icons.ts`, `src/components/IconAvatar.tsx`, schema `icons` / `user_icons`.

> This document defines the **visual contract** for official Grynd player icons.
> It is intentionally precise so that any icon produced later can be checked
> against the same rules and passes the same Quality-Control checklist.
> It does not license or reproduce any other game's artwork.

---

## 1. Purpose

Grynd player icons are the official cosmetic **avatars** that replace traditional
profile pictures. A user owns one or more icons (`user_icons`) and equips exactly
one (`users.selected_icon`); the app renders that icon everywhere it used to show
a profile picture:

- next to usernames (navigation bar)
- on player profiles (`/profil`, `/profil/[clerkId]`)
- in friends lists / friend search / invites
- in chat
- in PvP lobbies and match player panels
- on leaderboards
- (future) in the shop and cosmetic/inventory screens

Because of this, every icon must be **instantly recognizable at 64 × 64 px** and
must still look deliberate and premium at larger sizes. Recognizability at small
size is the single most important requirement of this system.

---

## 2. Overall Art Direction

The intentional style is a union of two inspirations treated as **general
principles, not copies**:

> "Brawl-Stars-style **readability and bold 2D game-icon presentation** combined
> with the polished, detailed, premium **fantasy/sci-fi illustration quality**
> associated with League of Legends."

Pulled together for Grynd it resolves into one sentence:

> **A bold, high-contrast, hero-centered 2D icon with a strong readable
> silhouette, painted with rich, premium fantasy/futuristic rendering that reads
> as valuable and 'collectible'.**

Precise definition:

- **Illustration style:** stylized digital painting (never photoreal photography). Semi-realistic materials on top of a simplified, graphic-friendly shape language.
- **Rendering style:** hand-painted / digital-oil look with confident brushwork; glossy and luminous where materials allow (metal, energy, crystal), soft where organic (flesh, cloth, skin). A subtle painterly finish, never flat vector fills and never muddy AI mush.
- **Linework:** minimal or no outline on interior forms; a soft rim-light edge is preferred over a hard black contour. Where a contour is used for readability it must be thin (≈2–3 px of 1024) and colored (darker shade of the local fill), never a heavy uniform black outline.
- **Shapes:** large, simple, clearly separated masses. Few "hero shapes" per icon (head, helmet, mask, energy core, focal object), not dozens of small decorative bits.
- **Proportions:** character/creature icons are head-and-shoulders or bust emphasis (see Composition); object icons are one dominant object filling most of the safe zone. Exaggerate proportions that read: oversized eyes/visor/core, broad shoulders, big single focal detail.
- **Level of detail:** MEDIUM. Enough texture and material richness to feel premium at 128 px, but always fewer details than can be counted at 64 px. Details funnel toward the focal point; the rest stays clean.
- **Lighting:** dramatic, single dominant light source from the upper-left (key), with a strong colored **rim/edge light** and a deep ambient falloff toward the lower-right. Standard "hero" three-point look.
- **Shading:** strong value separation. Define form with at least 3 readable tones (light / mid / dark shadow) on every major mass; never mush all values into one.
- **Color treatment:** saturated, game-friendly, high-key focal colors against cooler supporting colors. One clear accent (often the Grynd neon cyan or gold) to anchor the icon. Values must separate against both the icon's own background and the app's dark navy surfaces.
- **Materials:** recognizably rendered — polished metal, faintly glowing energy/crystal, matte armor, cloth/leather. Material contrast (glossy vs matte) is a deliberate readability tool.
- **Visual depth:** clear foreground / midground / background layering. The subject reads first; background supports, never competes.
- **Silhouette:** the icon must have a **strong, simple, instantly parsable silhouette** — you should recognize it as a filled black shape.
- **Facial expression (characters only):** confident, expressive, or menacing-set; never blank and never grotesque. A single clear expression communicates the personality.
- **Overall mood:** competitive, energetic, futuristic-casino showmanship — bold and confident with a premium "collectible" finish. Think stage-light hero pose.

---

## 3. Brawl-Stars-Inspired Characteristics (legitimate, general)

We use only general, genre-wide principles — **no specific Brawl Stars characters,
names, or assets**:

- Strong, exaggerated silhouettes that read at thumbnail size.
- Bold, colorful, game-y rendering with pleasant, saturated palettes.
- A single dominant focal subject placed up front and big.
- Big readable features (eyes/visors/cores/iconic objects) even at small scale.
- Expressive, personality-forward designs.
- Crisp separation between the subject and anything behind it (clear edge / rim light).
- Compositions that stay centered and stable rather than sprawling.

These are the "readability engine" of the style.

---

## 4. League-Inspired Characteristics (legitimate, general)

We use only general, premium-illustration principles — **no specific League of
Legends characters, splashes, or assets**:

- Sophisticated, polished subject design with coherent armor/wear/accessory logic.
- Rich, hand-painted materials (metal, cloth, leather, energy, stone, crystal).
- Dramatic, directional lighting with strong rim light and ambient occlusion.
- A fantasy/sci-fi sense of world and character — the icon feels like it belongs to a real, designed universe.
- A "premium collectible" finish: controlled detail, confident color grading, professional finish.

These are the "premium engine" of the style.

---

## 5. Grynd-Specific Identity

The icon must read as **Grynd**. Grounded in the existing application UI:

**Palette (values already used by the app):**
- **Base surfaces:** deep navy / royal blue (`#030817`, `#071536`, `#003b8e`, `#050b1f`, card `#0b224f`, `#003366`, `#004080`). Icons should feel at home on these.
- **Primary neon:** **cyan `#00e5ff`** — the site's signature accent (also the default profile accent `DEFAULT_PROFILE_ACCENT`). Cyan is the go-to energy/glow color for Grynd.
- **Primary CTA / action yellow:** **`#f5ff3b`** — use sparingly for high-energy secondary glow.
- **Premium / win / VIP gold:** **`#FFD700`** (avatar border on profiles is `#FFD700`; gold frames; win badges).
- **Supporting neon accents (already in `ACCENT_COLORS` / frames):** emerald `#34d399`/`#059669`, fuchsia `#f0abfc`/`#d946ef`, crimson `#f43f5e`/`#9f1239`, violet/royal `#a78bfa`/`#4f46e5`, amber `#facc15`, mint `#00ffa6`, neutral `#e2e8f0`.

**Recurring motifs to weave in (not all at once):**
- Neon **cyan rim/edge light** as the signature energy glow (matches `0 0 24px rgba(0,229,255,…)` glow everywhere).
- **Futuristic casino / tournament** flavor: visors, HUD-like seams, gem/inlay accents, crown/rank nods, faint hexagonal or "grid" energy (the app uses a cyan cyber-grid overlay `cyberpunk-grid`).
- A competitive, "here for the trophy" attitude.
- Contrast against navy: icons should carry a mid-to-light dominant value so they never vanish into a dark navy card.

**Lighting:** upper-left key + **cyan glow** accent + gold-hot highlights for premium tiers (mirrors the app's neon-glow language).

**Materials bias:** brushed/glossy metal, dark matte armor, glowing cyan crystal/energy cores, and gold/brass trim — a "cyber-tournament" material language.

**Mood:** bold, showy, premium, competitive. It should look like a trophy-class cosmetic for a neon casino platform.

---

## 6. Composition

- **Canvas:** square, 1024 × 1024.
- **Display crop:** the app renders icons as **circles** (`rounded-full`, `object-cover`), so the square's corners are always clipped away. Design for the **visible inscribed circle**, not the square.
- **Safe zone:** keep the **primary subject fully inside the central ~70%** of the canvas (a circle of ~700/1024 diameter centered at 512,512). Background may fill the outer 15%.
- **Subject placement:** centered. Vertical bias center-high (slight optical centering so the head/object sits a touch above true center and feels grounded, not top-heavy).
- **Subject scale:** subject width ≈ 55–70% of canvas width; subject + surrounding glow/effect ≤ 85% width. Big enough to read at 64 px, small enough to never touch the circular crop edge.
- **Background treatment & separation:** a stylized backdrop (see §7) must visually recede (darker, lower saturation, softer) so the subject pops. Never a busy background.
- **Acceptable cropping:** cropping by the circular avatar mask is expected and acceptable **only** in the outer band (the outer ~15%). Nothing important may be cropped — keep all key features within the safe circle.
- **Faces/helmets:** eyes/visor and identity-defining features must sit inside the safe circle, never near the top edge where the circular mask and the top of the square both threaten them.

---

## 7. Background

**Recommended default for Grynd: an opaque, stylized radial-gradient backdrop
(key-dark → ambient accent), NOT transparent.**

Rationale:
- Icons are circular-cropped onto many dark navy surfaces (nav bar, chat, lobbies, profiles). An opaque backdrop guarantees the icon reads identically on every surface and avoids transparency over text or UI.
- It reinforces the "premium emblem" collectible feel.

Rules:
- Center of the backdrop slightly behind the subject (a soft glow field), dark navy/charcoal at the outer edges (`≈ #050b1f` to `#0b224f` family).
- One restrained accent haze (cyan, gold, or a rarity tint) near the subject's rim light.
- Background must be **lower contrast and lower saturation** than the subject.
- For an entire set, keep the backdrop **language consistent** (same gradient build / haze placement) so the set looks unified. Minor per-icon hue shifts are encouraged to differentiate; structural reinvention is not.
- Transparent backgrounds are only for special cases (e.g., a future sticker-like icon) and must be decided as a deliberate exception, not the default.

---

## 8. Color

- **Base/dominant value:** mid-to-light subject against dark navy backdrop — read the icon clearly at 64 px and against `#0b224f` cards.
- **Signature accent:** **neon cyan `#00e5ff`** as the primary energy/glow color (the Grynd signature). Use it for rim light, energy cores, visors, HUD seams.
- **Premium accents:** gold `#FFD700` for legendary/premium lean-ins; neon yellow `#f5ff3b` only in small, high-energy doses.
- **Supporting accents:** emerald, fuchsia, violet, crimson, amber (from the app's `ACCENT_COLORS` / `AvatarFrame` palette) may tint specific icons or rarities — kept to one dominant supporting hue per icon.
- **Contrast:** strong value separation (min ~3 tones per mass). Never let the subject and background share the same brightness/saturation.
- **Saturation:** rich and lively, but balanced — a single neon accent maxes saturation, the rest stays in controlled, game-friendly ranges.
- **Work with Grynd UI:** icons must look correct sitting next to `#00e5ff` icons/buttons and inside `#0b224f` cards. Test the icon at 64 px on `#0b224f` and on `#050b1f` before approval.
- Use the exact hex values **only** where they already exist in the app (listed in §5); otherwise specify hues qualitatively ("neon cyan", "royal violet") and let the painter pick a harmonious exact value.

---

## 9. Lighting

- **Key light:** single dominant source, **upper-left**.
- **Rim light:** a colored **cyan** edge/rim light on the subject (Grynd signature); premium tiers may use **gold** rim.
- **Falloff:** deep, controlled. Lower-right recedes toward ambient dark; forms read through tone, not outline.
- **Glow:** restrained luminous halos around energy cores / visor seams (mirrors app neon-glow language) — never so strong that edges blur and ruin the silhouette.
- **Consistency:** all icons in a set should read as sharing the same world-light (upper-left + colored rim). Do not randomize lighting per icon.

---

## 10. Detail Level

- **MEDIUM, center-weighted.** Heavy detail only within ~40% of the focal point.
- At **64 px** the icon must read as: clear silhouette + one identity feature + one color identity.
- At **128 px** it should reveal texture and material richness.
- A good test: if you have to zoom to 25% to tell it apart from a sibling icon, it's too noisy or too similar.
- Aim for "confidently simple from far, pleasantly detailed up close."

---

## 11. Subject Categories (original, Grynd-original)

Allowed original subjects (Grynd designs only):

- **Characters & archetypes:** gladiators, knights, space pilots, masked rangers, casino "high-roller" figures, cyber sportspersons, hooded duelists.
- **Creatures / beasts:** stylized dragons, wolves, bulls, serpents, spirits — original designs, no existing-game species.
- **Masks & helmets:** visor-helmets, tribal masks, animal-head helmets, HUD gladiator helms.
- **Weapons & tools:** stylized swords, axes, gauntlets, blasters, dice-blades, crystal maces — non-gory, clean hero props.
- **Symbols & sigils:** runes, elemental emblems, dice, cards, chips, crowns, rank marks, spade/heart/diamond/club motifs.
- **Futuristic objects:** energy cores, reactors, robots/mech heads, droids, holograms.
- **Fantasy objects:** talismans, orbs, enchanted gems, relics, phoenix feathers.
- **Gaming-related objects:** pixel-art dice, "jackpot" tokens, neon slot/suit tokens, trophy cups.
- **Abstract energy forms:** elemental masses (fire, storm, ice, crystal), auras, "power" glows.

Avoid anything that conflicts with brand or legal/safety requirements:
- No real people's likeness, celebrities, or recognizable historical figures.
- No gore, blood, ultra-violence, or horror-gore.
- No real-world currency imagery that implies real cash value (Grynd uses virtual **tokens**), no banknote/coin realism.
- No alcohol, tobacco, or real-world drug imagery.
- No existing game/movie/anime/media characters, mascots, or copyrighted symbols.
- No implied partnership with other brands.

---

## 12. Typography

- **Generated icons contain NO text.** No labels, no banners with words, no letters or numerals applied as decals.
- The only exception is a **future special icon explicitly designed to contain text** (e.g., a commemorative icon with a wordmark), which still must be small, legible at 64 px, and non-essential to recognition (the shape alone must remain identifiable).
- Even for such exceptions, apply lettering as an original stylized element, never a stock font overlay.

---

## 13. Logos

- **Do NOT embed the Grynd logo into every icon.** Auto-embedding the logo would make icons repetitive and amateur.
- The Grynd mark/logo (and the smiley `logo1.png` mark used in-game) may appear **only** as a deliberate, secondary detail in a small number of designated "brand" icons — and even then as a **stylized emblem**, not a pasted asset.
- Never include any third-party logo, watermark, or trademark.

---

## 14. Negative / Avoid List

Generation must strictly avoid:

- **Photoreal photography / photobash realism** — no photos, no camera-photo look.
- **Generic stock art** — nothing pasted or recycled-looking.
- **Low-quality AI appearance** — wobbly anatomy, melted geometry, smeared detail, random tiny artifacts, "AI sludge" texture, duplicate floating fingers, unblended shapes.
- **Muddy rendering** — low-contrast, gray/brown washed-out images, unclear forms.
- **Excessive detail / clutter** — too many competing details; anything that can't be read at 64 px.
- **Unreadable or busy silhouettes** — a subject whose black-filled shape is ambiguous.
- **Text / letters / numerals** except the explicit special-icon exception (§12).
- **Watermarks** — none, ever.
- **Random or third-party logos** — none; only intentional light Grynd branding on designated brand icons (§13).
- **Copyrighted / existing characters** — no real or existing-game/studio/anime characters, no exact replicas, and no "in the style of X character" references.
- **Direct copies of existing game assets** — do not recreate any other game's icons, splash art, or logos.
- **Inconsistent art styles** — every icon of a set must use the same painting language (same lighting, same material quality, same background build). A mixed "this one looks like a render, that one like a cartoon" set is a reject.
- **Poorly cropped / off-center subjects** — anything touching the circular safe-zone edge.
- **Multiple unrelated focal points** — one subject, one focal point only.
- **Cut-off compositions** — avoid floating heads awkwardly severed at the crop line; end forms cleanly inside the frame or inside the safe circle.

---

## 15. Technical Asset Specification

- **Master generation resolution:** **1024 × 1024 px** (square).
- **Production resolution:** single **512 × 512 px** WebP, served at `/icons/<key>.webp`. 512 px keeps 64–128 px displays sharp (including 2×/3×) while keeping payload small. (If a full-res master must be served later, export a 1024 WebP instead; do not ship the PNG to `public/`.)
- **Aspect ratio:** strictly 1:1 square.
- **Master file format:** lossless **PNG** (ComfyUI output / source of truth, kept in the producer's asset folder, not auto-served).
- **Production file format:** **WebP** (matches `ICON_ASSET_EXT = "webp"` in `src/lib/iconAssets.ts`).
- **Transparency:** default **opaque** (stylized background per §7). Export with an alpha channel only for deliberate transparent-exception icons.
- **Filename convention:** `<key>.webp` where `<key>` matches the catalog key and passes the app's key rules (`^[a-z0-9][a-z0-9._-]{0,119}$`, lowercase, no spaces/slashes). Example: `default.webp`, `crimson_visored.webp`. Place in `public/icons/`.
- **Safe margins:** keep key subject ≥ 12% clear of any display edge; subject fully within the central circle (≥30% margin from canvas corners to be safe under the circular crop).
- **Maximum production file size:** ≤ **300 KB** per 512×512 WebP (target ≤ 200 KB). If a 1024 WebP is used, ≤ 800 KB.
- **Color space:** **sRGB** (web-safe), bit depth 8. Avoid HDR/P3 source being uploaded without conversion.

---

## 16. Rarity Visual System

Rarity is a **framing/aura enhancement around an unchanged-icon core** — the underlying icon must stay perfectly readable on its own.

Suggested language, mapped to the app's existing accent palette (so rarity color ties into the `AvatarFrame` and `ACCENT_COLORS` system):

| Rarity | Visual signature (subtle) | App-aligned accents |
|---|---|---|
| Common | Neutral slate/steel, minimal glow; base backdrop, no aura | cool gray `#e2e8f0`, navy `#0b224f` |
| Rare | Restrained **cyan** rim + faint cyan haze | `#00e5ff` |
| Epic | **Violet/royal** rim + cool purple glow (a small energy aura) | `#a78bfa` / `#4f46e5` |
| Legendary | **Gold** rim + warm gold aura/particulates; modest light streaks | `#FFD700` (+ `#f5ff3b` micro-accents) |

Rules:
- The rarity is expressed in **rim-light warmth, backdrop haze, and (for Epic/Legendary) a thin glow aura** — NOT by changing the subject.
- Keep the aura within the outer 20% so it never reads as clutter or fuzz at 64 px.
- Must remain **legible**: a Legendary icon downscaled to 64 px still shows a clean silhouette and a gold rim, not a blob of light.
- An individual icon may be approved with rarity styling independent of which future shop tier attaches to it (rarity visuals and catalog `rarity` tag are coordinated, but the icon itself must not become unreadable if re-tagged).

---

## 17. ComfyUI Generation Guidelines

A ComfyUI prompt should package every decision from this spec into slots. Suggested prompt template fields:

- **Subject:** explicit, original Grynd subject (e.g., "original stylized cyber gladiator helm with a cyan visor"; never a real/game character).
- **Style:** "stylized premium fantasy/futuristic digital-painting game icon; bold readable 2D-icon presentation with a strong simple silhouette; painterly materials."
- **Composition:** "square 1:1 canvas, centered subject, subject within central 70%, empty/navy safe margins, circular-crop safe, single focal point, bust/head-and-shoulders or one hero object."
- **Lighting:** "upper-left key light, strong cyan rim/edge light, deep controlled falloff toward lower-right."
- **Color:** "dark navy backdrop; one dominant neon-cyan energy accent; optional gold for legendary; rich but balanced saturation; strong value separation."
- **Materials:** "brushed dark metal, matte armor, glowing cyan crystal, gold trim, clean cloth/leather."
- **Rarity:** the chosen tier's aura/rim treatment (common none / rare cyan / epic violet / legendary gold).
- **Background:** "opaque stylized radial-gradient navy backdrop, darker and lower-contrast than the subject, subtle accent haze behind the subject."
- **Technical:** "1024 x 1024, medium detail centered on the focal point, no text, no letters, no numerals, no watermark, no logo, no photorealism, no gore, no real people."
- **Negative constraints:** repeat §14 verbatim as negatives (photorealism, stock art, low-quality AI artifacts, muddy rendering, clutter, unreadable silhouette, text, watermark, logo, copyrighted characters, direct copies, inconsistent style, bad crop, multiple focal points, extra fingers/limbs, melted geometry).

Generate, downscale to 64 px, verify against the QC checklist (§18); iterate only the failing slot.

---

## 18. Quality-Control Checklist

Every icon must pass ALL of the following before it may be added to the catalog:

**Readability**
- [ ] Recognizable and correct at **64 × 64 px**.
- [ ] Recognizable and *improves* at **128 × 128 px** (still the same subject, more detail reads).
- [ ] Strong, unambiguous silhouette at a glance.
- [ ] One clear subject and one focal point.

**Composition / presentation**
- [ ] Centered; subject fully inside the central safe circle (nothing clipped by the circular avatar mask).
- [ ] Clear foreground/background separation (subject pops from backdrop).
- [ ] Subject scale within the 55–70% target; not touching crop edges.

**Content / cleanliness**
- [ ] No text, letters, or numerals (unless an approved special-text icon).
- [ ] No watermark.
- [ ] No accidental or third-party logo (Grynd mark only where intentionally designated).
- [ ] No generation artifacts (melted geometry, extra fingers/limbs, seams, smears).
- [ ] No copyrighted / existing character or copied asset.

**Technical**
- [ ] Correct dimensions (512×512 production; master 1024×1024).
- [ ] Correct format (WebP production, PNG master).
- [ ] Filename matches the catalog key and the app's key rules (`.webp`, lowercase key).
- [ ] File size within limits (≤300 KB at 512×512).
- [ ] sRGB, opaque (or intentional transparent exception), 1:1.

**Consistency**
- [ ] Visually consistent with the Grynd palette (navy base, neon-cyan / gold language).
- [ ] Visually consistent with the other icons in the same set (same lighting, same backdrop language, same material quality).
- [ ] Does not conflict with brand or legal/safety rules (§11 avoid-list).

**Integration check (final gate)**
- [ ] Placed at `/icons/<key>.webp`, resolves via `iconAssetUrl(key)` and renders correctly in `IconAvatar` (default fallback not triggered).
- [ ] Sanity-checked at 64 px on `#0b224f` and on `#050b1f`.

---

## Design Decisions vs. Existing Grynd UI (rationale)

These choices come directly from reading the existing app:

1. **Circular-safe composition is mandatory.** Every avatar render path (`IconAvatar` → `rounded-full object-cover`) clips to a circle. Squares are designed so design-for-circle is baked into the spec.
2. **Opaque stylized background instead of transparent.** Icons sit on many semi-transparent/glowing navy surfaces; an opaque backdrop gives a consistent, premium "emblem" look and prevents transparency over UI. Matches card surfaces (`#0b224f`, `casino-surface`).
3. **Neon cyan as the signature.** Cyan (`#00e5ff`) is the app's primary accent (default accent + nav + cyber-grid + glows), so it becomes the icon rim-light/energy language. Gold (`#FFD700`) is the premium/win color (profile avatar border is gold), so legendary leans gold. Yellow `#f5ff3b` is the CTA color, used only sparingly.
4. **Rarity colors reuse the existing accent language** (`AvatarFrame` gold/emerald/fuchsia/crimson/royal/rainbow + `ACCENT_COLORS` + title rarities) rather than inventing a new palette. Supports future `price_tokens`/tier work without a new color system.
5. **Medium, center-weighted detail** answers the core requirement (readable at 64 px) while satisfying the premium direction (rich at 128 px), matching how the app uses neon emphasis rather than fine texture at small sizes.
6. **Medium/no-line, rim-light illustration** fits the app's neon-glow aesthetic (glow-pulse, neon button shadows) better than a heavy-cartoon outline, while keeping silhouettes strong.
7. **1024×1024 master / 512 WebP production** balances ComfyUI quality (1024 is the recommended master) against the app's single-asset-per-key architecture and small display sizes. No need for a multi-size pipeline.
8. **No text / no auto-logo** because the icons double as chat/leaderboard face avatars where text and logos would be unreadable and noisy; it also keeps a set cohesive and legally clean.

### Open items to confirm before generation
- Final catalog keys + the exact first set list.
- Rarity-to-tier mapping if a future token shop assigns prices/rarities.
- Whether any special "brand" icons (with the Grynd mark) are desired.

---

*End of specification — `docs/GRYND_ICON_SPEC.md`*