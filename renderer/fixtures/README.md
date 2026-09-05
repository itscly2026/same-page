# Native rendering regression specimen

`score-specimen.pdf` is original synthetic test material created in this repository. Page 1 embeds Bravura music glyphs and vector staff lines, dots, stems, slurs and lyrics; page 2 is a controlled raster scan of the same source; page 3 applies a CropBox and 90-degree PDF page rotation. It is a symbol rendering specimen, not a musical edition.

Bravura is supplied unchanged from [Steinberg's Bravura repository](https://github.com/steinbergmedia/bravura), under the adjacent OFL-1.1 license. Do not remove the font license. Regeneration uses `node renderer/fixtures/create-specimen.mjs` and `python renderer/fixtures/assemble-specimen.py` (pypdf required only for regeneration).

`python renderer/verify.py` runs the pinned native engine in disposable processes against the fixed PDF and compares actual pixels with reviewed PNG baselines at 2048/3072 long-edge tiers. A difference fails; do not update baselines until the changed symbols, dots, accidentals, lyrics, slurs and crop/rotation have been checked against the source. Use `--record` only for that reviewed update. A passed golden comparison is not proof about other scores or devices.
