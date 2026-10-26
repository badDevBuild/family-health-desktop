import Foundation
import Vision
import CoreImage
import ImageIO

// 只在本机识别已有图像；不请求网络，也不以语言纠正改写医学数字。
struct TextLine: Encodable {
    let text: String
    let confidence: Float
    let bounds: [Double]
}
struct TextReceipt: Encodable {
    let version: Int
    let engine: String
    let lines: [TextLine]
    let imageSize: ImageSize
    let recognitionRevision: Int
}
struct ImageSize: Encodable { let width: Int; let height: Int }

func fail(_ code: String, _ status: Int32) -> Never {
    // 固定分类不包含系统错误描述、文件路径或报告内容。
    FileHandle.standardError.write(Data("\(code)\n".utf8))
    exit(status)
}

let arguments = Array(CommandLine.arguments.dropFirst())
guard let path = arguments.first else { fail("LOCAL_VISUAL_ARGUMENT_INVALID", 64) }
var region: CGRect? = nil
var prepared = false
var index = 1
while index < arguments.count {
    if arguments[index] == "--prepared" { prepared = true; index += 1; continue }
    if arguments[index] == "--region", index + 4 < arguments.count {
        let values = arguments[(index + 1)...(index + 4)].compactMap(Double.init)
        guard values.count == 4, values.allSatisfy({ $0.isFinite }),
              values[0] >= 0, values[1] >= 0, values[2] > 0, values[3] > 0,
              values[0] + values[2] <= 1.000001, values[1] + values[3] <= 1.000001 else {
            fail("LOCAL_VISUAL_ARGUMENT_INVALID", 64)
        }
        region = CGRect(x: values[0], y: values[1], width: values[2], height: values[3])
        index += 5; continue
    }
    fail("LOCAL_VISUAL_ARGUMENT_INVALID", 64)
}
guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
      let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
    fail("LOCAL_VISUAL_IMAGE_DECODE_FAILED", 65)
}
guard image.width > 0, image.height > 0, image.width <= 30000, image.height <= 30000,
      image.width * image.height <= 80_000_000 else {
    fail("LOCAL_VISUAL_IMAGE_DIMENSIONS_EXCEEDED", 67)
}
let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any]
let orientation = CGImagePropertyOrientation(rawValue: (properties?[kCGImagePropertyOrientation] as? UInt32) ?? 1) ?? .up
let oriented = CIImage(cgImage: image).oriented(orientation)
let originalExtent = oriented.extent
var inputImage = oriented.transformed(by: CGAffineTransform(translationX: -originalExtent.minX, y: -originalExtent.minY))
let originalWidth = inputImage.extent.width
let originalHeight = inputImage.extent.height
if let area = region {
    // 裁剪的坐标来自原页归一化位置；结果稍后映回原页，而不是借候选值定位。
    let pixels = CGRect(x: area.minX * originalWidth, y: area.minY * originalHeight,
                        width: area.width * originalWidth, height: area.height * originalHeight)
    inputImage = inputImage.cropped(to: pixels).transformed(by: CGAffineTransform(translationX: -pixels.minX, y: -pixels.minY))
}
if prepared {
    // 一次有界回退：重建标准RGB图像并控制分辨率，不用语言纠正或插入预期文字。
    let extent = inputImage.extent
    let scale = min(1.5, 4096 / max(extent.width, extent.height))
    inputImage = inputImage.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
}
let context = CIContext(options: [.cacheIntermediates: false])
guard let recognizedImage = context.createCGImage(inputImage, from: inputImage.extent,
                                                   format: .RGBA8, colorSpace: CGColorSpaceCreateDeviceRGB()) else {
    fail("LOCAL_VISUAL_IMAGE_PREPARATION_FAILED", 68)
}
do {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = false
    let supported = try request.supportedRecognitionLanguages()
    request.recognitionLanguages = ["zh-Hans", "en-US"].filter { supported.contains($0) }
    let handler = VNImageRequestHandler(cgImage: recognizedImage, orientation: .up, options: [:])
    try handler.perform([request])
    let observations = (request.results ?? []).sorted { left, right in
        if abs(left.boundingBox.midY - right.boundingBox.midY) > 0.012 {
            return left.boundingBox.midY > right.boundingBox.midY
        }
        return left.boundingBox.minX < right.boundingBox.minX
    }
    let lines = observations.compactMap { observation -> TextLine? in
        guard let text = observation.topCandidates(1).first else { return nil }
        let box = observation.boundingBox
        let original = region.map { area in
            CGRect(x: area.minX + box.minX * area.width, y: area.minY + box.minY * area.height,
                   width: box.width * area.width, height: box.height * area.height)
        } ?? box
        return TextLine(text: text.string, confidence: text.confidence,
                        bounds: [original.minX, original.minY, original.width, original.height])
    }
    let data = try JSONEncoder().encode(TextReceipt(version: 1, engine: "apple-vision-local-v1", lines: lines,
        imageSize: ImageSize(width: Int(originalWidth), height: Int(originalHeight)), recognitionRevision: request.revision))
    FileHandle.standardOutput.write(data)
} catch {
    // 不把含私人文件路径或原文的系统错误输出到日志。
    fail("LOCAL_VISUAL_VISION_REQUEST_FAILED", 66)
}
