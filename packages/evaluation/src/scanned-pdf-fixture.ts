import { existsSync } from 'node:fs';
import { createCanvas, GlobalFonts, PDFDocument, type SKRSContext2D } from '@napi-rs/canvas';

const pageWidth = 700;
const pageHeight = 900;
const rasterScale = 2;

/** 每页先绘成位图再嵌进 PDF，确保没有可供 pdf.js 提取的文字层。 */
export function createSyntheticTwoPageScannedPdf(): Buffer {
  const fontPath = [
    '/System/Library/Fonts/STHeiti Medium.ttc',
    '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
    'C:\\Windows\\Fonts\\msyh.ttc'
  ].find((path) => existsSync(path));
  if (fontPath) GlobalFonts.registerFromPath(fontPath, 'SyntheticCJK');
  const fontFamily = fontPath ? 'SyntheticCJK' : 'sans-serif';
  const document = new PDFDocument({
    title: '纯合成双页扫描检验报告',
    author: 'Family Health Synthetic Fixture Generator',
    creator: 'family-health-desktop',
    producer: 'Skia/PDF',
    compressionLevel: 9
  });
  const pages = [
    [
      '血液检查报告',
      '记录编号：SIM-2025-01',
      '姓名：合成成员',
      '检查日期：2025-06-10',
      '血脂检查',
      '低密度脂蛋白胆固醇 LDL-C：4.2 mmol/L',
      '参考范围：0-3.4 mmol/L；报告标记：偏高',
      '血糖项目续下页'
    ],
    [
      '血液检查报告（续页）',
      '记录编号：SIM-2025-01',
      '空腹血糖：5.1 mmol/L',
      '参考范围：3.9-6.1 mmol/L',
      '检验小结：LDL-C 高于报告参考上限；空腹血糖在报告范围内。'
    ]
  ];
  pages.forEach((lines, pageIndex) => {
    const raster = createCanvas(pageWidth * rasterScale, pageHeight * rasterScale);
    const context = raster.getContext('2d');
    context.fillStyle = '#fffdf8';
    context.fillRect(0, 0, raster.width, raster.height);
    context.fillStyle = '#243b30';
    context.font = `bold 58px ${fontFamily}`;
    context.fillText(lines[0]!, 90, 130);
    context.font = `32px ${fontFamily}`;
    lines.slice(1).forEach((line, index) => context.fillText(line, 90, 260 + index * 160));
    context.font = `25px ${fontFamily}`;
    context.fillText(`第 ${pageIndex + 1} / 2 页`, 90, 1690);
    const page = document.beginPage(pageWidth, pageHeight) as SKRSContext2D;
    page.drawImage(raster, 0, 0, pageWidth, pageHeight);
    document.endPage();
  });
  return document.close();
}
