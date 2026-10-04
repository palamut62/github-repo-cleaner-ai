// Renders docs/banner/banner.html to assets/banner.png (2560x1280).
// Usage: npm run banner
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

app.whenReady().then(async () => {
    const win = new BrowserWindow({
        width: 1280,
        height: 640,
        show: false,
        useContentSize: true,
        webPreferences: { offscreen: true, zoomFactor: 1 }
    });
    await win.loadFile(path.join(__dirname, 'banner.html'));
    await win.webContents.executeJavaScript('document.fonts.ready.then(() => true)');
    await new Promise(r => setTimeout(r, 400));
    win.webContents.setZoomFactor(2);
    win.setContentSize(2560, 1280);
    await new Promise(r => setTimeout(r, 600));
    const image = await win.webContents.capturePage({ x: 0, y: 0, width: 2560, height: 1280 });
    const out = path.join(__dirname, '..', '..', 'assets', 'banner.png');
    fs.writeFileSync(out, image.toPNG());
    console.log('wrote', out, image.getSize());
    app.quit();
});
