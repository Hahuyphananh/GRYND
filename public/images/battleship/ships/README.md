# Battleship ship artwork

The five generated ship illustrations live here and are registered in
`src/components/games/battleship/shipArtwork.ts`; `ShipVisual` renders them.

| File | Ship | Cells |
|---|---|---|
| `carrier.png` | Carrier | 5 |
| `battleship.png` | Battleship | 4 |
| `cruiser.png` | Cruiser | 3 |
| `submarine.png` | Submarine | 3 |
| `destroyer.png` | Destroyer | 2 |

There is **no `frigate.png`**: the Frigate keeps the CSS-block rendering, which
is also the fallback for any ship the registry does not map. `ShipVisual` only
creates an `<img>` for a ship that has a URL, so a missing file can never become
a broken-image icon.

## The files are portrait, and the source art was not transparent

Every illustration is **portrait, top-down, bow UP, stern DOWN**. `ShipVisual`
draws a vertical ship as-is and rotates a horizontal ship 90° onto its run, so
never re-crop one of these into a landscape image.

The generated PNGs were delivered on an **opaque white backdrop**. The committed
files are the same art with that backdrop keyed to transparency (flood-filled
from the frame, so light pixels inside a hull survive) and trimmed to the hull,
exported 512 px tall. That is what lets them sit on the dark board without a
white box covering the cells and grid lines. Keep that property if you replace
them: transparent PNG, trimmed, portrait.
