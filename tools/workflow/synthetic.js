// synthetic.js — a deterministic synthetic product photo for the Workflow API
// test: a plain red "car" on a light background, PNG, no dependencies.
// The car's true extent is known, so a detected box can be sanity-checked.
const zlib = require("zlib");

const SYNTHETIC = {
    width: 1200,
    height: 800,
    // the car's extent in shares of the photo (body, cabin and wheels)
    truth: { x: 300 / 1200, y: 330 / 800, width: 600 / 1200, height: 370 / 800 },
};

function crc32(buf) {
    let c, crc = 0xffffffff;
    for (let n = 0; n < buf.length; n++) {
        c = (crc ^ buf[n]) & 0xff;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        crc = (crc >>> 8) ^ c;
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
}

function pixel(x, y) {
    const inRect = (x0, y0, x1, y1) => x >= x0 && x < x1 && y >= y0 && y < y1;
    const inCircle = (cx, cy, r) => (x - cx) * (x - cx) + (y - cy) * (y - cy) <= r * r;
    if (inCircle(430, 640, 60) || inCircle(770, 640, 60)) return [25, 25, 28];      // wheels (y up to 700)
    if (inRect(300, 440, 900, 650)) return [196, 30, 36];                           // body
    if (inRect(440, 345, 740, 430)) return [170, 205, 225];                         // windows (inside the cabin)
    if (inRect(420, 330, 760, 445)) return [150, 20, 26];                           // cabin
    const g = 236 - Math.round((y / 800) * 30);                                     // light backdrop + floor
    return y > 700 ? [g - 20, g - 20, g - 18] : [g, g, g + 2];
}

function syntheticPng() {
    const { width, height } = SYNTHETIC;
    const raw = Buffer.alloc((width * 3 + 1) * height);
    for (let y = 0; y < height; y++) {
        const row = y * (width * 3 + 1);
        raw[row] = 0;
        for (let x = 0; x < width; x++) {
            const p = pixel(x, y);
            raw[row + 1 + x * 3] = p[0]; raw[row + 2 + x * 3] = p[1]; raw[row + 3 + x * 3] = p[2];
        }
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

// Intersection over union of two boxes ({ x, y, width, height } shares).
function iou(a, b) {
    const x0 = Math.max(a.x, b.x), y0 = Math.max(a.y, b.y);
    const x1 = Math.min(a.x + a.width, b.x + b.width), y1 = Math.min(a.y + a.height, b.y + b.height);
    const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
    const uni = a.width * a.height + b.width * b.height - inter;
    return uni > 0 ? inter / uni : 0;
}

module.exports = { SYNTHETIC, syntheticPng, iou };
