import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

let palette = CGColorSpace(name: CGColorSpace.sRGB)!

func color(_ hex: Int, alpha: CGFloat = 1) -> CGColor {
    CGColor(srgbRed: CGFloat((hex >> 16) & 255) / 255,
            green: CGFloat((hex >> 8) & 255) / 255,
            blue: CGFloat(hex & 255) / 255, alpha: alpha)
}

func gradient(_ context: CGContext, _ colors: [CGColor], from: CGPoint, to: CGPoint) {
    let paint = CGGradient(colorsSpace: palette, colors: colors as CFArray, locations: nil)!
    context.drawLinearGradient(paint, start: from, end: to,
                               options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
}

func drawIcon(size: Int) -> CGImage {
    let context = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8,
                            bytesPerRow: 0, space: palette,
                            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    let scale = CGFloat(size) / 1024
    context.scaleBy(x: scale, y: scale)

    let tile = CGPath(roundedRect: CGRect(x: 100, y: 108, width: 824, height: 824),
                      cornerWidth: 188, cornerHeight: 188, transform: nil)
    context.saveGState()
    context.setShadow(offset: CGSize(width: 0, height: -18 * scale),
                      blur: 44 * scale, color: color(0x180936, alpha: 0.37))
    context.setFillColor(color(0x472BC9))
    context.addPath(tile)
    context.fillPath()
    context.restoreGState()

    context.saveGState()
    context.addPath(tile)
    context.clip()
    gradient(context, [color(0x8067FF), color(0x583DE7), color(0x3C26B4)],
             from: CGPoint(x: 230, y: 925), to: CGPoint(x: 770, y: 115))
    context.setStrokeColor(color(0xEBE3FF, alpha: 0.28))
    context.setLineWidth(6)
    context.addPath(tile)
    context.strokePath()
    context.restoreGState()

    let book = CGMutablePath()
    book.move(to: CGPoint(x: 512, y: 668))
    book.addQuadCurve(to: CGPoint(x: 281, y: 729), control: CGPoint(x: 425, y: 731))
    book.addQuadCurve(to: CGPoint(x: 251, y: 698), control: CGPoint(x: 251, y: 729))
    book.addLine(to: CGPoint(x: 251, y: 420))
    book.addQuadCurve(to: CGPoint(x: 286, y: 386), control: CGPoint(x: 251, y: 389))
    book.addQuadCurve(to: CGPoint(x: 497, y: 334), control: CGPoint(x: 409, y: 386))
    book.addQuadCurve(to: CGPoint(x: 527, y: 334), control: CGPoint(x: 512, y: 324))
    book.addQuadCurve(to: CGPoint(x: 738, y: 386), control: CGPoint(x: 615, y: 386))
    book.addQuadCurve(to: CGPoint(x: 773, y: 420), control: CGPoint(x: 773, y: 389))
    book.addLine(to: CGPoint(x: 773, y: 698))
    book.addQuadCurve(to: CGPoint(x: 743, y: 729), control: CGPoint(x: 773, y: 729))
    book.addQuadCurve(to: CGPoint(x: 512, y: 668), control: CGPoint(x: 599, y: 731))
    book.closeSubpath()

    context.saveGState()
    context.setShadow(offset: CGSize(width: 0, height: -12 * scale),
                      blur: 25 * scale, color: color(0x24105F, alpha: 0.45))
    context.setFillColor(color(0xEEE7FF))
    context.addPath(book)
    context.fillPath()
    context.restoreGState()
    context.saveGState()
    context.addPath(book)
    context.clip()
    gradient(context, [color(0xFFFFFF), color(0xE6DCFF)],
             from: CGPoint(x: 450, y: 730), to: CGPoint(x: 550, y: 330))
    context.restoreGState()

    // The waveform echoes the five-bar mark in the Reader interface.
    let heights: [CGFloat] = [66, 112, 174, 126, 78]
    context.saveGState()
    context.setFillColor(color(0x5D40DB))
    for (index, height) in heights.enumerated() {
        let center = CGFloat(376 + index * 68)
        let bar = CGRect(x: center - 20, y: 539 - height / 2, width: 40, height: height)
        context.addPath(CGPath(roundedRect: bar, cornerWidth: 20, cornerHeight: 20, transform: nil))
        context.fillPath()
    }
    context.setStrokeColor(color(0xBEACFA))
    context.setLineWidth(11)
    context.setLineCap(.round)
    context.move(to: CGPoint(x: 512, y: 357))
    context.addLine(to: CGPoint(x: 512, y: 411))
    context.strokePath()
    context.restoreGState()
    return context.makeImage()!
}

func writeIcon(size: Int, to file: URL) throws {
    guard let image = CGImageDestinationCreateWithURL(file as CFURL, UTType.png.identifier as CFString, 1, nil) else {
        throw CocoaError(.fileWriteUnknown)
    }
    CGImageDestinationAddImage(image, drawIcon(size: size), nil)
    guard CGImageDestinationFinalize(image) else { throw CocoaError(.fileWriteUnknown) }
}

let iconset = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
try FileManager.default.createDirectory(at: iconset, withIntermediateDirectories: true)
for points in [16, 32, 128, 256, 512] {
    let name = "icon_\(points)x\(points)"
    try writeIcon(size: points, to: iconset.appending(path: "\(name).png"))
    try writeIcon(size: points * 2, to: iconset.appending(path: "\(name)@2x.png"))
}
