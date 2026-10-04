// Derives every app icon from public/rubberduck.svg, a 32×32 pixel-art logo.
// Scales by whole-number multiples with nearest-neighbour so the pixels stay sharp. Run: npm run icons
import { copyFile, writeFile } from 'node:fs/promises'
import sharp from 'sharp'

const SOURCE = 'public/rubberduck.svg'
const GRID = 32
/** Solar light --bg, behind the icons that must be opaque. */
const BACKGROUND = { r: 0xfc, g: 0xf5, b: 0xe3, alpha: 1 }
const CLEAR = { r: 0, g: 0, b: 0, alpha: 0 }

/** The logo as 32×32 RGBA; the SVG is 1280px wide, so this density draws one unit per pixel. */
const base = await sharp(SOURCE, { density: (72 * GRID) / 1280 })
  .ensureAlpha()
  .raw()
  .toBuffer({ resolveWithObject: true })
if (base.info.width !== GRID || base.info.height !== GRID) throw new Error(`Expected a ${GRID}px logo`)

/** Maps each output pixel to one source pixel. */
function sample(size, pick) {
  const out = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const from = (pick(y) * GRID + pick(x)) * 4
      base.data.copy(out, (y * size + x) * 4, from, from + 4)
    }
  }
  return sharp(out, { raw: { width: size, height: size, channels: 4 } })
}

/** The logo at a whole-number scale, centred on a size×size canvas. */
async function icon(size, scale, background = CLEAR) {
  const drawn = scale * GRID
  const pad = (size - drawn) / 2
  const logo = await sample(drawn, (i) => Math.floor(i / scale)).png().toBuffer()
  return sharp({ create: { width: size, height: size, channels: 4, background } })
    .composite([{ input: logo, left: Math.floor(pad), top: Math.floor(pad) }])
    .png()
}

/** 32→16 has no whole-number scale; the odd pixels keep the eye, bill shading and highlight. */
const half = () => sample(16, (i) => i * 2 + 1).png()

/** An ICO whose entries are PNGs, which every browser that reads ICO accepts. */
function ico(pngs) {
  const header = Buffer.alloc(6 + pngs.length * 16)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(pngs.length, 4)
  let offset = header.length
  pngs.forEach(({ size, data }, i) => {
    const entry = 6 + i * 16
    header.writeUInt8(size % 256, entry)
    header.writeUInt8(size % 256, entry + 1)
    header.writeUInt16LE(1, entry + 4)
    header.writeUInt16LE(32, entry + 6)
    header.writeUInt32LE(data.length, entry + 8)
    header.writeUInt32LE(offset, entry + 12)
    offset += data.length
  })
  return Buffer.concat([header, ...pngs.map(({ data }) => data)])
}

const toBuffer = (image) => image.then((png) => png.toBuffer())

await copyFile(SOURCE, 'public/favicon.svg')
await writeFile(
  'public/favicon.ico',
  ico([
    { size: 16, data: await half().toBuffer() },
    { size: 32, data: await toBuffer(icon(32, 1)) },
    // 48 is 1.5×, so the 1× logo sits in it with a margin.
    { size: 48, data: await toBuffer(icon(48, 1)) },
  ]),
)
await (await icon(180, 5, BACKGROUND)).toFile('public/apple-touch-icon-180x180.png')
await (await icon(192, 6)).toFile('public/pwa-192x192.png')
await (await icon(512, 16)).toFile('public/pwa-512x512.png')
// 13× keeps every drawn pixel inside the maskable safe zone, a circle of 40% radius (furthest is ~180 of 205px).
await (await icon(512, 13, BACKGROUND)).toFile('public/maskable-icon-512x512.png')
