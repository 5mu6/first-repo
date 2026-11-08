# SizeFit 尺码助手

Reads the size chart on a Taobao / Tmall / 1688 / Weidian listing (or an agent site), converts the Chinese measurements and units, recommends the size that best fits **your** body, and draws that size on a figure built from your measurements.

## What's in here

| Path | What it is |
| --- | --- |
| `index.html`, `css/`, `js/app.js` | The web app. Works on a phone or computer and needs no install. |
| `js/sizefit-core.js` | Size-chart reader and fit engine (no dependencies; also runs in Node). |
| `js/sizefit-render.js` | Draws the fit diagram as an SVG, which the app can save as a PNG. |
| `js/sizefit-3d.js` | The 3D body scan. It builds a signed-distance-field body from your measurements, meshes it with surface nets, drapes the garment over it and colours it as a fit map. The viewer uses three.js r128, loaded from cdnjs on first use. |
| `userscript/sizefit-helper.user.js` | Optional browser helper. It adds a **📏 SizeFit** button to product pages and sends the chart to the app in one click. |
| `tests/` | `npm test` runs the parser and fit-engine tests against sample charts. |

## Using it

1. **Open the app.** Use the hosted page (see *Hosting* below), or open `sizefit/index.html` straight from disk.
2. **Step 1: enter your measurements once.** You can enter them in inches/lb or cm/kg. They are saved only in that browser. To move them to another device, use *Copy profile code* and then *Load profile code*.
3. **Step 2: give it the size chart.** There are three ways:
   - **Screenshot (works on a phone):** screenshot the 尺码表 in the Taobao, Weidian or agent app, then drop it on the page, pick it, or paste it with Ctrl/⌘+V. The text is read on your device with Tesseract.js. The first time, it downloads about 4 MB of Chinese reading data from jsDelivr.
   - **Paste text:** copy the chart text from the listing or the agent site. Chinese and English both work, in any layout.
   - **Browser helper (desktop):** click **📏 SizeFit** on the product page, click the size-chart image(s), and press **Send**.
4. **Check "What was read".** The table can be edited, and the result updates as you type. If the app guessed a column wrong, change it with the column dropdown. Use the *flat ×2* boxes to mark measurements that are flat-lay halves (平铺).
5. **Step 3: read the result.** You get the recommended size and a runner-up, a check of each measurement, and small drawings of every size so you can compare them. The main view is a **3D body scan** built from your measurements:
   - **The body** is a high-resolution surface (about 90,000 triangles). The torso is shaped through your chest, waist and hip cross-sections and blended smoothly with arms, legs, muscles, hands, feet and a face. Its chest, waist and hips come out within a few percent of your measurements (the tests check this).
   - **The garment** is a see-through shell built from the size chart and draped so it never passes through the body. It's coloured as a **fit map**: yellow-green where the fabric touches you, then green, teal and blue as the gap grows to 6″ or more. Red and orange appear only where the size check found that area too tight or snug. *Fit map* switches to a plain fabric colour.
   - It turns slowly on a scanner platform while a scanning beam sweeps up and down. Drag it to turn it yourself, scroll to zoom, or use *Pause*, *Front*, *Side* and *Back*. With reduced motion turned on in your device settings, it starts still.
   - Callouts list each checked measurement (chest, shoulder, waist, hip, thigh, hem, cuff) next to a glowing band on the garment. The corners show your size, fit score and body measurements.
   - *Download image (PNG)* saves the current angle with its callouts.
   - *Flat diagram* switches to the labelled front-view drawing. Shoes always use a top-down foot diagram.

### What the reader understands

- Header-row tables, transposed tables (sizes across), inline text (`S码：衣长68 胸围104…`), per-measurement lines (`胸围: S 100 M 104…`), one-size (均码) items, and charts that only list height and weight (`身高165-175 体重110-130斤`).
- Units: cm/厘米/公分, mm, inches/英寸, 市尺/寸 (`2尺2` = 73.3 cm), 斤 (= 0.5 kg), kg, lb, and m.
- Flat-lay measurements (平铺, 半胸围, chest width / pit-to-pit) are doubled to the full circumference. This also happens when the numbers are clearly half-sized.
- Common screenshot-reading errors: spaces inside Chinese words, 围 read as 国/困/圈, 衣长 read as 交长, digits split apart, "X L" for XL, and header rows the reader couldn't read (the columns are guessed from the numbers).
- About 150 Chinese and English measurement names. The list is in `ALIASES` in `js/sizefit-core.js`.

### How a size is chosen

For each size it works out the **ease** (garment minus body) for the chest, shoulder, waist, hip and thigh. It compares each ease with the normal range for that kind of garment (a T-shirt, hoodie, jacket, coat, jeans and so on) at the fit you prefer (slim, regular, relaxed or oversized). It also checks where the hem and sleeves land on your body, and the seller's suggested height and weight (身高/体重) if the chart has them. Too tight counts against a size more than too loose, and too long counts less than too short, because pants can be hemmed. Shoes are matched on 脚长 (foot length), 内长 (insole length) or the EU size. Any measurements you leave blank are estimated from your height and labeled as estimates.

Sellers' charts are measured by hand and are usually ±1–3 cm off. The drawing is a front-view fit diagram drawn to your proportions. It is not a photo.

## Browser helper (optional)

1. Install a userscript manager: Tampermonkey (Chrome, Edge or Firefox) or the Userscripts app (Safari).
2. Open `userscript/sizefit-helper.user.js` (the *Raw* view on GitHub) and install it.
3. If the app is hosted anywhere other than `https://5mu6.github.io/first-repo/sizefit/`, choose **Set SizeFit app address…** from the userscript menu and add a matching `// @match` line.
4. The helper runs on taobao.com, tmall.com, 1688.com and weidian.com, plus several agent sites. To use it on another site, add a `@match` line for it.

The helper downloads the images you select through the userscript manager (so the sites' cross-origin limits don't apply), stores them briefly in the manager's storage, and opens the app. The same userscript then hands the data to the app page.

## Hosting

The app is plain static files, so any static host works:

- **GitHub Pages:** go to the repository's *Settings → Pages* and choose *Deploy from a branch*, `main`, `/ (root)`. The app is then at `https://<user>.github.io/<repo>/sizefit/`. On a free plan, Pages needs the repository to be public.
- **Self-hosting the libraries:** set `window.SizeFitConfig = { threeUrl, tesseractUrl, workerPath, corePath, langPath, langSuffix }` before `js/app.js` and serve `three@0.128.0/build/three.min.js`, `tesseract.js`, `tesseract.js-core` and `@tesseract.js-data/{chi_sim,eng}` yourself. `langSuffix` is for hosts that only serve certain file extensions: store the language files with that extra suffix (e.g. `.wasm`).

## Development

```bash
npm test
```
