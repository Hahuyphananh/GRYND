# Battleship ship artwork — placeholder directory

No ship artwork exists yet. The game renders ships as **CSS blocks**
(`src/components/games/battleship/ShipVisual.tsx`) and this directory stays empty
on purpose: `ShipVisual` only creates an `<img>` when
`src/components/games/battleship/shipArtwork.ts` has a URL for that ship, so an
empty registry means no request and no broken-image icon.

When the real art is ready, drop these files here and map them in that registry:

| File | Ship | Cells |
|---|---|---|
| `carrier.png` | Carrier | 5 |
| `battleship.png` | Battleship | 4 |
| `cruiser.png` | Cruiser | 3 |
| `submarine.png` | Submarine | 3 |
| `destroyer.png` | Destroyer | 2 |

Suggested public URL once the file exists:

```
/images/battleship/ships/carrier.png
```

Nothing outside `ShipVisual` needs to change: the same component draws the art
inside the cell footprint it already occupies.
