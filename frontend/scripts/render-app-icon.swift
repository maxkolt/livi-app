// Renders the LiVi app icon (slate + ice-blue glass, 2026-10-06) as crisp art at any size.
// Usage: swiftc -O scripts/render-app-icon.swift -o /tmp/render-app-icon
//        /tmp/render-app-icon <full|foreground|logo|splashicon> <size> <out.png>
// full — opaque tile on ICON_BG (iOS AppIcon, assets/icon.png, Play 512, legacy mipmaps);
// foreground — transparent Android adaptive foreground (safe zone), background = @color/iconBackground.
// logo — transparent camera only, no radar rings, filling the canvas (splash: assets/splash-icon.png,
//        drawable-*/splashscreen_logo 288/432/576/864/1152, iOS SplashScreenLogo 1024).
// splashicon — same logo inside the Android 12+ splash circle
//        (drawable-*/splashscreen_icon 288/432/576/864/1152, values-v31 windowSplashScreenAnimatedIcon).
// Sizes: ic_launcher / ic_launcher_round 48/72/96/144/192, ic_launcher_foreground 108/162/216/324/432.
//
// Style — как стекло в приложении: камера — матовое стекло (размытый фон под ним, светлая
// дымка, блик сверху, светлая кромка, мягкая тень снизу). Эквалайзер на стекле яркий —
// значок читается и на 48 px, и на сплэше. Цветных шаров за стеклом нет (убраны по просьбе).
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

/// Фон иконки — заметно светлее фона приложения, тоном приподнятых блоков (UI_SURFACE_RAISED);
/// = @color/iconBackground.
let ICON_BG: UInt32 = 0x414C59
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
// 66/108 safe circle (radius ≈ 313 of 1024), so the ring (r 432) is scaled to ~300.
// logo: no rings, camera fills most of the width. splashicon must fit the 192/288 dp circle.
let k: CGFloat = mode == "full" ? 1.0 : mode == "logo" ? 1.30 : mode == "splashicon" ? 0.85 : 0.70
let ringless = mode == "logo" || mode == "splashicon"
/// Что лежит под стеклом: фон плитки иконки или фон сплэша.
let sceneBG = ringless ? SPLASH_BG : ICON_BG
/// Design units → device pixels (CTM does not scale shadow blur or CoreImage radii).
let px = S / 1024 * k
/// Rim width in design units: icons are shown at 48–192 px, so their rim is thicker.
let rimWidth: CGFloat = ringless ? 9 : mode == "foreground" ? 13 : 11

func makeContext(opaque: Bool) -> CGContext {
  let c = CGContext(
    data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0, space: space,
    // Полная плитка — без альфа-канала (App Store его не принимает); остальные — с прозрачностью.
    bitmapInfo: (opaque ? CGImageAlphaInfo.noneSkipLast : CGImageAlphaInfo.premultipliedLast).rawValue)!
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
let body = CGRect(x: 196, y: 306, width: 462, height: 412)
let bodyRadius: CGFloat = 116
let cy = body.midY
// Lens: trapezoid, short edge at the body, tall edge outside; rounded corners.
let lensL: CGFloat = 690, lensR: CGFloat = 830
let lensInnerHalf: CGFloat = 74, lensOuterHalf: CGFloat = 170
let lensRadius: CGFloat = 34

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
/// Блик под верхней кромкой (яркость, доля высоты). На сплэше у корпуса слабее и короче —
/// меньше светлой заливки под рамкой (2026-10-08); иконка и объектив — как были.
let bodyHighlight: (alpha: CGFloat, span: CGFloat) = ringless ? (0.08, 0.42) : (0.16, 0.55)
let glassShapes: [(path: CGPath, top: CGFloat, bottom: CGFloat, highlight: (alpha: CGFloat, span: CGFloat))] = [
  (bodyPath, body.minY, body.maxY, bodyHighlight),
  (lensPath, cy - lensOuterHalf, cy + lensOuterHalf, (0.16, 0.55)),
]

// --- Scene behind the glass: background and radar rings. ---
func drawScene(_ c: CGContext, background: Bool) {
  if background {
    c.setFillColor(rgb(sceneBG))
    c.fill(CGRect(x: -4096, y: -4096, width: 9216, height: 9216))
  }
  if !ringless {
    // Радар «Поиска»: тонкое кольцо и пунктирный обод в тоне акцента.
    c.saveGState()
    c.setStrokeColor(rgb(ACCENT, 0.12))
    c.setLineWidth(5)
    c.addEllipse(in: CGRect(x: center.x - 398, y: center.y - 398, width: 796, height: 796))
    c.strokePath()
    c.setStrokeColor(rgb(ACCENT, 0.42))
    c.setLineWidth(7)
    c.setLineCap(.round)
    let period = 2 * CGFloat.pi * 432 / 56
    c.setLineDash(phase: 0, lengths: [period * 0.46, period * 0.54])
    c.addEllipse(in: CGRect(x: center.x - 432, y: center.y - 432, width: 864, height: 864))
    c.strokePath()
    c.restoreGState()
  }
}

func blurred(_ img: CGImage, radius: CGFloat) -> CGImage {
  let input = CIImage(cgImage: img)
  guard let f = CIFilter(name: "CIGaussianBlur") else { return img }
  f.setValue(input.clampedToExtent(), forKey: kCIInputImageKey)
  f.setValue(radius, forKey: kCIInputRadiusKey)
  guard let output = f.outputImage else { return img }
  let ci = CIContext(options: [
    .useSoftwareRenderer: true,
    .workingColorSpace: space,
    .outputColorSpace: space,
  ])
  return ci.createCGImage(output.cropped(to: input.extent), from: input.extent) ?? img
}

// Под стеклом всегда фон сцены: у иконки — ICON_BG (= фон адаптивной иконки), на сплэше — SPLASH_BG.
let sceneCtx = makeContext(opaque: false)
drawScene(sceneCtx, background: true)
let frosted = blurred(sceneCtx.makeImage()!, radius: 26 * px)

// --- Main canvas. ---
let ctx = makeContext(opaque: mode == "full")
drawScene(ctx, background: mode == "full")

// Мягкая тень стекла на фон.
for shape in glassShapes {
  ctx.saveGState()
  ctx.setShadow(offset: CGSize(width: 0, height: -14 * px), blur: 38 * px, color: rgb(0x000000, 0.42))
  ctx.addPath(shape.path)
  ctx.setFillColor(rgb(sceneBG))
  ctx.fillPath()
  ctx.restoreGState()
}

let rimGradient = CGGradient(
  colorsSpace: space,
  // Светлая сверху и снизу (снизу чуть мягче), темнее посередине — стекло видно по всему контуру.
  colors: [rgb(0xFFFFFF, 0.78), rgb(ACCENT_LIGHT, 0.38), rgb(0xFFFFFF, 0.62)] as CFArray,
  locations: [0, 0.5, 1])!

for shape in glassShapes {
  // Матовое стекло: размытая сцена + светлая дымка + блик в верхней части.
  ctx.saveGState()
  ctx.addPath(shape.path)
  ctx.clip()
  drawDeviceImage(ctx, frosted)
  ctx.setFillColor(rgb(0xFFFFFF, 0.08))
  ctx.fill(CGRect(x: 0, y: 0, width: 1024, height: 1024))
  let highlight = CGGradient(
    colorsSpace: space, colors: [rgb(0xFFFFFF, shape.highlight.alpha), rgb(0xFFFFFF, 0)] as CFArray,
    locations: [0, 1])!
  ctx.drawLinearGradient(
    highlight, start: CGPoint(x: 0, y: shape.top),
    end: CGPoint(x: 0, y: shape.top + (shape.bottom - shape.top) * shape.highlight.span), options: [])
  ctx.restoreGState()
  // Кромка: светлая сверху и снизу.
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

// --- Waveform bars on the glass. ---
let heights: [CGFloat] = [64, 128, 206, 286, 206, 128, 64]
let barW: CGFloat = 30
let gap: CGFloat = 26
let total = CGFloat(heights.count) * barW + CGFloat(heights.count - 1) * gap
var x = body.midX - total / 2
let barFill = CGGradient(
  colorsSpace: space, colors: [rgb(0xFFFFFF), rgb(0xA3D4EE)] as CFArray, locations: [0, 1])!
for h in heights {
  let r = CGRect(x: x, y: cy - h / 2, width: barW, height: h)
  let bar = CGPath(roundedRect: r, cornerWidth: barW / 2, cornerHeight: barW / 2, transform: nil)
  ctx.saveGState()
  // Мягкая голубая дымка вокруг полосок.
  ctx.setShadow(offset: .zero, blur: 22 * px, color: rgb(ACCENT, 0.8))
  ctx.addPath(bar)
  ctx.setFillColor(rgb(ACCENT_LIGHT))
  ctx.fillPath()
  ctx.restoreGState()
  ctx.saveGState()
  ctx.addPath(bar)
  ctx.clip()
  ctx.drawLinearGradient(
    barFill, start: CGPoint(x: 0, y: cy - 150), end: CGPoint(x: 0, y: cy + 150),
    options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
  ctx.restoreGState()
  x += barW + gap
}

let image = ctx.makeImage()!
let url = URL(fileURLWithPath: out) as CFURL
let dest = CGImageDestinationCreateWithURL(url, UTType.png.identifier as CFString, 1, nil)!
CGImageDestinationAddImage(dest, image, nil)
CGImageDestinationFinalize(dest)
print("wrote \(out) \(size)px \(mode)")
