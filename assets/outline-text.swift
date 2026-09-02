// Turn a line of text into SVG path data with CoreText, so an SVG wordmark no
// longer depends on the viewer having the font. Kerning comes from the font's
// own tables, exactly as macOS would lay the text out.
//
//   swift assets/outline-text.swift "Understudy" AvenirNext-Bold 185 547 629
//
// Arguments: text, PostScript font name, size in px, x of the centre (like
// text-anchor="middle"), y of the baseline. Prints the `d` attribute; the font
// name, advance width, and start x go to stderr.
import CoreGraphics
import CoreText
import Foundation

let args = CommandLine.arguments
guard args.count == 6, let size = Double(args[3]), let centerX = Double(args[4]), let baseline = Double(args[5]) else {
  FileHandle.standardError.write("usage: outline-text.swift <text> <ps-font-name> <size> <centerX> <baselineY>\n".data(using: .utf8)!)
  exit(2)
}
let font = CTFontCreateWithName(args[2] as CFString, CGFloat(size), nil)
let line = CTLineCreateWithAttributedString(
  NSAttributedString(string: args[1], attributes: [NSAttributedString.Key(kCTFontAttributeName as String): font]))
let width = CTLineGetTypographicBounds(line, nil, nil, nil)
let startX = CGFloat(centerX) - CGFloat(width) / 2
FileHandle.standardError.write(
  "font=\(CTFontCopyPostScriptName(font)) width=\(width) startX=\(startX)\n".data(using: .utf8)!)

func num(_ v: CGFloat) -> String {
  var s = String(format: "%.2f", v)
  while s.hasSuffix("0") { s.removeLast() }
  if s.hasSuffix(".") { s.removeLast() }
  return s == "-0" ? "0" : s
}

var d = ""
for run in CTLineGetGlyphRuns(line) as! [CTRun] {
  let count = CTRunGetGlyphCount(run)
  var glyphs = [CGGlyph](repeating: 0, count: count)
  var positions = [CGPoint](repeating: .zero, count: count)
  CTRunGetGlyphs(run, CFRangeMake(0, count), &glyphs)
  CTRunGetPositions(run, CFRangeMake(0, count), &positions)
  let runFont = (CTRunGetAttributes(run) as NSDictionary)[kCTFontAttributeName as String] as! CTFont
  for i in 0..<count {
    guard let path = CTFontCreatePathForGlyph(runFont, glyphs[i], nil) else { continue }
    let ox = startX + positions[i].x
    let oy = CGFloat(baseline) - positions[i].y
    path.applyWithBlock { element in
      let p = element.pointee.points
      switch element.pointee.type {
      case .moveToPoint: d += "M\(num(ox + p[0].x)) \(num(oy - p[0].y))"
      case .addLineToPoint: d += "L\(num(ox + p[0].x)) \(num(oy - p[0].y))"
      case .addQuadCurveToPoint: d += "Q\(num(ox + p[0].x)) \(num(oy - p[0].y)) \(num(ox + p[1].x)) \(num(oy - p[1].y))"
      case .addCurveToPoint: d += "C\(num(ox + p[0].x)) \(num(oy - p[0].y)) \(num(ox + p[1].x)) \(num(oy - p[1].y)) \(num(ox + p[2].x)) \(num(oy - p[2].y))"
      case .closeSubpath: d += "Z"
      @unknown default: break
      }
    }
  }
}
print(d)
