const sharp = require('sharp');
const path = require('path');

async function generate() {
    // NSIS sidebar: 164x314 BMP
    // Create a dark gradient background with the icon
    const width = 164;
    const height = 314;

    // Create SVG for the sidebar
    const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
        <defs>
            <linearGradient id="bg" x1="0%" y1="0%" x2="0%" y2="100%">
                <stop offset="0%" style="stop-color:#1a1b2e"/>
                <stop offset="100%" style="stop-color:#0d1117"/>
            </linearGradient>
            <linearGradient id="accent" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" style="stop-color:#58a6ff"/>
                <stop offset="100%" style="stop-color:#8b5cf6"/>
            </linearGradient>
        </defs>
        <rect width="${width}" height="${height}" fill="url(#bg)"/>

        <!-- Decorative line -->
        <rect x="${width - 3}" y="0" width="3" height="${height}" fill="url(#accent)" opacity="0.5"/>

        <!-- Git branch icon -->
        <g transform="translate(82,100)" fill="none" stroke="url(#accent)" stroke-width="3" stroke-linecap="round">
            <line x1="-20" y1="-40" x2="-20" y2="40"/>
            <line x1="20" y1="-20" x2="20" y2="5"/>
            <line x1="20" y1="5" x2="-20" y2="18"/>
            <circle cx="-20" cy="-40" r="6" fill="#58a6ff" stroke="none"/>
            <circle cx="-20" cy="40" r="6" fill="#3fb950" stroke="none"/>
            <circle cx="20" cy="-20" r="6" fill="#8b5cf6" stroke="none"/>
        </g>

        <!-- App name -->
        <text x="${width / 2}" y="190" text-anchor="middle" fill="#58a6ff" font-family="Segoe UI, Arial" font-size="11" font-weight="600">GitHub Repo</text>
        <text x="${width / 2}" y="206" text-anchor="middle" fill="#8b5cf6" font-family="Segoe UI, Arial" font-size="11" font-weight="600">Organizer</text>

        <!-- Version -->
        <text x="${width / 2}" y="230" text-anchor="middle" fill="#8b949e" font-family="Segoe UI, Arial" font-size="9">v1.0.0</text>

        <!-- Sparkle -->
        <g transform="translate(120,75)" fill="#f0883e">
            <polygon points="0,-8 2,-2 8,0 2,2 0,8 -2,2 -8,0 -2,-2"/>
        </g>

        <!-- Bottom text -->
        <text x="${width / 2}" y="${height - 20}" text-anchor="middle" fill="#484f58" font-family="Segoe UI, Arial" font-size="8">by Antigravity</text>
    </svg>`;

    // Save as PNG first
    const pngBuf = await sharp(Buffer.from(svg))
        .resize(width, height)
        .png()
        .toBuffer();

    // Convert PNG to BMP manually (24-bit, no compression)
    const { data, info } = await sharp(pngBuf).raw().toBuffer({ resolveWithObject: true });
    const w = info.width, h = info.height, channels = info.channels;
    const rowSize = Math.ceil(w * 3 / 4) * 4; // BMP rows are 4-byte aligned
    const pixelDataSize = rowSize * h;
    const fileSize = 54 + pixelDataSize;
    const bmp = Buffer.alloc(fileSize);

    // BMP Header
    bmp.write('BM', 0);
    bmp.writeUInt32LE(fileSize, 2);
    bmp.writeUInt32LE(54, 10); // pixel data offset
    // DIB Header
    bmp.writeUInt32LE(40, 14); // header size
    bmp.writeInt32LE(w, 18);
    bmp.writeInt32LE(h, 22);
    bmp.writeUInt16LE(1, 26);  // planes
    bmp.writeUInt16LE(24, 28); // bits per pixel
    bmp.writeUInt32LE(pixelDataSize, 34);

    // Pixel data (BMP is bottom-up, BGR)
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const srcIdx = ((h - 1 - y) * w + x) * channels;
            const dstIdx = 54 + y * rowSize + x * 3;
            bmp[dstIdx]     = data[srcIdx + 2]; // B
            bmp[dstIdx + 1] = data[srcIdx + 1]; // G
            bmp[dstIdx + 2] = data[srcIdx];     // R
        }
    }

    const fs = require('fs');
    fs.writeFileSync(path.join(__dirname, 'assets', 'installer-sidebar.bmp'), bmp);
    console.log('installer-sidebar.bmp created (164x314)');
}

generate().catch(console.error);
