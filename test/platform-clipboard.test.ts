// Clipboard image extraction on macOS without pngpaste. Puts REAL images on the
// general pasteboard (PNG, then TIFF-only), reads them back through the same
// clipboardImageBytes() that `-i clipboard` uses, and ALWAYS restores the user's
// previous clipboard (every item, every type) afterwards.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { IS_MAC, clipboardImageBytes, macClipboardScripts } from "../src/platform.ts";

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const isPng = (b: Uint8Array | null) => !!b && PNG_SIG.every((v, i) => b[i] === v);
const havePngpaste = (() => { try { return Bun.spawnSync(["which", "pngpaste"]).exitCode === 0; } catch { return false; } })();

function jxa(src: string): string {
  const r = Bun.spawnSync(["osascript", "-l", "JavaScript", "-e", src], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`osascript: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}
/** Every pasteboard item + type as base64, so restore is byte-exact (text, rich text, files…). */
const snapshotClipboard = (file: string) => jxa(`ObjC.import('AppKit');
var pb = $.NSPasteboard.generalPasteboard, items = pb.pasteboardItems, out = [];
for (var i = 0; i < items.count; i++) {
  var it = items.objectAtIndex(i), types = it.types, entry = {};
  for (var j = 0; j < types.count; j++) {
    var t = types.objectAtIndex(j), d = it.dataForType(t);
    if (d && !d.isNil()) entry[t.js] = d.base64EncodedStringWithOptions(0).js;
  }
  out.push(entry);
}
$(JSON.stringify(out)).writeToFileAtomicallyEncodingError("${file}", true, $.NSUTF8StringEncoding, null);
String(out.length)`);
const restoreClipboard = (file: string) => jxa(`ObjC.import('AppKit');
var s = $.NSString.stringWithContentsOfFileEncodingError("${file}", $.NSUTF8StringEncoding, null).js;
var snap = JSON.parse(s), pb = $.NSPasteboard.generalPasteboard, objs = [];
pb.clearContents;
snap.forEach(function (entry) {
  var it = $.NSPasteboardItem.alloc.init;
  Object.keys(entry).forEach(function (t) {
    it.setDataForType($.NSData.alloc.initWithBase64EncodedStringOptions(entry[t], 0), t);
  });
  objs.push(it);
});
if (objs.length) pb.writeObjects($(objs));
String(objs.length)`);
/** Put ONLY the given file's bytes on the pasteboard under one UTI. */
const setClipboardImage = (file: string, uti: string) => jxa(`ObjC.import('AppKit');
var pb = $.NSPasteboard.generalPasteboard; pb.clearContents;
String(pb.setDataForType($.NSData.dataWithContentsOfFile("${file}"), "${uti}"))`);
const setClipboardText = (text: string) => jxa(`ObjC.import('AppKit');
var pb = $.NSPasteboard.generalPasteboard; pb.clearContents;
String(pb.setStringForType("${text}", $.NSPasteboardTypeString))`);
const clipboardTypes = () => jxa(`ObjC.import('AppKit');
var ts = $.NSPasteboard.generalPasteboard.types, a = [];
for (var i = 0; i < ts.count; i++) a.push(ts.objectAtIndex(i).js);
a.join(",")`);

describe.skipIf(!IS_MAC)("clipboardImageBytes (macOS, real pasteboard)", () => {
  const dir = mkdtempSync(join(tmpdir(), "apiplan-clip-test-"));
  const snap = join(dir, "snapshot.json");
  const png = join(dir, "gen.png"), tiff = join(dir, "gen.tiff");
  let before = "";

  beforeAll(() => {
    before = clipboardTypes();
    snapshotClipboard(snap);
    // Generate a real 3x2 image with AppKit, save as PNG; sips converts to TIFF.
    jxa(`ObjC.import('AppKit');
var rep = $.NSBitmapImageRep.alloc.initWithBitmapDataPlanesPixelsWidePixelsHighBitsPerSampleSamplesPerPixelHasAlphaIsPlanarColorSpaceNameBytesPerRowBitsPerPixel(null, 3, 2, 8, 4, true, false, $.NSDeviceRGBColorSpace, 0, 0);
rep.setColorAtXY($.NSColor.redColor, 0, 0);
rep.setColorAtXY($.NSColor.blueColor, 2, 1);
rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $()).writeToFileAtomically("${png}", true);
''`);
    expect(Bun.spawnSync(["sips", "-s", "format", "tiff", png, "--out", tiff], { stdout: "ignore", stderr: "ignore" }).exitCode).toBe(0);
  });
  afterAll(() => {
    try { restoreClipboard(snap); } finally {
      const after = clipboardTypes();
      rmSync(dir, { recursive: true, force: true });
      if (after !== before) throw new Error(`clipboard NOT restored: before=[${before}] after=[${after}]`);
    }
  });

  test("PNG on the clipboard comes back as the same PNG (no pngpaste needed)", () => {
    expect(setClipboardImage(png, "public.png")).toBe("true");
    const b = clipboardImageBytes();
    expect(isPng(b)).toBe(true);
    if (!havePngpaste) expect(Buffer.from(b!).equals(readFileSync(png))).toBe(true); // AppleScript leg is byte-exact
  });

  test("TIFF-only clipboard (Preview/Safari copy) comes back as PNG", () => {
    expect(setClipboardImage(tiff, "public.tiff")).toBe("true");
    expect(clipboardTypes()).not.toContain("public.png");
    const b = clipboardImageBytes();
    expect(isPng(b)).toBe(true);
    // decode it back: must still be 3x2
    const out = join(dir, "back.png"); writeFileSync(out, b!);
    const dims = Bun.spawnSync(["sips", "-g", "pixelWidth", "-g", "pixelHeight", out], { stdout: "pipe" }).stdout.toString();
    expect(dims).toMatch(/pixelWidth: 3/); expect(dims).toMatch(/pixelHeight: 2/);
  });

  test("text-only clipboard yields null, not a stale file", () => {
    expect(setClipboardText("apiplan clipboard test")).toBe("true");
    expect(clipboardImageBytes()).toBeNull();
  });

  test("scripts escape quotes in the output path", () => {
    const [as, js] = macClipboardScripts('/tmp/a"b.png');
    expect(as.join(" ")).toContain('POSIX file "/tmp/a\\"b.png"');
    expect(js.join(" ")).toContain('"/tmp/a\\"b.png"');
  });
});
