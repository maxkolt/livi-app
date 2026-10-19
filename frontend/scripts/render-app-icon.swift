// Renders the LiVi app icon (slate + ice-blue glass, 2026-10-06) as crisp art at any size.
// Usage: swiftc -O scripts/render-app-icon.swift -o /tmp/render-app-icon
//        /tmp/render-app-icon <full|foreground|background|logo|splashicon> <size> <out.png>
// full — opaque tile on the glass (iOS AppIcon, assets/icon.png, Play 512, legacy mipmaps);
// foreground — transparent Android adaptive foreground (safe zone), camera only.
// background — translucent Android adaptive background (wallpaper shows through), scaled like the foreground
//        (assets/adaptive-icon-background.png 1024, mipmap-*/ic_launcher_background 108/162/216/324/432).
// logo — transparent camera only, filling the canvas (splash: assets/splash-icon.png,
//        drawable-*/splashscreen_logo 288/432/576/864/1152, iOS SplashScreenLogo 1024).
// splashicon — same logo inside the Android 12+ splash circle
//        (drawable-*/splashscreen_icon 288/432/576/864/1152, values-v31 windowSplashScreenAnimatedIcon).
// Sizes: ic_launcher / ic_launcher_round 48/72/96/144/192, ic_launcher_foreground 108/162/216/324/432.
//
// Style — матовое стекло корпуса/объектива: заливка в тонах бывшего эквалайзера
// (белый → #A3D4EE / ACCENT_LIGHT), светлая кромка, мягкая тень.
// Фон плитки — объёмное стекло + рыбий глаз, без пузырьков и серых полос.
// Кромок по краю плитки нет — маски лаунчеров разные.
import CoreGraphics
import CoreImage
import Foundation
import ImageIO
import UniformTypeIdentifiers

func rgb(_ hex: UInt32, _ a: CGFloat = 1) -> CGColor {
  CGColor(
    srgbRed: CGFloat((hex >> 16) & 0xFF) / 255,
    green: CGFloat((hex >> 8) & 0xFF) / 255,
    blue: CGFloat(hex & 0xFF) / 255,
    alpha: a)
}

/// Что видно сквозь матовое стекло камеры на иконке — бывший сплошной фон иконки (тон приподнятых
/// блоков, светлее фона приложения). Остался, чтобы камера не изменилась на тёмном стекле.
let ICON_BG: UInt32 = 0x414C59
/// Ровный серо-синий фон иконки.
let GLASS_TOP: UInt32 = 0x545F6C
let GLASS_MID: UInt32 = 0x545F6C
let GLASS_BOTTOM: UInt32 = 0x545F6C
/// Фон сплэша (HOME_NAV_BG): под стеклом логотипа на сплэше виден он.
let SPLASH_BG: UInt32 = 0x252B34
let ACCENT: UInt32 = 0x62B0D8        // UI_ACCENT
let ACCENT_LIGHT: UInt32 = 0xB2DCF0  // UI_ACCENT_LIGHT

let args = CommandLine.arguments
let mode = args[1]
let size = Int(args[2])!
let out = args[3]

let space = CGColorSpace(name: CGColorSpace.sRGB)!
let S = CGFloat(size)

// Group scale: full icon uses the whole tile; adaptive foreground must stay inside the
// 66/108 safe circle (radius ≈ 313 of 1024); the adaptive background follows it, so the glow
// sits behind the camera (its 72/108 visible part ≈ the tile).
// The launcher mark keeps a calm inset from both square and circular masks. Android's
// foreground is slightly smaller because launchers crop it through the 72/108 visible area.
// logo: camera fills most of the width. splashicon must fit the 192/288 dp circle.
let k: CGFloat = mode == "full" ? 0.98 : mode == "logo" ? 1.30 : mode == "splashicon" ? 0.85 : 0.71
let ringless = mode == "logo" || mode == "splashicon"
/// Что лежит под стеклом: фон плитки иконки или фон сплэша.
let sceneBG = ringless ? SPLASH_BG : ICON_BG
/// Design units → device pixels (CTM does not scale shadow blur or CoreImage radii).
let px = S / 1024 * k
/// Верх видимой части плитки в единицах дизайна: у адаптивного фона видно 72 из 108 dp.
let visibleEdge: CGFloat = mode == "background" ? 512 - 512 * (72.0 / 108) / k : 0
/// Rim width in design units: icons are shown at 48–192 px, so their rim is thicker.
let rimWidth: CGFloat = ringless ? 9 : mode == "foreground" ? 13 : 11

/// deep — 16 бит на канал: тёмные градиенты стекла считаются без ступенек, в 8 бит — с шумом.
func makeContext(opaque: Bool, deep: Bool = false) -> CGContext {
  let c = CGContext(
    data: nil, width: size, height: size, bitsPerComponent: deep ? 16 : 8, bytesPerRow: 0, space: space,
    // Полная плитка — без альфа-канала (App Store его не принимает); остальные — с прозрачностью.
    bitmapInfo: (opaque ? CGImageAlphaInfo.noneSkipLast : CGImageAlphaInfo.premultipliedLast).rawValue
      | (deep ? CGBitmapInfo.byteOrder16Little.rawValue : 0))!
  c.setShouldAntialias(true)
  c.setAllowsAntialiasing(true)
  c.interpolationQuality = .high
  // Design space: 1024×1024, y down; group scale around the centre.
  c.translateBy(x: 0, y: S)
  c.scaleBy(x: S / 1024, y: -S / 1024)
  c.translateBy(x: 512, y: 512)
  c.scaleBy(x: k, y: k)
  c.translateBy(x: -512, y: -512)
  return c
}

/// Draw a device-space image (same size as the canvas) regardless of the current CTM.
func drawDeviceImage(_ c: CGContext, _ img: CGImage) {
  c.saveGState()
  c.concatenate(c.ctm.inverted())
  c.draw(img, in: CGRect(x: 0, y: 0, width: S, height: S))
  c.restoreGState()
}

let center = CGPoint(x: 512, y: 512)

// --- Camera geometry (design units). ---
// Камера оптически центрирована целиком; объектив расположен близко к корпусу.
let body = CGRect(x: 189, y: 336, width: 478, height: 352)
let bodyRadius: CGFloat = 106
let cy = body.midY
// Lens: trapezoid, short edge at the body, tall edge outside; rounded corners.
let lensL: CGFloat = 691, lensR: CGFloat = 835
let lensInnerHalf: CGFloat = 68, lensOuterHalf: CGFloat = 154
let lensRadius: CGFloat = 32
/// Светлая заливка корпуса и объектива, как в исходной версии знака.
let EQ_FILL: UInt32 = 0xF0EEEB

func roundedPolygon(_ pts: [CGPoint], radius: CGFloat) -> CGPath {
  let p = CGMutablePath()
  let n = pts.count
  let start = CGPoint(x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2)
  p.move(to: start)
  for i in 1...n {
    let a = pts[i % n]
    let b = pts[(i + 1) % n]
    p.addArc(tangent1End: a, tangent2End: b, radius: radius)
  }
  p.closeSubpath()
  return p
}

let bodyPath = CGPath(roundedRect: body, cornerWidth: bodyRadius, cornerHeight: bodyRadius, transform: nil)
let lensPath = roundedPolygon(
  [
    CGPoint(x: lensL, y: cy - lensInnerHalf),
    CGPoint(x: lensR, y: cy - lensOuterHalf),
    CGPoint(x: lensR, y: cy + lensOuterHalf),
    CGPoint(x: lensL, y: cy + lensInnerHalf),
  ], radius: lensRadius)
/// Блик сверху: у корпуса почти нет — верх как низ; у объектива лёгкий.
let bodyHighlight: (alpha: CGFloat, span: CGFloat) = (0.02, 0.35)
let glassShapes: [(path: CGPath, top: CGFloat, bottom: CGFloat, highlight: (alpha: CGFloat, span: CGFloat))] = [
  (bodyPath, body.minY, body.maxY, bodyHighlight),
  (lensPath, cy - lensOuterHalf, cy + lensOuterHalf, (0.06, 0.40)),
]

// --- Scene behind the camera glass (solid fill only; radar rings removed 2026-10-18). ---
func drawScene(_ c: CGContext, background: Bool) {
  if background {
    c.setFillColor(rgb(sceneBG))
    c.fill(CGRect(x: -4096, y: -4096, width: 9216, height: 9216))
  }
}

let ciCtx = CIContext(options: [
  .useSoftwareRenderer: true,
  .workingColorSpace: space,
  .outputColorSpace: space,
])

/// deep — результат в 16 бит на канал (для стекла фона, которое потом дизерится).
func blurred(_ img: CGImage, radius: CGFloat, deep: Bool = false) -> CGImage {
  let input = CIImage(cgImage: img)
  guard let f = CIFilter(name: "CIGaussianBlur") else { return img }
  f.setValue(input.clampedToExtent(), forKey: kCIInputImageKey)
  f.setValue(radius, forKey: kCIInputRadiusKey)
  guard let output = f.outputImage else { return img }
  let cropped = output.cropped(to: input.extent)
  if deep {
    return ciCtx.createCGImage(cropped, from: input.extent, format: .RGBA16, colorSpace: space) ?? img
  }
  return ciCtx.createCGImage(cropped, from: input.extent) ?? img
}

/// Мягкий рыбий глаз: выпуклая линза (CIBumpDistortion).
/// Свой CIContext + createCGImage (render→bitmap давал чёрный кадр из‑за ориентации).
/// radiusFactor > 1 — кромки у края плитки тоже гнутся (иначе warp ≈ 0 у y≈18).
func fisheye(_ img: CGImage, scale: CGFloat = 0.68, radiusFactor: CGFloat = 1.25) -> CGImage {
  let rgba = CGContext(
    data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0, space: space,
    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
  rgba.draw(img, in: CGRect(x: 0, y: 0, width: S, height: S))
  guard let rgbaImg = rgba.makeImage() else { return img }
  let input = CIImage(cgImage: rgbaImg)
  guard let f = CIFilter(name: "CIBumpDistortion") else { return img }
  let extent = input.extent
  let r = min(extent.width, extent.height) * 0.5 * radiusFactor
  f.setValue(input.clampedToExtent(), forKey: kCIInputImageKey)
  f.setValue(CIVector(x: extent.midX, y: extent.midY), forKey: kCIInputCenterKey)
  f.setValue(r, forKey: kCIInputRadiusKey)
  f.setValue(scale, forKey: kCIInputScaleKey)
  guard let warped = f.outputImage?.cropped(to: extent) else { return img }
  let bumpCI = CIContext()
  guard let warpedImg =
    bumpCI.createCGImage(warped, from: extent)
    ?? bumpCI.createCGImage(warped, from: extent, format: .RGBA8, colorSpace: space)
  else { return img }
  // Непрозрачная плитка для App Store / Play.
  let opaque = CGContext(
    data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0, space: space,
    bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
  opaque.setFillColor(rgb(GLASS_MID))
  opaque.fill(CGRect(x: 0, y: 0, width: S, height: S))
  opaque.draw(warpedImg, in: CGRect(x: 0, y: 0, width: S, height: S))
  return opaque.makeImage() ?? img
}

// --- Dark glass behind the camera (icon tile and Android adaptive background). ---

/// Эллиптическое радиальное пятно: свечение, блик, затемнение краёв.
func drawGlow(_ c: CGContext, at p: CGPoint, rx: CGFloat, ry: CGFloat, _ colors: [CGColor], _ locations: [CGFloat]) {
  let g = CGGradient(colorsSpace: space, colors: colors as CFArray, locations: locations)!
  c.saveGState()
  c.translateBy(x: p.x, y: p.y)
  c.scaleBy(x: rx / ry, y: 1)
  c.drawRadialGradient(
    g, startCenter: .zero, startRadius: 0, endCenter: .zero, endRadius: ry, options: [.drawsAfterEndLocation])
  c.restoreGState()
}

/// 16 бит → 8 бит с треугольным шумом в ±1 уровень (зерно постоянное — PNG от запуска к запуску
/// не меняются): градиент стекла без полос.
func dithered(_ deep: CGContext) -> CGImage {
  let out = makeContext(opaque: true)
  let src = deep.data!.assumingMemoryBound(to: UInt16.self)
  let dst = out.data!.assumingMemoryBound(to: UInt8.self)
  let srcRow = deep.bytesPerRow / 2
  let dstRow = out.bytesPerRow
  var seed: UInt32 = 0x9E37_79B9
  func noise() -> Float {
    seed ^= seed << 13
    seed ^= seed >> 17
    seed ^= seed << 5
    return Float(seed) / Float(UInt32.max)
  }
  for y in 0..<size {
    for x in 0..<size {
      for ch in 0..<3 {
        let v = Float(src[y * srcRow + x * 4 + ch]) / 257 + noise() - noise()
        dst[y * dstRow + x * 4 + ch] = UInt8(max(0, min(255, v.rounded())))
      }
      dst[y * dstRow + x * 4 + 3] = 255
    }
  }
  return out.makeImage()!
}

/// Ровный основной фон плитки — без разделений сверху/снизу и без полос.
/// Плитка непрозрачная: iOS и Play альфу не принимают.
func glass() -> CGImage {
  let c = makeContext(opaque: true, deep: true)
  c.setFillColor(rgb(GLASS_MID))
  c.fill(CGRect(x: -4096, y: -4096, width: 9216, height: 9216))
  return dithered(c)
}

// Внутри камеры — ровный голубой фон (без полосы посередине).
let eqCtx = makeContext(opaque: false)
eqCtx.setFillColor(rgb(EQ_FILL))
eqCtx.fill(CGRect(x: -4096, y: -4096, width: 9216, height: 9216))
eqCtx.setFillColor(rgb(0xFFFFFF, 0.10))
eqCtx.fill(CGRect(x: -4096, y: -4096, width: 9216, height: 9216))
let frosted = blurred(eqCtx.makeImage()!, radius: 8 * px)

func write(_ image: CGImage) {
  let url = URL(fileURLWithPath: out) as CFURL
  let dest = CGImageDestinationCreateWithURL(url, UTType.png.identifier as CFString, 1, nil)!
  CGImageDestinationAddImage(dest, image, nil)
  CGImageDestinationFinalize(dest)
  print("wrote \(out) \(size)px \(mode)")
}

// --- Main canvas. ---
let ctx = makeContext(opaque: mode == "full" || mode == "background")
// Фон — объёмное стекло; на переднем слое — только камера.
if mode == "full" || mode == "background" {
  drawDeviceImage(ctx, glass())
}
if mode == "background" {
  write(ctx.makeImage()!)
  exit(0)
}

// Лёгкая нейтральная тень — рамка остаётся чистой и хорошо читаемой.
for shape in glassShapes {
  ctx.saveGState()
  ctx.setShadow(offset: CGSize(width: 0, height: -5 * px), blur: 14 * px, color: rgb(0x000000, 0.16))
  ctx.addPath(shape.path)
  ctx.setFillColor(rgb(GLASS_MID))
  ctx.fillPath()
  ctx.restoreGState()
}

// Ровная голубая рамка, как в исходной версии иконки.
let rimGradient = CGGradient(
  colorsSpace: space,
  colors: [rgb(ACCENT, 0.98), rgb(ACCENT, 0.98), rgb(ACCENT, 0.98)] as CFArray,
  locations: [0, 0.5, 1])!

for shape in glassShapes {
  // Заливка в тонах эквалайзера; блик сверху минимальный (оттенок как снизу).
  ctx.saveGState()
  ctx.addPath(shape.path)
  ctx.clip()
  drawDeviceImage(ctx, frosted)
  // Ровная лёгкая белая вуаль (фон, не пятна).
  ctx.setFillColor(rgb(0xFFFFFF, 0.06))
  ctx.fill(CGRect(x: 0, y: 0, width: 1024, height: 1024))
  if shape.highlight.alpha > 0.01 {
    let highlight = CGGradient(
      colorsSpace: space,
      colors: [rgb(0xFFFFFF, shape.highlight.alpha), rgb(0xFFFFFF, 0)] as CFArray,
      locations: [0, 1])!
    ctx.drawLinearGradient(
      highlight, start: CGPoint(x: 0, y: shape.top),
      end: CGPoint(x: 0, y: shape.top + (shape.bottom - shape.top) * shape.highlight.span), options: [])
  }
  ctx.restoreGState()
  // Кромка.
  ctx.saveGState()
  ctx.addPath(shape.path)
  ctx.setLineWidth(rimWidth)
  ctx.replacePathWithStrokedPath()
  ctx.clip()
  ctx.drawLinearGradient(
    rimGradient, start: CGPoint(x: 0, y: shape.top), end: CGPoint(x: 0, y: shape.bottom),
    options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
  ctx.restoreGState()
}

write(ctx.makeImage()!)
