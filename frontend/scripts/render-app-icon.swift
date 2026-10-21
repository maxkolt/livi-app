// Renders the canonical LiVi camera outline as crisp PNG artwork at any size.
// Usage: swiftc -O scripts/render-app-icon.swift -o /tmp/render-app-icon
//        /tmp/render-app-icon <full|foreground|background|logo|splashicon|wide> <size> <out.png>
//
// full        — opaque launcher tile.
// foreground  — Android adaptive foreground; the camera interior stays slate.
// background  — solid Android adaptive background.
// logo        — transparent, larger camera for the regular splash screen.
// splashicon  — transparent camera sized for the Android 12 splash circle.
// wide        — transparent camera for cam-off and system PiP placeholders.
//
// The artwork is drawn as exact vector paths on a 4x supersampled canvas and
// downsampled once. This keeps straight runs, corner radii and the lens outline
// uniform even in the small launcher and favicon exports.
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

private let backgroundHex: UInt32 = 0x3E4E62
private let outlineHex: UInt32 = 0x50A5D0
private let designSize: CGFloat = 1024
private let supersampling = 4

private func rgb(_ hex: UInt32, alpha: CGFloat = 1) -> CGColor {
  CGColor(
    srgbRed: CGFloat((hex >> 16) & 0xff) / 255,
    green: CGFloat((hex >> 8) & 0xff) / 255,
    blue: CGFloat(hex & 0xff) / 255,
    alpha: alpha)
}

private func roundedPolygon(_ points: [CGPoint], radius: CGFloat) -> CGPath {
  let path = CGMutablePath()
  let count = points.count
  let start = CGPoint(
    x: (points[0].x + points[1].x) / 2,
    y: (points[0].y + points[1].y) / 2)
  path.move(to: start)
  for index in 1...count {
    let corner = points[index % count]
    let next = points[(index + 1) % count]
    path.addArc(tangent1End: corner, tangent2End: next, radius: radius)
  }
  path.closeSubpath()
  return path
}

private func makeContext(size: Int, opaque: Bool) -> CGContext {
  let space = CGColorSpace(name: CGColorSpace.sRGB)!
  let alpha: CGImageAlphaInfo = opaque ? .noneSkipLast : .premultipliedLast
  let context = CGContext(
    data: nil,
    width: size,
    height: size,
    bitsPerComponent: 8,
    bytesPerRow: 0,
    space: space,
    bitmapInfo: alpha.rawValue)!
  context.setShouldAntialias(true)
  context.setAllowsAntialiasing(true)
  context.interpolationQuality = .high
  return context
}

private func writePNG(_ image: CGImage, to path: String) {
  let destination = CGImageDestinationCreateWithURL(
    URL(fileURLWithPath: path) as CFURL,
    UTType.png.identifier as CFString,
    1,
    nil)!
  CGImageDestinationAddImage(destination, image, nil)
  precondition(CGImageDestinationFinalize(destination), "Could not write \(path)")
}

let arguments = CommandLine.arguments
guard arguments.count == 4,
      ["full", "foreground", "background", "logo", "splashicon", "wide"].contains(arguments[1]),
      let outputSize = Int(arguments[2]), outputSize > 0
else {
  fputs("usage: render-app-icon <full|foreground|background|logo|splashicon|wide> <size> <out.png>\n", stderr)
  exit(2)
}

let mode = arguments[1]
let outputPath = arguments[3]
let opaque = mode == "full" || mode == "background"
let workSize = outputSize * supersampling
let work = makeContext(size: workSize, opaque: opaque)

// Work in a stable 1024x1024, top-left-origin design space.
work.translateBy(x: 0, y: CGFloat(workSize))
work.scaleBy(
  x: CGFloat(workSize) / designSize,
  y: -CGFloat(workSize) / designSize)

if opaque {
  work.setFillColor(rgb(backgroundHex))
  work.fill(CGRect(x: 0, y: 0, width: designSize, height: designSize))
}

if mode != "background" {
  // The base geometry reproduces the current 1024px launcher's visual bounds:
  // x 254...769, y 360...665. Only the mathematically clean paths differ.
  let groupScale: CGFloat =
    mode == "logo" ? 1.428 : mode == "splashicon" ? 0.98 : mode == "wide" ? 1.79 : 1
  work.translateBy(x: designSize / 2, y: designSize / 2)
  work.scaleBy(x: groupScale, y: groupScale)
  work.translateBy(x: -designSize / 2, y: -designSize / 2)

  let body = CGRect(x: 260, y: 366, width: 366, height: 294)
  let bodyPath = CGPath(
    roundedRect: body,
    cornerWidth: 78,
    cornerHeight: 78,
    transform: nil)
  let lensPath = roundedPolygon(
    [
      CGPoint(x: 653, y: 453),
      CGPoint(x: 764, y: 401),
      CGPoint(x: 764, y: 623),
      CGPoint(x: 653, y: 571),
    ],
    radius: 22)

  // Adaptive foregrounds keep the camera interior equal to the locked slate
  // background. Splash marks remain true transparent outlines.
  if mode == "foreground" {
    work.setFillColor(rgb(backgroundHex))
    work.addPath(bodyPath)
    work.addPath(lensPath)
    work.fillPath()
  }

  work.setStrokeColor(rgb(outlineHex))
  work.setLineWidth(11)
  work.setLineCap(.round)
  work.setLineJoin(.round)
  work.addPath(bodyPath)
  work.addPath(lensPath)
  work.strokePath()
}

let rendered = work.makeImage()!
let output = makeContext(size: outputSize, opaque: opaque)
// Bilinear reduction avoids the dark/light ringing that a sharpening Lanczos
// pass can add beside a thin brand stroke.
output.interpolationQuality = .medium
output.draw(rendered, in: CGRect(x: 0, y: 0, width: outputSize, height: outputSize))
let finalImage = output.makeImage()!
writePNG(finalImage, to: outputPath)
print("wrote \(outputPath) \(outputSize)px \(mode)")
