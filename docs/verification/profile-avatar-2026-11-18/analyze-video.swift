import Foundation
import AVFoundation
import AppKit
import CoreVideo
let asset = AVURLAsset(url: URL(fileURLWithPath: CommandLine.arguments[1]))
let track = asset.tracks(withMediaType: .video)[0]
let reader = try AVAssetReader(asset: asset)
let output = AVAssetReaderTrackOutput(track: track, outputSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA])
reader.add(output)
reader.startReading()
var frames = 0, profileFrames = 0, visibleFrames = 0, blankAfterPhoto = 0, greenFrames = 0
var started = false
var bestGreen = 0
var rows: [[String: Any]] = []
while let sample = output.copyNextSampleBuffer(), let buf = CMSampleBufferGetImageBuffer(sample) {
 CVPixelBufferLockBaseAddress(buf, .readOnly)
 let data = CVPixelBufferGetBaseAddress(buf)!.assumingMemoryBound(to: UInt8.self)
 let stride = CVPixelBufferGetBytesPerRow(buf)
 let width = CVPixelBufferGetWidth(buf), height = CVPixelBufferGetHeight(buf)
 func rgb(_ x: Int, _ y: Int) -> (Double, Double, Double) {
  let i = y * stride + x * 4
  return (Double(data[i+2]), Double(data[i+1]), Double(data[i]))
 }
 let outside = rgb(35, 340)
 let selectedTab = rgb(960, 2090)
 let isProfile = width == 1080 && height == 2340 && abs(outside.0-37)<7 && abs(outside.1-43)<7 && abs(outside.2-52)<7 && selectedTab.1 > selectedTab.0 * 1.3 && selectedTab.2 > selectedTab.1
 let time = CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(sample))
 var std = 0.0, green = 0
 if isProfile {
  profileFrames += 1
  var sums = [0.0,0,0], squares = [0.0,0,0], count = 0.0
  for y in Swift.stride(from: 240, to: 460, by: 8) {
   for x in Swift.stride(from: 440, to: 640, by: 8) {
    let p = rgb(x,y), channels = [p.0,p.1,p.2]
    for c in 0...2 { sums[c] += channels[c]; squares[c] += channels[c]*channels[c] }
    count += 1
    if p.1 > 100 && p.1 > p.0*1.6 && p.1 > p.2*1.15 { green += 1 }
   }
  }
  std = sqrt((0...2).map { max(0, squares[$0]/count-pow(sums[$0]/count,2)) }.reduce(0,+)/3)
  if std > 10 { started = true; visibleFrames += 1 }
  if started && std < 5 { blankAfterPhoto += 1 }
  if green > 12 { greenFrames += 1 }
  if green > bestGreen {
   bestGreen = green
   if let image = VTCreateCGImageFromCVPixelBufferHelper(buf), let png = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]) {
    try png.write(to: URL(fileURLWithPath: CommandLine.arguments[2]))
   }
  }
  rows.append(["time":time,"photoStd":std,"greenSamples":green])
 }
 frames += 1
 CVPixelBufferUnlockBaseAddress(buf, .readOnly)
}
let report: [String: Any] = ["decodedFrames":frames,"profileFrames":profileFrames,"photoVisibleFrames":visibleFrames,"blankFramesAfterPhotoAppeared":blankAfterPhoto,"greenCheckFrames":greenFrames,"samples":rows]
let json = try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted,.sortedKeys])
try json.write(to: URL(fileURLWithPath: CommandLine.arguments[3]))
print("frames=\(frames) profile=\(profileFrames) photo=\(visibleFrames) blankAfterPhoto=\(blankAfterPhoto) greenCheck=\(greenFrames)")
import VideoToolbox
func VTCreateCGImageFromCVPixelBufferHelper(_ pixel: CVPixelBuffer) -> CGImage? {
 var image: CGImage?
 VTCreateCGImageFromCVPixelBuffer(pixel, options: nil, imageOut: &image)
 return image
}
